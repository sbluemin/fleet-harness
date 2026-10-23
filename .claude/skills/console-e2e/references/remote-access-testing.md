# Remote access and pairing E2E

Remote access is the one Console surface the browser cannot reach on its own. The remote listener speaks TLS with a self-signed certificate, refuses every request without a session, and hands out `fleet://join?code=…` links that no browser follows. So the pairing checks below keep the browser on the **owner's side** — Settings, the control curtain, the standing bar — while the **guest device is simulated from Node** over real HTTPS. Standing away from home is the exception: the browser loads the remote origin itself, in [Standing away from home](#standing-away-from-home).

Read the base workflow first. This file covers only what it does not describe.

## The shape of a run

One isolated Console plays the host. A short Node script plays every remote device. The browser watches the host's screen.

```
node script  --https-->  remote listener (LAN addr : remote port)  <- the "other device"
browser      --http-->   loopback listener (127.0.0.1 : port)      <- the owner's screen
```

Both listeners come from the one isolated server the base workflow already starts; nothing extra is launched. The remote listener has its own port (`remoteAccess.listenPort`), separate from the loopback Console port. Take the remote origin from `/api/v1/access-links`, never from the loopback port.

## Turn the listener on

The listener binds a real address of this machine (`remoteAccess.listenAddress`); loopback names are rejected on purpose.

```bash
BIND=$(ipconfig getifaddr "$(route -n get default | awk '/interface:/{print $2}')")   # macOS, default-route interface; on Linux read the LAN address of the active interface
[ -n "$BIND" ] || { echo "no LAN address: stop"; exit 1; }   # an empty listenAddress is refused with 400 invalid_remote_access
```

Enable it through the settings API with an `Origin` header, then read `/api/v1/access-links` back. That route reports the **live** listener, not the setting, so it is the only honest answer to "is remote access actually on". The write takes the whole `remoteAccess` object, so start from the current value: the server rejects the retired `bindHost` field, and a public endpoint (`publicEndpointEnabled: true`) also needs a matching `acknowledgment`, which this LAN-only run leaves off.

