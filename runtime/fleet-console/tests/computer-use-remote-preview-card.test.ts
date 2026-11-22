// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/** 콘솔 SSE 채널을 손으로 흘린다 — 서버가 어느 화면에 무엇을 보내는지는 서버 테스트가 고정한다. */
const channels = new Map<string, Set<(payload: unknown) => void>>();
vi.mock("../core/client/src/integration/objective-records-sse.js", () => ({
  subscribeConsoleChannel: (channel: string, listener: (payload: unknown) => void) => {
    const set = channels.get(channel) ?? new Set();
    set.add(listener);
    channels.set(channel, set);
    return () => { set.delete(listener); };
  },
}));
const emit = (channel: string, payload: unknown) => { for (const listener of channels.get(channel) ?? []) listener(payload); };

const { ComputerScreenShare, ComputerScreenShareProvider } = await import("../features/computer-use/client/computer-screen-share.js");
const { DESKTOP_REMOTE_PREVIEW_FRAME_PATH, REMOTE_PREVIEW_FRAME_PATH, REMOTE_PREVIEW_STATE_EVENT, REMOTE_PREVIEW_VIEWERS_EVENT } = await import("../features/computer-use/shared/remote-preview.js");

const target = { id: "target-1", ownerKind: "commodore", objectiveId: null, commodoreId: "commodore-1", actor: "commodore-1" };
type Responder = (signal: AbortSignal) => Promise<Response>;
let frames: Responder[] = [];
let fetchMock: ReturnType<typeof vi.fn>;
let objectUrls = 0;
const mounted: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  channels.clear();
  frames = [];
  objectUrls = 0;
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input);
    if (path.startsWith(REMOTE_PREVIEW_FRAME_PATH)) {
      const next = frames.shift();
      const signal = init?.signal ?? new AbortController().signal;
      if (next) return next(signal);
      // 새 장이 없으면 서버처럼 붙잡아 둔다 — 끊기면 거절된다.
      return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    }
    if (path.startsWith(DESKTOP_REMOTE_PREVIEW_FRAME_PATH)) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({}), { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => `blob:frame-${++objectUrls}`, revokeObjectURL: () => undefined }));
});
afterEach(() => {
  for (const cleanup of mounted.splice(0)) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.desktopShell;
});

const frame = (bytes = [0xff, 0xd8, 0xff, 0xd9]): Responder => async () => new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "image/jpeg", "x-fleet-preview-seq": "1", "x-fleet-preview-age-ms": "0" } });
const refused = (status: number): Responder => async () => new Response(JSON.stringify({ error: "x" }), { status });
const offline: Responder = async () => { throw new TypeError("network"); };

async function mount() {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  mounted.push(() => { act(() => root.unmount()); node.remove(); });
  await act(async () => { root.render(createElement(ComputerScreenShareProvider, null, createElement(ComputerScreenShare, { commodoreId: "commodore-1" }))); });
  return node;
}
const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

it("shows the remote still in the host card's place with a fixed name and no status text while frames arrive", async () => {
  const node = await mount();
  expect(node.querySelector(".computer-screen-share")).toBeNull();
  frames.push(frame());
  await act(async () => { emit(REMOTE_PREVIEW_STATE_EVENT, { target, sending: true }); });
  await flush();
  const card = node.querySelector<HTMLElement>(".computer-screen-share.is-remote")!;
  expect(card.getAttribute("aria-label")).toBe("Preview of the selected window on the host");
  expect(card.querySelector("img")?.getAttribute("src")).toBe("blob:frame-1");
  expect(card.querySelector("video")).toBeNull();
  // 정상일 때는 갱신 시각·상태 문구를 띄우지 않는다.
  expect(card.querySelector(".computer-screen-share-stale")).toBeNull();
  expect(card.querySelector('[role="status"]')?.textContent).toBe("");
  expect(fetchMock.mock.calls.some(([path]) => String(path).startsWith(DESKTOP_REMOTE_PREVIEW_FRAME_PATH))).toBe(false);
});

it("keeps the last still through a network delay and names the elapsed seconds after five, announcing it once", async () => {
  const node = await mount();
  frames.push(frame(), offline, offline, offline, offline, offline, offline, offline);
  await act(async () => { emit(REMOTE_PREVIEW_STATE_EVENT, { target, sending: true }); });
  await flush();
  await flush(4000);
  expect(node.querySelector(".computer-screen-share-stale")).toBeNull();
  await flush(2500);
  const card = node.querySelector<HTMLElement>(".computer-screen-share")!;
  expect(card.querySelector("img")?.getAttribute("src")).toBe("blob:frame-1");
  expect(card.querySelector(".computer-screen-share-stale")?.textContent).toBe("No new preview in the last 6 seconds.");
  const announced = card.querySelector('[role="status"]')!.textContent;
  expect(announced).toMatch(/^No new preview in the last \d+ seconds\.$/u);
  await flush(2000);
  // 화면의 초수는 늘지만 스크린리더 알림은 처음 한 번 그대로다.
  expect(card.querySelector(".computer-screen-share-stale")?.textContent).toBe("No new preview in the last 8 seconds.");
  expect(card.querySelector('[role="status"]')!.textContent).toBe(announced);
});

