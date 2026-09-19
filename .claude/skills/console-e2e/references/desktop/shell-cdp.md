# Electron Shell and CDP verification

## Shell/CDP workflow

Replace `<cdp-port>` with one verified free loopback port. Choose one session literal, replacing `fleet-desktop-e2e-20260905-a7c3` consistently in every call. Redeclare `ab()` in each independent call that uses it. Launch the app as [Setup](setup.md) specifies, as a managed background process. Wait for a CDP page target — the port answers before a window exists — then connect:

```bash
ab --session fleet-desktop-e2e-20260905-a7c3 connect <cdp-port>
ab --session fleet-desktop-e2e-20260905-a7c3 tab
ab --session fleet-desktop-e2e-20260905-a7c3 get url
ab --session fleet-desktop-e2e-20260905-a7c3 snapshot -i
ab --session fleet-desktop-e2e-20260905-a7c3 errors
ab --session fleet-desktop-e2e-20260905-a7c3 console
```

Capture the entry state if timing allows, then wait for the exact loopback `/console/` handoff. Assert query and fragment are empty. The stable proof is the transition and final URL, not the literal entry duration.

Probe the renderer boundary:

```bash
cat <<'EOF' | ab --session fleet-desktop-e2e-20260905-a7c3 eval --stdin
(() => ({
  href: location.href,
  search: location.search,
  hash: location.hash,
  processType: typeof process,
  requireType: typeof require,
  electronInUA: /Electron\//.test(navigator.userAgent),
  viewport: [innerWidth, innerHeight],
  title: document.title,
}))()
EOF
```

Expect Electron UA, `process`/`require` unavailable, a loopback Console URL, and no query/fragment. Attempt same-origin Console navigation and one harmless disallowed navigation; verify the former stays inside `/console/` and the latter leaves the URL unchanged. Avoid `window.open` during automation because valid HTTPS popups intentionally hand off to the user's external browser.

Reload the renderer and repeat URL, sandbox, errors, console, and screenshot checks. Treat the Console DOM as supporting evidence for shell claims. For detailed SPA behavior in this Electron renderer, apply [Console verification](../verification.md) using the existing owned CDP session; do not switch to a standalone browser or use its cleanup helper on the Desktop session.
