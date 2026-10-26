"use strict";

/**
 * custodian.cjs — headless replacement for the Electron main process.
 *
 * Upstream's desktop app is two processes: the Next standalone server
 * (child) and an Electron main (parent) that owns ChatGPT/subscription
 * OAuth credentials and answers the child's lh:chatgpt / lh:subscriptions
 * IPC requests (status / models / lease). This script plays the parent on
 * a headless server, reusing upstream's own modules verbatim
 * (electron/chatgpt.cjs, chatgpt-ipc.cjs, subscriptions.cjs,
 * subscription-ipc.cjs — all plain Node, dependency-injected). Nothing
 * upstream is modified; this file is additive, so upstream pulls stay
 * conflict-free.
 *
 * Login on a headless box: upstream's OAuth uses a loopback redirect on a
 * random 127.0.0.1 port. The admin endpoint below starts the flow and
 * reports the auth URL plus the redirect port; complete it from a laptop
 * with `ssh -L <port>:127.0.0.1:<port> <vps>` and the URL in a local
 * browser. One-time — the refresh token persists in the data dir.
 *
 * Env:
 *   PORT            app port (required; dev-proxy/systemd provide it)
 *   LH_DATA_DIR     mutable data root   (default: <live repo>/data)
 *   LH_ADMIN_PORT   admin port, 127.0.0.1 only (default: PORT+1)
 */

const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const crypto = require("node:crypto");
const { fork } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const { createChatGPT, fileStore, publicError } = require(path.join(ROOT, "electron", "chatgpt.cjs"));
const { attachChatGPTChild, chatGPTControl } = require(path.join(ROOT, "electron", "chatgpt-ipc.cjs"));
const { createSubscriptions, loadSubscriptionSDK } = require(path.join(ROOT, "electron", "subscriptions.cjs"));
const { attachSubscriptionChild, subscriptionControl } = require(path.join(ROOT, "electron", "subscription-ipc.cjs"));

const PORT = Number(process.env.PORT);
if (!Number.isInteger(PORT) || PORT <= 0) { console.error("[custodian] PORT is required"); process.exit(1); }
const ADMIN_PORT = Number(process.env.LH_ADMIN_PORT || PORT + 1);
// Credentials + mutable data live OUTSIDE the worktree, in the live
// folder's data/, so previews and prod share one knowledge graph and one
// login, and promotes never touch them (data/ is upstream-gitignored).
const DATA_DIR = path.resolve(process.env.LH_DATA_DIR || path.join(process.env.HOME, "projects", "learnharness", "data"));
const SERVER_ENTRY = path.join(ROOT, ".next", "standalone", "server.js");

if (!fs.existsSync(SERVER_ENTRY)) { console.error(`[custodian] missing ${SERVER_ENTRY} — run: npm run build && node scripts/build-server.mjs`); process.exit(1); }
fs.mkdirSync(DATA_DIR, { recursive: true });

const log = (line) => console.log(`[custodian ${new Date().toISOString()}] ${line}`);

// ─── credential custodians (upstream modules, dependency-injected) ────────

// openExternal on a desktop opens the system browser; here we park the URL
// for the admin endpoint to hand out.
let authRequest = null; // { url, redirectPort, at }
const captureExternal = (target) => {
	let redirectPort = null;
	try { redirectPort = new URL(new URL(target).searchParams.get("redirect_uri")).port; } catch { /* leave null */ }
	authRequest = { url: target, redirectPort, at: Date.now() };
	log(`sign-in URL captured (loopback redirect port ${redirectPort ?? "unknown"})`);
};

let chatgptChild = null;
let subscriptionChild = null;

const chatgpt = createChatGPT({
	store: fileStore(path.join(DATA_DIR, "chatgpt-credentials.json")),
	openExternal: captureExternal,
	onChange: (value) => chatgptChild?.send(value),
	timeoutMs: 15 * 60 * 1000, // headless sign-in rides an SSH tunnel; allow setup time
});
const subscriptions = createSubscriptions({
	directory: DATA_DIR,
	loadSDK: () => loadSubscriptionSDK(path.dirname(SERVER_ENTRY)),
	openExternal: captureExternal,
	onChange: (snapshot) => subscriptionChild?.send(snapshot),
});

// ─── the Next standalone server, forked with the desktop markers ──────────