```js
const current = (await (await fetch(`${origin}/api/v1/settings/global`)).json()).remoteAccess;
await fetch(`${origin}/api/v1/settings/global`, {
  method: "PUT",
  headers: { "Content-Type": "application/json", Origin: origin },
  body: JSON.stringify({ remoteAccess: { ...current, enabled: true, publicEndpointEnabled: false, listenAddress: BIND, acknowledgment: null } }),
});
const status = await (await fetch(`${origin}/api/v1/access-links`)).json();
// status.listener.listening === true; status.listener.origin === `https://${BIND}:<remote port>`
// (the body is { listener: { listening, origin, lastError }, interfaces, links, devices, … })
const remotePort = Number(new URL(status.listener.origin).port || 443); // URL drops the default HTTPS port
```

Recheck the input contract in `runtime/fleet-console/features/settings/host/settings-domain.ts` (`isValidRemoteAccessInput`) when the request is refused; a `400 invalid_remote_access` is a fixture error, not a product result.

`listener.listening: false` with a `listener.lastError` means the bind failed; the console stays up and the UI must say so. Never read the setting and call it proof.

## Issue a link and decode it

Link creation needs the lock token. The link is an encoded envelope, not a URL to fetch — decode it to get the grant token:

```js
const issued = await (await fetch(`${origin}/api/v1/access-links?access=full`, {
  method: "POST", headers: { Authorization: `Bearer ${token}` },
})).json();
const code = new URL(issued.link).searchParams.get("code");
const envelope = JSON.parse(Buffer.from(code, "base64url").toString("utf8"));
// { v, endpoint, token, fingerprint, label }
```

Use `access=monitoring` for a read-only guest. Never print the lock token or the grant.

## Speak to the remote listener

`fetch` will not do: the certificate is self-signed and the `Host` header must match the listener. Use `node:https` with the check disabled and the header set by hand. This is the pin's job in production, and the test stands in for it.

```js
https.request({
  host: BIND, port: remotePort, path: "/api/v1/join", method: "POST",
  rejectUnauthorized: false, checkServerIdentity: () => undefined,
  headers: { host: `${BIND}:${remotePort}`, "content-type": "application/json", cookie },
});
```

**Host casing matters.** curl preserves what you write; browsers lowercase it. A hostname bind that passes with a capitalized `Host` can still 403 every real request — verify header contracts at real-client fidelity.

## Pairing versus session — the distinction under test

A join answers with **two** cookies and they mean different things:

| Cookie | Lives | Ends when |
|---|---|---|
| `fleet_console_session_<port>` | the current connection | control reclaimed, idle timeout, console restart |
| `fleet_console_pairing_<port>` | until revoked | the device is removed, or the identity is rotated |

Grab both. Taking only `set-cookie[0]` gets the session and makes the resume path untestable:

```js
const jar = res.headers["set-cookie"].map((c) => c.split(";")[0]).join("; ");
const pairingOnly = jar.split("; ").filter((c) => c.startsWith("fleet_console_pairing_")).join("; ");
```

The contract worth pinning, in this order:

1. `POST /api/v1/join {token, device}` -> `204`, both cookies set. The device now appears in Settings.
2. Ordinary request with the pairing cookie **alone** -> `401`. A pairing is permission to reopen a session, not a session.
3. `DELETE /api/v1/access-sessions/:handle` (from loopback) -> `204`. The row survives; only the connection ended.
4. `POST /api/v1/join {}` with the pairing cookie -> `204`. **No link, no token.** This is the return path.
5. `DELETE /api/v1/paired-devices/:id` -> `204`. Now the same resume answers `401` and clears the cookie with `Max-Age=0`.

Step 4 is the fragile one: if the session is treated as the credential, every way it ends also destroys the device's way back, and the link has already burned.

## What the owner's screen must show

The browser side is where the guest becomes visible. Settings -> Remote access -> "Links and devices" holds one table mixing paired devices and unused links.

```js
[...document.querySelectorAll('.remote-table tbody tr')].map((tr) => ({
  cells: [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()),
  buttons: [...tr.querySelectorAll('button')].map((b) => b.textContent.trim()),
}))
```

A connected device reads `Connected now` and carries **two** buttons — disconnect (reversible) and remove (permanent). After a disconnect the row stays, its time cell becomes relative, and only remove is left. A row that vanishes on disconnect is a regression.

Check `remote/paired-devices.json` under the isolated `FLEET_CONSOLE_DATA_DIR` too: it must contain the device but never the cookie secret.

## The curtain will block your clicks

A full remote session takes control, so the owner's screen raises the control curtain and the standing bar. That is correct behavior, and it will swallow clicks on anything behind it.

Follow the shared [Pointer target preflight](verification.md#pointer-target-preflight) before owner-side pointer input rather than concluding a covered button is broken. A hit on `control-curtain-scrim` means a remote device holds control (expected); `commissioning-card` indicates onboarding covered by [Fresh-window chrome preflight](verification.md#fresh-window-chrome-preflight).

Dismiss the curtain with "Keep watching" to reach the standing bar; dismiss again if reload raises it, then repeat the shared preflight before continuing.

## Restarting and rotating

- Toggling remote access off and on **keeps** pairings. Sessions and unused links die with the listener; the devices come back with the same cookie.
- `POST /api/v1/remote-identity/rotations` unpairs everyone by design — the fingerprint those devices trusted is gone, so a pairing that could never connect again would be a lie in the list. Expect `devices: []` afterwards and a new fingerprint on the wire. Read `/api/v1/access-links` again afterwards instead of assuming the remote origin or port survived.

**A toggle is not a restart, and the difference is the whole bug class.** The console port is dynamic by default, so a real process restart hands the loopback listener a new port while a toggle freezes it. Anything keyed to the port — the origin a peer console saved, the `fleet_console_pairing_<port>` cookie name — passes a toggle and fails a restart. Stop the process and start it again on the same `FLEET_CONSOLE_DATA_DIR`:

```js
// the loopback port MUST differ across the two boots, or the run proves nothing
const before = (await status()).origin;   // https://<bind>:<published>
// … kill, relaunch, read the new lock …
const after = (await status()).origin;    // must still be `before`
```

The remote listener keeps its own remembered port (`remoteAccess.listenPort`, persisted in `remote/listener.json`) rather than following the console port, so `origin` survives while the loopback port moves. A resume against the **old saved origin** with the pairing cookie alone must answer `204`; `ECONNREFUSED` means the listener followed the console port again, and `401` means the cookie name did.

Confirm the wire, not the state: read the certificate the listener actually presents and compare it to the reported fingerprint. A rotation that changes state while the listener keeps the old key breaks every pin.


## Standing away from home

Away is which origin this window is standing on. It is not the public endpoint (`publicEndpointEnabled` does not enter the predicate; [Turn the listener on](#turn-the-listener-on) leaves it off) and it is not a second loopback Console. The host chip and the dock dot share `isStandingAtHome` in `runtime/fleet-console/core/client/src/chrome/components/command-band-system-cluster.tsx`:

- With no Desktop shell, home is a loopback `http` origin (`127.0.0.1`, `localhost`, or `[::1]`). The remote listener's `https://<LAN>:<remotePort>` is away. Another isolated Console at `http://127.0.0.1:<other port>` is still home.
- With a Desktop shell, home is `location.origin` equal to the shell's published `homeOrigin` (`GET /api/v1/desktop/shell`). Until that answer arrives the shell is pending and the window is not treated as home. A neighbor Console is away once the window origin differs, even when that neighbor is also loopback.

