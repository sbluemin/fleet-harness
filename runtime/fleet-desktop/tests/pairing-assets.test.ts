import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pairingHtml = fs.readFileSync(path.join(desktopRoot, "assets", "pairing", "index.html"), "utf8");

describe("Desktop pairing assets", () => {
  it("keeps the local form script-free with only the private navigation targets", () => {
    expect(pairingHtml).toContain("default-src 'none'; style-src 'self'; script-src 'none'; connect-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action fleet-desktop-pairing:");
    expect(pairingHtml).toContain('action="fleet-desktop-pairing://submit/"');
    expect(pairingHtml).toContain('href="fleet-desktop-pairing://cancel/"');
    expect(pairingHtml).toContain('id="mode-loopback"');
    expect(pairingHtml).toContain('id="mode-link"');
    expect(pairingHtml).toContain('value="loopback"');
    expect(pairingHtml).toContain('value="link"');
    expect(pairingHtml).not.toMatch(/\bssh\b/i);
    expect(pairingHtml).not.toMatch(/<(script|iframe|webview)\b|\bon\w+\s*=/i);
  });
});
