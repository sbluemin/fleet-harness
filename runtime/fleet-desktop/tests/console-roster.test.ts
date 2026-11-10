import { EventEmitter } from "node:events";
import { CONSOLE_ROSTER_EVENT, CONSOLE_SECTION_EVENT, consoleSectionCommandUrl, type ConsoleSectionCommand } from "@fleet-console/protocol/desktop/console-section";
import { describe, expect, it, vi } from "vitest";
import { createConsoleSectionController } from "../src/console-section-controller.js";

const HOME = "http://127.0.0.1:4310";
const NEARBY = "http://127.0.0.1:4311";
const TRUSTED = "https://100.84.12.7:6768";
const UNTRUSTED = "https://100.84.12.8:6769";
const TOKEN = "grant-token-must-not-leak";

interface Delivery {
  readonly origin: string;
  readonly type: string;
  readonly detail: {
    readonly entries?: readonly { readonly id: string; readonly address: string; readonly active: boolean }[];
    readonly arrival?: { readonly commodore: string; readonly anchorY: number | null } | null;
  };
}

function delivered(script: string): Delivery | null {
  const head = "if(location.origin===";
  if (!script.startsWith(head)) return null;
  const origin = JSON.parse(script.slice(head.length, script.indexOf("&&"))) as string;
  const marker = "new CustomEvent(";
  const at = script.indexOf(marker);
  if (at < 0) return null;
  const rest = script.slice(at + marker.length);
  const type = JSON.parse(rest.slice(0, rest.indexOf(","))) as string;
  const detailStart = rest.indexOf("{detail:") + "{detail:".length;
  const detail = JSON.parse(rest.slice(detailStart, rest.lastIndexOf("})"))) as Delivery["detail"];
  return { origin, type, detail };
}