const desktopAPISecret = crypto.randomBytes(32).toString("hex");
let child = null;
let shuttingDown = false;

function startServer() {
	child = fork(SERVER_ENTRY, [], {
		cwd: path.dirname(SERVER_ENTRY),
		env: {
			...process.env,
			NODE_ENV: "production",
			PORT: String(PORT),
			HOSTNAME: "127.0.0.1",
			LH_DATA_DIR: DATA_DIR,
			LH_AUTH_FILE: path.join(DATA_DIR, "auth.json"),
			LH_DESKTOP_SERVER: "1",
			LH_DESKTOP_API_SECRET: desktopAPISecret,
		},
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	chatgptChild = attachChatGPTChild(child, chatgpt);
	subscriptionChild = attachSubscriptionChild(child, subscriptions);
	const fwd = (buf) => buf.toString().trimEnd().split("\n").forEach((l) => l && console.log(`[server] ${l}`));
	child.stdout.on("data", fwd);
	child.stderr.on("data", fwd);
	child.on("exit", (code, signal) => {
		chatgptChild?.dispose(); chatgptChild = null;
		subscriptionChild?.dispose(); subscriptionChild = null;
		if (shuttingDown) return;
		log(`server exited (code=${code} signal=${signal}) — restarting in 2s`);
		setTimeout(startServer, 2000);
	});
	log(`server forked (pid ${child.pid}, port ${PORT}, data ${DATA_DIR})`);
}

// ─── admin endpoint: 127.0.0.1 only, for the operator's shell ─────────────
//
//   GET  /status            chatgpt + native subscription status
//   POST /chatgpt {op,...}  login | cancel | select | disconnect | logout | consent
//                           (login responds as soon as the auth URL is
//                           captured; poll /status for the outcome)
//   POST /subscriptions {op,...}   native-subscription controls (pi SDK)

const readBody = (req) => new Promise((resolve) => {
	let raw = "";
	req.on("data", (c) => { raw += c; if (raw.length > 65536) req.destroy(); });
	req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
});
const respond = (res, code, value) => { res.writeHead(code, { "content-type": "application/json" }); res.end(`${JSON.stringify(value, null, 1)}\n`); };

const admin = http.createServer(async (req, res) => {
	try {
		if (req.method === "GET" && req.url === "/status") {
			return respond(res, 200, {
				chatgpt: await chatgpt.status(),
				subscriptions: await subscriptions.status(),
				pendingAuth: authRequest,
				server: child?.connected ? { pid: child.pid, port: PORT } : null,
			});
		}
		if (req.method === "POST" && req.url === "/chatgpt") {
			const command = await readBody(req);
			if (command.op === "login") {
				authRequest = null;
				const outcome = chatGPTControl(command, chatgpt); // resolves when the whole flow ends
				outcome.then((v) => log(`login flow finished: ${JSON.stringify(v && v.error ? v.error : "ok")}`));
				const until = Date.now() + 15000;
				while (!authRequest && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
				if (!authRequest) return respond(res, 504, { error: "no auth URL captured — check custodian logs" });
				return respond(res, 200, {
					authUrl: authRequest.url,
					redirectPort: authRequest.redirectPort,
					howTo: `from the laptop: ssh -N -L ${authRequest.redirectPort}:127.0.0.1:${authRequest.redirectPort} <this-vps>  — then open authUrl in the laptop browser`,
				});
			}
			return respond(res, 200, await chatGPTControl(command, chatgpt));
		}
		if (req.method === "POST" && req.url === "/subscriptions") {
			return respond(res, 200, await subscriptionControl(await readBody(req), subscriptions));
		}
		respond(res, 404, { error: "GET /status · POST /chatgpt · POST /subscriptions" });
	} catch (err) {
		respond(res, 500, { error: publicError(err) });
	}
});

// ─── boot ─────────────────────────────────────────────────────────────────

(async () => {
	await subscriptions.ready;
	admin.on("error", (err) => log(`admin endpoint unavailable (${err.code}) — app keeps running without it`));
	admin.listen(ADMIN_PORT, "127.0.0.1", () => log(`admin on 127.0.0.1:${ADMIN_PORT}`));
	startServer();
})();

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		shuttingDown = true;
		chatgpt.close();
		subscriptions.close?.();
		admin.close();
		if (child?.connected) child.kill("SIGTERM");
		setTimeout(() => process.exit(0), 1500).unref();
	});
}
