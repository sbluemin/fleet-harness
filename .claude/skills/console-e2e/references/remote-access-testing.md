# Remote access and pairing E2E

Remote access is the one Console surface the browser cannot reach on its own. The remote listener speaks TLS with a self-signed certificate, refuses every request without a session, and hands out `fleet://join?code=…` links that no browser follows. So the browser drives only the **owner's side** — Settings, the control curtain, the standing bar — while the **guest device is simulated from Node** over real HTTPS.

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
BIND=$(ipconfig getifaddr en0)   # macOS; on Linux read the LAN address of the active interface
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
// status.listening === true; status.origin === `https://${BIND}:<remote port>`
const remotePort = Number(new URL(status.origin).port || 443); // URL drops the default HTTPS port
```

Recheck the input contract in `runtime/fleet-console/features/settings/host/settings-domain.ts` (`isValidRemoteAccessInput`) when the request is refused; a `400 invalid_remote_access` is a fixture error, not a product result.

`listening: false` with a `lastError` means the bind failed; the console stays up and the UI must say so. Never read the setting and call it proof.

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

Follow the shared [Pointer target preflight](verification.md#pointer-target-preflight) before owner-side pointer input rather than concluding a covered button is broken. A hit on `control-curtain-scrim` means a remote device holds control (expected); `commissioning-card` or `whatsnew-overlay` indicates onboarding covered by [Fresh-window chrome preflight](verification.md#fresh-window-chrome-preflight).

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

## Administration stays on loopback

Every Access route is owner-side. From the remote listener, with a valid full session, these must all answer `401`: reading `/api/v1/access-links`, creating one, revoking a link, revoking a session, removing a paired device, rotating the identity. That list carries the fingerprint, other devices' names, and every address this machine has — it is not a guest's to read, and `Origin` alone does not gate it, because a remote browser sends the remote origin.