On `/objectives`, while the connection is live:

| Where | `.conversation-dock-status` | `.host-switcher-chip` |
|---|---|---|
| Home, no guest holding control | absent | present, class `command-band-button host-switcher-chip`, `data-tip` `Local` |
| Away, this browser on the remote listener | present, `data-connection="live"` | absent |
| Owner loopback while a full guest holds control | absent | present with `is-shared`, not `is-away` |
| Desktop window on its home Console | absent | present, no `is-away`, `data-tip` `Local` |
| Desktop window on the neighbor Console | present, `data-connection="live"` | present with `is-away`; `data-tip` is the host name, not `Local` |
| Desktop window back on its home Console | absent | no `is-away`, `data-tip` `Local` |

`data-connection="offline"` is the coral disconnect dot. It is not away. A throwaway Theater is not required for either element: with no Theater the sidebar is the starter (`[data-testid=side-bar-starter]`) and the dock still renders. The chip is omitted on a non-loopback page because the nearby scan and the saved-host list run only for a loopback origin, and without a shell home nothing keeps the chip as the way back. Registering a Theater does not put the chip back. The chip is in the DOM on the home page even while its menu is `hidden`, so a document-wide query is the check; opening the avatar is not.

**A synthesized shell URL is not away.** `desktopPickerUrl` (`/console/?desktop-surface=host-picker`, including `place=side`) only asks the shell to draw the host picker over the home page. The window origin stays home, so the dot stays absent and the chip does not gain `is-away`. That places the overlay. It does not show the window standing on another console.

### Browser: load the remote listener

