import { EventEmitter } from "node:events";
import { CONSOLE_ROSTER_EVENT, CONSOLE_ROSTER_MAX_FRAME, CONSOLE_SECTION_EVENT, consoleSectionCommandUrl, isConsoleRosterState, type ConsoleSectionCommand } from "@fleet-console/protocol/desktop/console-section";
import { describe, expect, it, vi } from "vitest";
import { createConsoleSectionController } from "../src/console-section-controller.js";

const HOME = "http://127.0.0.1:4310";
const NEARBY = "http://127.0.0.1:4311";
const TRUSTED = "https://100.84.12.7:6768";
const UNTRUSTED = "https://100.84.12.8:6769";
const TITLE = 110;
const TOKEN = "grant-token-must-not-leak";

interface Delivery {
  readonly origin: string;
  readonly type: string;
  readonly detail: {
    readonly entries?: readonly { readonly id: string; readonly address: string; readonly active: boolean }[];
    readonly arrival?: { readonly commodore: string; readonly anchorY: number | null; readonly commander?: string | null; readonly scrollTop?: number | null; readonly rightPanel?: { readonly open: boolean; readonly tab?: string } | null } | null;
    readonly rosters?: readonly { readonly id: string; readonly more: number; readonly sections?: readonly { readonly id: string }[]; readonly unsectionedCollapsed?: true; readonly commodores: readonly { readonly section?: string; readonly preview?: string; readonly commanders?: readonly unknown[]; readonly moreCommanders?: number }[] }[];
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
    const commander = { id: "obj-1", title: "Ship it", done: 1, total: 3, run: "working", look: { base: 4, tone: "amber" } };
    const sections = [{ id: "sec-fleet", name: "Fleet", collapsed: true }, { id: "sec-b", name: "Backlog" }];
    const roster = { v: 1, commodores: [{ id: "cmdr-9", name: "Nuri", look: { base: 2, tone: null }, run: "quiet", section: "sec-fleet", preview: "last words", commanders: [commander], moreCommanders: 2 }], more: 0, sections, unsectionedCollapsed: true };
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      const parsed = new URL(input);
      calls.push({ url: input, init });
      trace.push(`fetch:${parsed.origin}${parsed.pathname}`);
      if (parsed.pathname === "/api/v1/remote-hosts") return Response.json({ hosts: [
        { id: "rec-trusted", origin: TRUSTED, label: "Studio", hostname: "100.84.12.7", port: 6768, fingerprint: "FINGERPRINT-TRUSTED", token: TOKEN },
        { id: "rec-untrusted", origin: UNTRUSTED, label: "Old", hostname: "100.84.12.8", port: 6769, fingerprint: "FINGERPRINT-UNTRUSTED" },
      ] });
      if (parsed.pathname === "/api/v1/local-consoles") return Response.json({ consoles: [{ origin: HOME, version: "1.2.3" }, { origin: NEARBY, version: "1.2.3" }] });
      if (parsed.pathname === "/api/v1/status") return Response.json({ name: "Home", version: "1.2.3" });
      if (parsed.pathname.endsWith("/probes")) return Response.json({ reachable: true, trusted: !parsed.pathname.includes("rec-untrusted") });
      if (parsed.pathname === "/api/v1/console-roster") return Response.json(roster);
      if (parsed.pathname === "/api/v1/join") return new Response(null, { status: 204 });
      return Response.json({ ok: true });
    });
    let openFinished = false;
    let releaseOpen = (): void => {};
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const open = vi.fn(async (origin: string) => {
      trace.push(`open:${origin}`);
      await section.refresh();
      url = `${origin}/console/`;
      contents.emit("did-finish-load");
      send({ request: "state" });
      await openGate;
      openFinished = true;
    });
    const section = createConsoleSectionController({
      home: () => HOME,
      fetch,
      rosterFetch: fetch,
      confirmIdentity: async (hostname) => { trace.push(`confirm:${hostname}`); },
      pinRemote: (record) => { trace.push(`pin:${record.hostname}`); },
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
      // 서 있는 집의 명부도 미리 읽어 둔다: 원격으로 전환해도 집 섹션이 도착 문서의 첫 프레임부터 채워져 있다.
      expect(calls.some((call) => call.url === `${HOME}/api/v1/console-roster`)).toBe(true);
      expect(lastSection()?.detail.entries?.map((entry) => entry.address)).toEqual(["127.0.0.1:4310", "127.0.0.1:4311", "100.84.12.7:6768", "100.84.12.8:6769"]);
      url = `${TRUSTED}/console/`;
      await section.refresh();
      // 활성 콘솔이 바뀌어도 entries의 id 순서가 같다.
      expect(lastSection()?.detail.entries?.map((entry) => entry.id)).toEqual(standingAtHome);
      expect(lastSection()?.detail.entries?.find((entry) => entry.active)?.address).toBe("100.84.12.7:6768");
      expect(trace).not.toContain(`fetch:${UNTRUSTED}/api/v1/console-roster`);
      // 명부 읽기 동안 /api/v1/desktop/handoff가 한 번도 호출되지 않는다.
      expect(calls.some((call) => new URL(call.url).pathname === "/api/v1/desktop/handoff")).toBe(false);
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
      send({ switch: nearbyId!, commodore: "cmdr-9", commander: "obj-1", anchorY: 80, scrollTop: 240, rightPanel: { open: true, tab: "files" } });
      await vi.waitFor(() => {
        expect(deliveries().some((item) => item.type === CONSOLE_ROSTER_EVENT && item.origin === NEARBY && item.detail.arrival?.commodore === "cmdr-9")).toBe(true);
      });
      expect(openFinished).toBe(false);
      expect(calls.some((call) => new URL(call.url).pathname === "/api/v1/desktop/handoff")).toBe(false);
      const rosters = deliveries().filter((item) => item.type === CONSOLE_ROSTER_EVENT);
      for (const item of rosters) if (item.origin !== NEARBY) expect(item.detail.arrival).toBeNull();
      expect(rosters.filter((item) => item.origin === NEARBY).at(-1)?.detail.arrival).toEqual({ commodore: "cmdr-9", anchorY: 80, commander: "obj-1", scrollTop: 240, rightPanel: { open: true, tab: "files" } });
      // 원격이 보낸 미리보기와 진행 중 사령관은 검증을 지나 문서까지 그대로 간다.
      expect(rosters.filter((item) => item.origin === HOME).flatMap((item) => item.detail.rosters ?? []).find((entry) => entry.commodores.length > 0)?.commodores[0]).toMatchObject({ section: "sec-fleet", preview: "last words", commanders: [commander], moreCommanders: 2 });
      // 섹션도 요약 그대로 명부 항목에 실린다.
      const homeEntry = rosters.filter((item) => item.origin === HOME).flatMap((item) => item.detail.rosters ?? []).find((entry) => entry.commodores.length > 0);
      expect(homeEntry?.sections).toEqual(sections);
      expect(homeEntry?.unsectionedCollapsed).toBe(true);
      expect(scripts.join("\n")).not.toContain(TOKEN);
      expect(scripts.join("\n")).not.toContain("FINGERPRINT-TRUSTED");
      expect(trace.filter((line) => line.startsWith("open:"))).toEqual([`open:${NEARBY}`]);
      expect(lastSection()?.detail.entries?.map((entry) => entry.id)).toEqual(standingAtHome);
    } finally { releaseOpen(); section.close(); }
  });

  it("fits an oversized roster frame by dropping previews, then commanders, then commodores", async () => {
    const sections = [0, 1, 2].map((index) => ({ id: `sec-${index}`, name: `Section ${index}` }));
    const big = (previewLength: number) => ({ v: 1, more: 0, sections, commodores: Array.from({ length: 40 }, (_, index) => ({
      id: `cmdr-${index}`, name: `Name ${index}`, look: null, run: "quiet", section: `sec-${index % 3}`, preview: "p".repeat(previewLength),
      commanders: Array.from({ length: 8 }, (__, slot) => ({ id: `obj-${index}-${slot}-${"x".repeat(100)}`, title: "t".repeat(TITLE), done: 1, total: 2, run: "working" })), moreCommanders: 0,
    })) });
    const scripts: string[] = [];
    const contents = Object.assign(new EventEmitter(), { getURL: () => `${HOME}/console/`, isDestroyed: () => false, executeJavaScript: async (script: string) => { scripts.push(script); } });
    const fetch = vi.fn(async (input: string) => {
      const parsed = new URL(input);
      if (parsed.pathname === "/api/v1/remote-hosts") return Response.json({ hosts: [] });
      if (parsed.pathname === "/api/v1/local-consoles") return Response.json({ consoles: [{ origin: HOME }, { origin: NEARBY }] });
      if (parsed.pathname === "/api/v1/status") return Response.json({ name: "Home", version: "1.2.3" });
      if (parsed.pathname === "/api/v1/console-roster") return Response.json(big(160));
      return Response.json({});
    });
    const section = createConsoleSectionController({ home: () => HOME, fetch, rosterFetch: fetch, open: vi.fn(), add: vi.fn(), confirmForget: vi.fn(async () => false), report: vi.fn() });
    try {
      section.attach(contents as never);
      await section.refresh();
      const last = scripts.map(delivered).filter((item): item is Delivery => item?.type === CONSOLE_ROSTER_EVENT).at(-1);
      const entry = last?.detail.rosters?.[0];
      const commodores = entry?.commodores ?? [];
      expect(new TextEncoder().encode(JSON.stringify(last?.detail)).length).toBeLessThanOrEqual(CONSOLE_ROSTER_MAX_FRAME);
      expect(isConsoleRosterState(last?.detail)).toBe(true);
      // 미리보기를 다 빼도 넘치므로 뒤쪽 사령관부터 덜지만, 사령관(commodore)은 남고 덜어 낸 수는 moreCommanders에 올라간다.
      expect(commodores).toHaveLength(40);
      expect(commodores.every((item) => item.preview === undefined)).toBe(true);
      expect(commodores[0]?.commanders?.length).toBe(8);
      expect(commodores.at(-1)?.commanders?.length).toBeLessThan(8);
      expect(commodores.every((item) => (item.commanders?.length ?? 0) + (item.moreCommanders ?? 0) === 8)).toBe(true);
      // 남은 사령관이 가리키는 섹션은 줄인 뒤에도 그대로 있다.
      expect(entry?.sections).toEqual(sections);
      expect(commodores.every((item) => entry?.sections?.some((one) => one.id === item.section))).toBe(true);
    } finally { section.close(); }
  });
});