describe("console roster", () => {
  it("skips an untrusted roster without joining, delivers arrival only to the landed document, and keeps section order", async () => {
    const trace: string[] = [];
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let url = `${HOME}/console/`;
    const scripts: string[] = [];
    const contents = Object.assign(new EventEmitter(), {
      getURL: () => url,
      isDestroyed: () => false,
      executeJavaScript: async (script: string) => { scripts.push(script); },
    });
    const roster = { v: 1, commodores: [{ id: "cmdr-9", name: "Nuri", look: { base: 2, tone: null }, run: "quiet" }], more: 0 };
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      const parsed = new URL(input);
      calls.push({ url: input, init });
      trace.push(`fetch:${parsed.origin}${parsed.pathname}`);
      if (parsed.pathname === "/api/v1/remote-hosts") return Response.json({ hosts: [{ id: "rec-trusted", origin: TRUSTED, label: "Studio" }, { id: "rec-untrusted", origin: UNTRUSTED, label: "Old" }] });
      if (parsed.pathname === "/api/v1/local-consoles") return Response.json({ consoles: [{ origin: HOME, version: "1.2.3" }, { origin: NEARBY, version: "1.2.3" }] });
      if (parsed.pathname === "/api/v1/status") return Response.json({ name: "Home", version: "1.2.3" });
      if (parsed.pathname.endsWith("/probes")) return Response.json({ reachable: true, trusted: !parsed.pathname.includes("rec-untrusted") });
      if (parsed.pathname === "/api/v1/desktop/handoff") {
        const origin = (JSON.parse(String(init?.body)) as { origin?: string }).origin;
        trace.push(`handoff:${origin}`);
        if (origin === TRUSTED) return Response.json({ origin: TRUSTED, hostname: "100.84.12.7", port: 6768, fingerprint: "AA", token: TOKEN });
        return Response.json({ origin }, { status: 404 });
      }
      if (parsed.pathname === "/api/v1/console-roster") return Response.json(roster);
      if (parsed.pathname === "/api/v1/join") return new Response(null, { status: 204 });
      return Response.json({ ok: true });
    });
    const open = vi.fn(async (origin: string) => {
      trace.push(`open:${origin}`);
      url = `${origin}/console/`;
      contents.emit("did-finish-load");
    });
    const section = createConsoleSectionController({
      home: () => HOME,
      fetch,
      rosterFetch: fetch,
      confirmIdentity: async (hostname) => { trace.push(`confirm:${hostname}`); },
      pinRemote: (hostname) => { trace.push(`pin:${hostname}`); },
      open,
      add: vi.fn(),
      confirmForget: vi.fn(async () => false),
      report: vi.fn(),
    });
    const send = (command: ConsoleSectionCommand) => {
      contents.emit("will-navigate", { preventDefault() {} }, consoleSectionCommandUrl(new URL(url).origin, command), undefined, true);
    };
    const deliveries = () => scripts.map(delivered).filter((item): item is Delivery => item !== null);
    const lastSection = () => deliveries().filter((item) => item.type === CONSOLE_SECTION_EVENT).at(-1);
    try {
      section.attach(contents as never);
      await section.refresh();
      const standingAtHome = lastSection()?.detail.entries?.map((entry) => entry.id) ?? [];
      expect(lastSection()?.detail.entries?.map((entry) => entry.address)).toEqual(["127.0.0.1:4310", "127.0.0.1:4311", "100.84.12.7:6768", "100.84.12.8:6769"]);
      url = `${TRUSTED}/console/`;
      await section.refresh();
      // 활성 콘솔이 바뀌어도 entries의 id 순서가 같다.
      expect(lastSection()?.detail.entries?.map((entry) => entry.id)).toEqual(standingAtHome);
      expect(lastSection()?.detail.entries?.find((entry) => entry.active)?.address).toBe("100.84.12.7:6768");
      expect(trace).not.toContain(`fetch:${UNTRUSTED}/api/v1/console-roster`);
      expect(trace).not.toContain(`handoff:${UNTRUSTED}`);
      expect(trace.some((line) => line.includes("/api/v1/join"))).toBe(false);
      const confirmAt = trace.indexOf("confirm:100.84.12.7");
      const pinAt = trace.indexOf("pin:100.84.12.7");
      const rosterAt = trace.indexOf(`fetch:${TRUSTED}/api/v1/console-roster`);
      expect(confirmAt).toBeGreaterThanOrEqual(0);
      expect(pinAt).toBeGreaterThan(confirmAt);
      expect(rosterAt).toBeGreaterThan(pinAt);
      const nearbyCall = calls.find((call) => call.url === `${NEARBY}/api/v1/console-roster`);
      expect(new Headers(nearbyCall?.init?.headers).get("Origin")).toBe(NEARBY);
      url = `${HOME}/console/`;
      const nearbyId = lastSection()?.detail.entries?.find((entry) => entry.address === "127.0.0.1:4311")?.id;
      expect(nearbyId).toBeTruthy();
      send({ switch: nearbyId!, commodore: "cmdr-9", anchorY: 80 });
      await vi.waitFor(() => deliveries().some((item) => item.type === CONSOLE_ROSTER_EVENT && item.origin === NEARBY && item.detail.arrival?.commodore === "cmdr-9"));
      const rosters = deliveries().filter((item) => item.type === CONSOLE_ROSTER_EVENT);
      for (const item of rosters) if (item.origin !== NEARBY) expect(item.detail.arrival).toBeNull();
      expect(rosters.filter((item) => item.origin === NEARBY).at(-1)?.detail.arrival).toEqual({ commodore: "cmdr-9", anchorY: 80 });
      expect(scripts.join("\n")).not.toContain(TOKEN);
      expect(trace.filter((line) => line.startsWith("open:"))).toEqual([`open:${NEARBY}`]);
      expect(lastSection()?.detail.entries?.map((entry) => entry.id)).toEqual(standingAtHome);
    } finally { section.close(); }
  });
});
