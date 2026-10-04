#!/usr/bin/env node
/**
 * Turns remote access on for one OWNED isolated Console and writes a fresh access link to
 * `<e2e-dir>/link.txt` (mode 0600). Never prints the lock token or the link.
 *
 *   BIND=<LAN address> node issue-access-link.mjs <e2e-dir> [full|monitoring]
 *
 * `<e2e-dir>` is the directory whose `console/console.lock` the Console wrote. Links are single-use:
 * run it again for every launch attempt. Exit 0 = link written; 1 = refused or listener not up.
 */
import fs from "node:fs";
import path from "node:path";

const [e2eDir, access = "full"] = process.argv.slice(2);
const bind = process.env.BIND;
if (!e2eDir || !path.isAbsolute(e2eDir)) throw new Error("usage: BIND=<lan address> node issue-access-link.mjs <absolute e2e-dir> [full|monitoring]");
if (!bind) throw new Error("BIND must be this machine's LAN address (empty is refused with 400 invalid_remote_access)");
if (!["full", "monitoring"].includes(access)) throw new Error("access must be full or monitoring");

const lock = JSON.parse(fs.readFileSync(path.join(e2eDir, "console", "console.lock"), "utf8"));
const origin = `http://127.0.0.1:${lock.port}`;
const { remoteAccess: current } = await (await fetch(`${origin}/api/v1/settings/global`)).json();
const put = await fetch(`${origin}/api/v1/settings/global`, {
  method: "PUT",
  headers: { "Content-Type": "application/json", Origin: origin },
  body: JSON.stringify({ remoteAccess: { ...current, enabled: true, publicEndpointEnabled: false, listenAddress: bind, acknowledgment: null } }),
});
if (!put.ok) throw new Error(`settings PUT refused: ${put.status} ${(await put.text()).slice(0, 200)}`);
const { listener } = await (await fetch(`${origin}/api/v1/access-links`)).json();
if (!listener?.listening) throw new Error(`listener is not up: ${listener?.lastError ?? "no error reported"}`);
const issued = await fetch(`${origin}/api/v1/access-links?access=${access}`, { method: "POST", headers: { Authorization: `Bearer ${lock.token}` } });
if (!issued.ok) throw new Error(`link issue refused: ${issued.status}`);
fs.writeFileSync(path.join(e2eDir, "link.txt"), (await issued.json()).link, { mode: 0o600 });
console.log(`link written to ${path.join(e2eDir, "link.txt")} (listener ${listener.origin})`);