it("starts the delay count from the wait when no first still arrives, instead of leaving an empty card", async () => {
  const node = await mount();
  await act(async () => { emit(REMOTE_PREVIEW_STATE_EVENT, { target, sending: true }); });
  await flush();
  expect(node.querySelector(".computer-screen-share-still.is-empty")).not.toBeNull();
  expect(node.querySelector(".computer-screen-share")!.textContent).toBe("");
  await flush(5500);
  expect(node.querySelector(".computer-screen-share-stale")?.textContent).toBe("No new preview in the last 5 seconds.");
});

it("hides the previous still at once when a read is refused, without claiming the host turned previews off", async () => {
  const node = await mount();
  frames.push(frame(), refused(403));
  await act(async () => { emit(REMOTE_PREVIEW_STATE_EVENT, { target, sending: true }); });
  await flush();
  expect(node.querySelector(".computer-screen-share img")).toBeNull();
  expect(node.querySelector(".computer-screen-share-still.is-empty")).not.toBeNull();
  expect(node.textContent).not.toContain("Remote preview is off in the host settings.");
});

it("says the host turned previews off only from the server state, and removes the card when use ends", async () => {
  const node = await mount();
  frames.push(frame());
  await act(async () => { emit(REMOTE_PREVIEW_STATE_EVENT, { target, sending: true }); });
  await flush();
  await act(async () => { emit(REMOTE_PREVIEW_STATE_EVENT, { target, sending: false }); });
  await flush();
  const card = node.querySelector(".computer-screen-share")!;
  expect(card.textContent).toBe("Remote preview is off in the host settings.");
  expect(card.querySelector("img")).toBeNull();
  await act(async () => { emit(REMOTE_PREVIEW_STATE_EVENT, { target: null, sending: false }); });
  await flush();
  expect(node.querySelector(".computer-screen-share")).toBeNull();
});

it("on the host Desktop, shares the existing window track only while a remote device watches and says so on the card", async () => {
  document.documentElement.dataset.desktopShell = "true";
  const track = { readyState: "live", addEventListener: vi.fn(), stop: vi.fn(), getSettings: () => ({ width: 1440, height: 900 }) };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const getDisplayMedia = vi.fn(async () => stream);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getDisplayMedia } });
  vi.stubGlobal("ImageCapture", class { grabFrame() { return Promise.resolve({ width: 1440, height: 900, close: () => undefined }); } });
  const drawn: number[][] = [];
  vi.stubGlobal("OffscreenCanvas", class {
    constructor(readonly width: number, readonly height: number) { drawn.push([width, height]); }
    getContext() { return { drawImage: () => undefined }; }
    convertToBlob() { return Promise.resolve(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" })); }
  });
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  const node = await mount();
  await act(async () => { emit("computer-capture:state", { target: { ...target, title: "Fixture" } }); });
  await flush();
  expect(getDisplayMedia).toHaveBeenCalledTimes(1);
  const card = node.querySelector(".computer-screen-share")!;
  expect(card.getAttribute("aria-label")).toBe("Live screen preview");
  expect(card.querySelector(".computer-screen-share-remote")).toBeNull();
  await flush(3000);
  const uploads = () => fetchMock.mock.calls.filter(([path]) => String(path).startsWith(DESKTOP_REMOTE_PREVIEW_FRAME_PATH));
  expect(uploads()).toHaveLength(0);

  await act(async () => { emit(REMOTE_PREVIEW_VIEWERS_EVENT, { count: 1 }); });
  await flush(2100);
  expect(card.querySelector(".computer-screen-share-remote")?.textContent).toBe("Sharing with a remote device");
  expect(uploads().length).toBeGreaterThanOrEqual(2);
  expect(String(uploads()[0]![0])).toBe(`${DESKTOP_REMOTE_PREVIEW_FRAME_PATH}?target=target-1`);
  expect(drawn[0]).toEqual([480, 300]);
  // 새 캡처를 열지 않는다 — 이미 받은 창 트랙만 쓴다.
  expect(getDisplayMedia).toHaveBeenCalledTimes(1);

  await act(async () => { emit(REMOTE_PREVIEW_VIEWERS_EVENT, { count: 0 }); });
  const stopped = uploads().length;
  await flush(3000);
  expect(uploads()).toHaveLength(stopped);
  expect(card.querySelector(".computer-screen-share-remote")).toBeNull();
});
