#!/usr/bin/env node
/**
 * Claude sign-in page fixture: answers the Console client's Claude CLI-status and sign-in requests locally, in the page,
 * so a client or a page can be shown "CLI missing", "signed out", and a synthetic sign-in success or failure without a
 * real account, CLI, Keychain, browser launch or external request on those routes. One implementation, two consumers:
 *
 *   1. Node: `import { createClaudeAuthFixture } from ".../claude-auth-fixture.mjs"`; hand it a nativeFetch and call
 *      `fixture.install(globalThis)` (or use `fixture.fetch` directly). Used by the real-client check,
 *      runtime/fleet-console/tests/claude-auth-client-fixture.test.ts.
 *   2. Page: `node claude-auth-fixture.mjs --state <state> --out <abs>/claude-auth-init.js` writes a pre-navigation
 *      init-script (the stringified `createClaudeAuthFixture` plus a few install lines, so the page runs the same code
 *      the test ran). Load it where references/agent-browser.md#mock-page-api-responses-before-navigation loads an
 *      init-script; it never has to be evaluated after load.
 *
 * States (--state): the scripted outcome, kept in page memory only (a reload or a new fixture starts over; two fixtures
 * never share state):
 *   missing     cli-status "missing"; `claude/start` is refused locally (502 login_start_failed). Never reaches a real CLI.
 *   signedout   cli-status "signedout"; start works; a valid paste is accepted and the sign-in stays pending.
 *   success     as signedout, but a valid paste turns the sign-in to signed_in and cli-status to "ready".
 *   fail        as signedout, but a valid paste turns the sign-in to failed; cli-status stays "signedout".
 *   Pending is the phase after start and before paste; cancel is the cancel route (status "cancelled", a later paste is
 *   refused with 409, no success follows).
 * Only the fixed synthetic code (`FIXTURE_CODE`) is accepted as a code; any other value, including a code-shaped one,
 * gets 400 invalid_code, so a real code cannot be pasted into this fixture by mistake. Codes, bodies and query strings
 * are never stored or logged: `window.__fleetE2EClaudeAuth` ({state, hits, opened}) holds only method, pathname,
 * outcome and status. The login page is the reserved `FIXTURE_LOGIN_URL` (a `.invalid` host: https for the client's
 * check, never resolvable). `window.open` is replaced by a recorder, so the URL is never opened.
 *
 * Protected scope (a request is never passed to nativeFetch, whatever the method, Request/URL/string input or case):
 *   /api/v1/quota[/...], /api/v1/ai-gateway/oauth[/...], /api/v1/ai-gateway/quota[/...], /api/v1/commodore/cli-status
 *   (also with encoded or doubled slashes, a trailing slash, or an absolute URL on another origin). Inside it only the
 *   routes the client really calls are answered, with the product's methods:
 *     POST /api/v1/commodore/cli-status    POST /api/v1/quota/connect   GET /api/v1/quota/summary
 *     POST /api/v1/quota/claude/start      GET  /api/v1/quota/claude/status?loginId=
 *     POST /api/v1/quota/claude/paste      POST /api/v1/quota/claude/cancel
 *   Everything else in the scope (other providers, logout, budgets, the direct Gateway routes, a wrong method, extra
 *   body fields or query keys) is refused locally with 4xx and recorded as "rejected". Requests outside the scope go to
 *   nativeFetch unchanged. `quota/summary` and `quota/connect` return a status skeleton only (no usage numbers; Quota
 *   numbers stay each objective's own mock).
 *
 * Verify without a browser or host:
 *   pnpm --filter @dotobokuri/fleet-console exec vitest run tests/claude-auth-client-fixture.test.ts
 *   (nativeFetch is a sentinel that fails when called; the real client functions run against this fixture.)
 * Generate and clean up:
 *   node .claude/skills/console-e2e/scripts/claude-auth-fixture.mjs --state success --out <abs-owned-run>/claude-auth-init.js
 *   rm <abs-owned-run>/claude-auth-init.js   (the file is the only thing the CLI writes; page state dies with the page)
 *
 * Limits, so none of this is claimed elsewhere:
 *   - It covers fetch only. XMLHttpRequest, sendBeacon, EventSource, WebSocket, a navigation, another tab and a request
 *     made by the host itself are not intercepted.
 *   - It does not start, isolate or block a Console host. A normal host boot already makes its own external calls (for
 *     example the all-provider Quota read at ai-gateway start-up and the post-sign-in refresh); the init-script alone does
 *     not make that safe. Pointing a browser at a booted host needs its own prior safety basis, outside this file.
 *   - A synthetic success is a client-contract result: not an account sign-in, not real CLI behavior, and not evidence
 *     about the host routes or adapter (those are covered by claude-auth-fixture.test.ts and claude-login.test.ts).
 *   - Other providers' sign-in, Desktop, and Quota usage numbers are out of scope.
 */
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The fixture. Self-contained on purpose (no outer references): the page script is this function's source text.
 * options: { state, origin, nativeFetch } -> { state, loginUrl, code, routes, hits, opened, fetch, open, install }.
 */