Seed onboarding before the first navigation ([First-load onboarding state](setup.md#first-load-onboarding-state)), or the commissioning card covers the dock in a screenshot. Turn the listener on with [`issue-access-link.mjs`](../scripts/issue-access-link.mjs) as in [Turn the listener on](#turn-the-listener-on). Its stdout line `link written to <path> (listener <origin>)` is the origin to open. Do not print `link.txt`.

Join from one Node process, as in [Speak to the remote listener](#speak-to-the-remote-listener). Have that process write a mode-0600 JSON array of `{name,value}` for the `Set-Cookie` pairs, and print the status and the cookie names only (`fleet_console_session_<remotePort>` and `fleet_console_pairing_<remotePort>`). A `204` is the join. Never pass the cookie value or the lock token on a command line.

```bash
agent-browser --session <id> --headed false --ignore-https-errors open
agent-browser --session <id> cookies set --curl "$E2E_DIR/away-cookies.json" --url "<listener origin>"
agent-browser --session <id> open "<listener origin>/console/objectives"
```

`--ignore-https-errors` is required: the listener certificate is self-signed, and a normal navigation stops on it. `--headed false` keeps the window from taking OS focus. Wait until the page has connected, then read:

```js
({
  origin: location.origin,
  dot: document.querySelector(".conversation-dock-status")?.getAttribute("data-connection") ?? null,
  chip: document.querySelector(".host-switcher-chip")?.className ?? null,
})
```

Away is reproduced when `origin` is the listener origin, `dot` is `"live"`, and `chip` is `null`. Then `DELETE /api/v1/access-sessions/:handle` from the owner side (the lock token stays inside the Node process). The handle is `devices[].sessionHandle` on `GET /api/v1/access-links` for the owner origin, the same body as [Turn the listener on](#turn-the-listener-on); it is null when that device is not connected. After the delete, read the same Console's loopback `/console/objectives` in another browser session: `dot` is `null`, and the chip's class has neither `is-away` nor `is-shared`, with `data-tip` `Local`. While the full guest still holds control, the owner's chip is `is-shared` and is not a home reading.

Delete the cookie file with the run directory. It holds the session secret.

### Desktop shell

The browser result above does not need Desktop. Launching Desktop takes OS focus; do not launch it for the browser check. A raw navigation to the neighbor does not switch the window: `will-navigate` in `runtime/fleet-desktop/src/window-policy.ts` blocks a URL outside the active Console and the pending one. The shell's host switch (`runtime/fleet-desktop/src/remote-bridge.ts`) is what changes the window origin. The menu below is that switch.

`listLocalConsoles` (`runtime/fleet-console/core/host/bootstrap/local-consoles.ts`, `canonicalLockFiles`) lists two locks only: the stable slot and `<packageRoot>/../../.fleet/console`, where `packageRoot` is the running checkout's `runtime/fleet-console`. A Console whose `FLEET_CONSOLE_DATA_DIR` is an e2e run directory is absent from that list on purpose. The neighbor has to be the local slot of **this** worktree, or the menu has no row for it.

That slot is one directory per checkout. It is not `~/.fleet` and it is not another worktree's `.fleet/console`, so this worktree's slot does not collide with the user's Console or with a neighbor in a different checkout. It does collide with another session that already serves this same worktree's local slot. Before starting, the wrapper's `--check` must pass. If it reports a live pid this run did not start, choose nothing: do not stop that Console and do not delete the directory.

The wrapper's `--canonical-console-dir` sets only `FLEET_CONSOLE_DATA_DIR` to that slot. `HOME` and the other Fleet paths stay under the neighbor's own run directory. `--set` cannot name `FLEET_CONSOLE_DATA_DIR`. Hand-rolling `env -i` is not the route.

```bash
SLOT="<worktree>/.fleet/console"          # this worktree only
NB_DIR="<repo-root>/.fleet/e2e-<role>-nb" # a second run directory, not the home Console's
node <worktree>/.claude/skills/console-e2e/scripts/isolated-env.mjs \
  --run-dir "$NB_DIR" --canonical-console-dir "$SLOT" --check
node <worktree>/.claude/skills/console-e2e/scripts/isolated-env.mjs \
  --run-dir "$NB_DIR" --canonical-console-dir "$SLOT" \
  -- node <worktree>/runtime/fleet-console/dist/cli.mjs serve
```

Record the neighbor pid from the [fixed lock read](setup.md#read-the-lock-without-the-token) of `$SLOT/console.lock`. Seed that Console before anything opens it, or its page is the commissioning card. Pass the slot as `--console-dir` and the same `--canonical-console-dir`:

```bash
node <worktree>/.claude/skills/console-e2e/scripts/isolated-env.mjs \
  --run-dir "$NB_DIR" --canonical-console-dir "$SLOT" --bin pnpm \
  -- pnpm --dir <worktree>/runtime/fleet-console exec tsx \
  <worktree>/.claude/skills/console-e2e/scripts/seed-onboarding.mts --console-dir "$SLOT"
```

The home Console is a normal isolated `serve` ([Isolate the Console](setup.md#isolate-the-console)), also seeded. Confirm from the **home** origin, printing ports only:

```js
const { consoles } = await (await fetch(`${homeOrigin}/api/v1/local-consoles`)).json();
consoles.map((entry) => new URL(entry.origin).port);
```

The neighbor's port is in that list. The home run's own port is not, because its data dir is not a canonical lock. The user's own Console is often in the list too, commonly `127.0.0.1:50000`, with status "discovered" / "발견됨". Do not select, probe, or stop any row whose port this run did not record.

After that check, stop the home `serve` with `cli.mjs stop` through the same wrapper and `--run-dir`, and without `--canonical-console-dir`. The seeded settings stay in the directory; Desktop then uses it. A gate dry-run that exits 20 with `Console lock: live` means this stop was skipped. Do not launch until that lock is not live.

Launch Desktop once, under its own authorization, as in [Desktop setup](desktop/setup.md#preflight-and-ownership). `FLEET_CONSOLE_DATA_DIR` for that launch is the **home** run's `console` directory, not `$SLOT`. The shell's `homeOrigin` is that home.

In the window, open the dock avatar (accessible name starts with "Hosts" / "호스트"). Activate the host item whose name ends with `Local` ("Hosts: Local" / "호스트: Local"). Then activate the radio whose detail line is `127.0.0.1:<neighbor port>`. Its status reads "discovered" / "발견됨" and its name is "Fleet Console" unless that row is already current. Matching the port is the check. A row for any other port, including the user's Console, is not the neighbor.

Do not assign `location` to the neighbor. The menu selection is the navigation the bridge takes. When the window has switched, read:

```js
({
  origin: location.origin,
  home: (await (await fetch("/api/v1/desktop/shell")).json()).homeOrigin,
  dot: document.querySelector(".conversation-dock-status")?.getAttribute("data-connection") ?? null,
  chip: document.querySelector(".host-switcher-chip")?.className ?? null,
  tip: document.querySelector(".host-switcher-chip")?.getAttribute("data-tip") ?? null,
})
```

Away on Desktop: `origin` is `http://127.0.0.1:<neighbor port>`, `home` is the home origin, `dot` is `"live"`, `chip` contains `is-away`, and `tip` is the host name rather than `Local`.

Return by the same menu, opened again from the avatar and then the item that ends with `Local`. Activate the radio whose detail line is `127.0.0.1:<home port>`. Its name is "Managed console" / "관리형 콘솔". After it, `origin` is the home origin, `dot` is `null`, `chip` has no `is-away`, and `tip` is `Local`.

Stop the neighbor with the same wrapper flags. That `stop` runs only when `$SLOT/console.lock`'s pid equals `<run-dir>/canonical-console.pid`, which the wrapper writes when this run's `serve` starts. No record, a different pid, or the main checkout (`mainCheckoutOf`, the same test as [the Desktop preflight](desktop/setup.md#read-only-preflight)) is refused before the command starts. Then:

```bash
node <worktree>/.claude/skills/console-e2e/scripts/isolated-env.mjs \
  --run-dir "$NB_DIR" --canonical-console-dir "$SLOT" \
  -- node <worktree>/runtime/fleet-console/dist/cli.mjs stop
```

Remove `$SLOT` only when this run created it and the lock is gone. If the directory existed before the run, delete only what this run added and say what you left. Leaving another session's slot, or a live lock, in place is the stop condition. The home Console stops through its own run directory, with no `--canonical-console-dir`.

The browser half of this section was run against an isolated listener. The menu values above (neighbor `is-away`, `data-tip` the host name, home `Local` with no dot) are the Desktop measurement's. `--canonical-console-dir` listing and its own `stop` were checked on a worktree slot. The main-checkout refusal and a `stop` with no pid record were checked with `--check` and did not start a Console. Desktop was not launched for those checks.

## Administration stays on loopback

Every Access route is owner-side. From the remote listener, with a valid full session, these must all answer `401`: reading `/api/v1/access-links`, creating one, revoking a link, revoking a session, removing a paired device, rotating the identity. That list carries the fingerprint, other devices' names, and every address this machine has — it is not a guest's to read, and `Origin` alone does not gate it, because a remote browser sends the remote origin.