export function createClaudeAuthFixture(options) {
  const STATES = ["missing", "signedout", "success", "fail"];
  const LOGIN_URL = "https://auth-fixture.invalid/synthetic-login";
  const CODE = "synthetic-code#synthetic-state";
  const PROVIDERS = ["anthropic", "claude", "codex", "gemini", "muse-code", "opencode", "xai"];
  const state = options && options.state;
  if (!STATES.includes(state)) throw new Error("claude-auth-fixture: unknown state");
  const origin = String(options.origin);
  const nativeFetch = options.nativeFetch;
  if (typeof nativeFetch !== "function") throw new Error("claude-auth-fixture: nativeFetch is required");
  const ROUTES = [
    { method: "POST", path: "/api/v1/commodore/cli-status" },
    { method: "GET", path: "/api/v1/quota/summary" },
    { method: "POST", path: "/api/v1/quota/connect" },
    { method: "POST", path: "/api/v1/quota/claude/start" },
    { method: "GET", path: "/api/v1/quota/claude/status" },
    { method: "POST", path: "/api/v1/quota/claude/paste" },
    { method: "POST", path: "/api/v1/quota/claude/cancel" },
  ];
  const hits = [];
  const opened = [];
  let connected = false;
  let signedIn = false;
  let sequence = 0;
  let login = null; // { id, status }

  const protectedPath = (path) => /^\/api\/v1\/(quota|ai-gateway\/(oauth|quota)|commodore\/cli-status)(\/|$)/.test(path);
  const normalize = (path) => {
    let decoded = path;
    try { decoded = decodeURIComponent(path); } catch { /* keep the raw path: still matched below */ }
    return decoded.toLowerCase().replace(/\/{2,}/g, "/");
  };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const skeleton = () => ({
    providers: Object.fromEntries(PROVIDERS.map((id) => [id, { status: id === "claude" && connected ? "signed_out" : "not_connected" }])),
  });
  const parseBody = (text) => {
    try {
      const value = JSON.parse(text);
      return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch { return null; }
  };
  const exactKeys = (body, keys) => {
    const present = Object.keys(body);
    return present.length === keys.length && keys.every((key) => present.includes(key));
  };
  const idOk = (value) => typeof value === "string" && value.length > 0 && value.length <= 128;

  async function answer(method, path, url, bodyText) {
    const route = ROUTES.find((entry) => entry.path === path);
    if (!route) return { status: 404, body: { error: "fixture_blocked" }, rejected: true };
    if (route.method !== method) return { status: 405, body: { error: "fixture_method_not_allowed" }, rejected: true };
    const keys = [...url.searchParams.keys()];
    const body = method === "POST" ? parseBody(bodyText) : null;
    if (path === "/api/v1/commodore/cli-status") {
      if (!body || typeof body.commodoreId !== "string" || keys.length > 0
        || Object.keys(body).some((key) => key !== "commodoreId" && key !== "language")) return { status: 400, body: { error: "invalid_request" }, rejected: true };
      return { status: 200, body: { status: state === "missing" ? "missing" : signedIn ? "ready" : "signedout" } };
    }
    if (path === "/api/v1/quota/summary") {
      if (keys.some((key) => key !== "stale" && key !== "force")) return { status: 400, body: { error: "invalid_request" }, rejected: true };
      return { status: 200, body: skeleton() };
    }
    if (path === "/api/v1/quota/connect") {
      if (!body || !exactKeys(body, ["provider", "connected"]) || body.provider !== "claude" || typeof body.connected !== "boolean" || keys.length > 0) {
        return { status: 400, body: { error: "invalid_connect_request" }, rejected: true };
      }
      connected = body.connected;
      return { status: 200, body: skeleton() };
    }
    if (path === "/api/v1/quota/claude/start") {
      if (!body || Object.keys(body).length !== 0 || keys.length > 0) return { status: 400, body: { error: "invalid_login_request" }, rejected: true };
      // A missing CLI never starts a sign-in: the real host would fall back to a bundled CLI here, this fixture never does.
      if (state === "missing") return { status: 502, body: { error: "login_start_failed" } };
      if (!login || login.status.state !== "pending") {
        sequence += 1;
        login = { id: `fixture-login-${sequence}`, status: { state: "pending" } };
      }
      return { status: 200, body: { loginId: login.id, userCode: "", verificationUri: LOGIN_URL, expiresAt: Date.now() + 10 * 60_000, interval: 1 } };
    }
    if (path === "/api/v1/quota/claude/status") {
      const id = url.searchParams.get("loginId");
      if (keys.length !== 1 || keys[0] !== "loginId" || !idOk(id)) return { status: 400, body: { error: "invalid_login_id" }, rejected: true };
      if (!login || login.id !== id) return { status: 404, body: { error: "login_not_found" } };
      return { status: 200, body: login.status };
    }
    if (path === "/api/v1/quota/claude/paste") {
      if (!body || !exactKeys(body, ["loginId", "code"]) || !idOk(body.loginId) || typeof body.code !== "string" || keys.length > 0) {
        return { status: 400, body: { error: "invalid_login_request" }, rejected: true };
      }
      if (!login || login.id !== body.loginId) return { status: 404, body: { error: "login_not_found" } };
      if (login.status.state !== "pending") return { status: 409, body: { error: "not_pending" } };
      if (body.code !== CODE) return { status: 400, body: { error: "invalid_code" } };
      if (state === "success") { login.status = { state: "signed_in" }; signedIn = true; }
      else if (state === "fail") login.status = { state: "failed", message: "Sign-in failed. Please try again." };
      return { status: 200, body: { accepted: true } };
    }
    // /api/v1/quota/claude/cancel
    if (!body || !exactKeys(body, ["loginId"]) || !idOk(body.loginId) || keys.length > 0) return { status: 400, body: { error: "invalid_login_id" }, rejected: true };
    if (!login || login.id !== body.loginId) return { status: 404, body: { error: "login_not_found" } };
    if (login.status.state === "pending") login.status = { state: "cancelled" };
    return { status: 200, body: login.status };
  }

  async function fixtureFetch(input, init) {
    const request = typeof Request !== "undefined" && input instanceof Request ? input : null;
    let url;
    try {
      url = new URL(request ? request.url : input instanceof URL ? input.href : String(input), origin);
    } catch {
      return nativeFetch(input, init);
    }
    const path = url.pathname;
    if (!protectedPath(normalize(path))) return nativeFetch(input, init);
    const method = String((init && init.method) || (request && request.method) || "GET").toUpperCase();
    const record = (outcome, status) => { hits.push({ method, path, outcome, status }); };
    // Anything but the exact same-origin, literal route is refused: another origin, odd slashes/encoding/case, a trailing slash.
    if (url.origin !== origin || normalize(path) !== path || path !== path.replace(/\/$/, "")) {
      record("rejected", 403);
      return json(403, { error: "fixture_blocked" });
    }
    let bodyText = "";
    if (method === "POST") {
      try {
        if (init && init.body !== undefined && init.body !== null) bodyText = typeof init.body === "string" ? init.body : "\u0000";
        else if (request) bodyText = await request.clone().text();
      } catch { bodyText = "\u0000"; }
    }
    const result = await answer(method, path, url, bodyText);
    record(result.rejected ? "rejected" : "synthetic", result.status);
    return json(result.status, result.body);
  }

  const open = (target) => { opened.push(target === LOGIN_URL ? LOGIN_URL : "blocked"); return null; };
  const observe = { state, hits, opened };
  return {
    state,
    loginUrl: LOGIN_URL,
    code: CODE,
    routes: ROUTES,
    hits,
    opened,
    fetch: fixtureFetch,
    open,
    /** Replace fetch and window.open on `target` and expose `__fleetE2EClaudeAuth` (method/path/outcome/status only). */
    install(target) {
      target.fetch = fixtureFetch;
      target.open = open;
      target.__fleetE2EClaudeAuth = observe;
    },
  };
}

export const FIXTURE_STATES = ["missing", "signedout", "success", "fail"];
export const FIXTURE_LOGIN_URL = createClaudeAuthFixture({ state: "signedout", origin: "http://localhost", nativeFetch: () => undefined }).loginUrl;
export const FIXTURE_CODE = createClaudeAuthFixture({ state: "signedout", origin: "http://localhost", nativeFetch: () => undefined }).code;

/** The pre-navigation init-script text: the fixture's own source plus install lines. Nothing else is embedded. */
export function buildInitScript(state) {
  if (!FIXTURE_STATES.includes(state)) throw new Error("claude-auth-fixture: unknown state");
  return [
    "// Synthetic Claude sign-in fixture (console-e2e). Answers Claude CLI-status and sign-in requests locally; no real account, CLI,",
    "// Keychain, browser or network. It does not start, isolate or block a Console host and covers fetch only. Not evidence of real sign-in.",
    "(() => {",
    '  "use strict";',
    `  const createClaudeAuthFixture = ${createClaudeAuthFixture.toString()};`,
    `  createClaudeAuthFixture({ state: ${JSON.stringify(state)}, origin: location.origin, nativeFetch: window.fetch.bind(window) }).install(window);`,
    "})();",
    "",
  ].join("\n");
}

const PROTECTED_HOME_ENTRIES = [".claude", ".claude.json", ".fleet", ".config", ".ssh", ".gnupg", ".aws", ".codex", "Library"];

function realish(target) {
  const rest = [];
  let current = resolve(target);
  for (;;) {
    try {
      return join(realpathSync(current), ...rest.reverse());
    } catch {
      const up = dirname(current);
      if (up === current) return resolve(target);
      rest.push(basename(current));
      current = up;
    }
  }
}

function refuse(message) {
  process.stderr.write(`claude-auth-fixture: ${message}\n`);
  process.exit(2);
}

function main(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if ((key !== "--state" && key !== "--out") || argv[i + 1] === undefined) refuse("usage: --state missing|signedout|success|fail --out <absolute-path.js>");
    opts[key] = argv[i + 1];
  }
  const state = opts["--state"];
  const out = opts["--out"];
  if (!FIXTURE_STATES.includes(state)) refuse(`--state must be one of ${FIXTURE_STATES.join(", ")}`);
  if (!out || !isAbsolute(out) || !out.endsWith(".js")) refuse("--out must be an absolute .js path");
  const homes = new Set([homedir(), userInfo().homedir].flatMap((value) => [resolve(value), realish(value)]));
  for (const candidate of [resolve(out), realish(out)]) {
    for (const home of homes) {
      const rel = relative(home, candidate);
      const first = rel.split(sep)[0];
      if (!isAbsolute(rel) && (first.startsWith(".claude") || PROTECTED_HOME_ENTRIES.includes(first))) refuse("--out is inside a protected home directory");
    }
  }
  mkdirSync(dirname(out), { recursive: true });
  try {
    writeFileSync(out, buildInitScript(state), { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") refuse("--out must be a new file in an owned directory");
    throw error;
  }
  process.stdout.write(`claude-auth-fixture: wrote ${out} (state ${state}); fetch only, does not isolate a host\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
