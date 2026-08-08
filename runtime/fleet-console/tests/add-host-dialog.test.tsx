// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AddHostDialog } from "../core/client/src/components/add-host-dialog.js";

const LINK = "fleet://join?code=abcdef";
const HOST = {
  id: "h1",
  label: "Studio",
  origin: "https://192.168.0.9:7777",
  hostname: "192.168.0.9",
  port: 7777,
  fingerprint: "aa:bb",
  addedAt: 1,
  lastOpenedAt: null,
};

const originalFetch = globalThis.fetch;
let root: Root | null = null;
let container: HTMLElement | null = null;
let shell: HTMLElement | null = null;

function mount(onClose: () => void): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<AddHostDialog onClose={onClose} />));
}

function card(): HTMLElement {
  const node = document.querySelector<HTMLElement>(".add-host-card");
  if (node === null) throw new Error("dialog is not mounted");
  return node;
}

function type(value: string): void {
  const input = card().querySelector<HTMLInputElement>("input");
  if (input === null) throw new Error("no input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  act(() => { input.dispatchEvent(new Event("input", { bubbles: true })); });
}

async function submit(): Promise<void> {
  const form = card().querySelector<HTMLFormElement>("form");
  if (form === null) throw new Error("no form");
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}

beforeEach(() => {
  document.body.replaceChildren();
  shell = document.createElement("div");
  shell.className = "console-shell";
  document.body.append(shell);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  container = null;
  shell = null;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

describe("AddHostDialog", () => {
  it("sends the pasted link verbatim and closes once the server accepts it", async () => {
    const calls: Array<{ readonly url: string; readonly method: string; readonly body: string | null }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null });
      const payload = init?.method === "POST" ? { host: HOST } : { hosts: [HOST] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof globalThis.fetch;

    const onClose = vi.fn();
    mount(onClose);
    type(`  ${LINK}  `);
    await submit();

    const post = calls.find((call) => call.method === "POST");
    expect(post?.url).toBe("/api/v1/remote-hosts");
    // 링크는 화면이 풀지 않는다 — 공백만 걷어낸 문자열 그대로 서버로 간다.
    expect(post?.body).toBe(JSON.stringify({ link: LINK }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog open and states the reason when the server rejects the link", async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ error: "remote_host_fingerprint_mismatch" }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    )) as typeof globalThis.fetch;

    const onClose = vi.fn();
    mount(onClose);
    type(LINK);
    await submit();

    expect(onClose).not.toHaveBeenCalled();
    const alert = card().querySelector<HTMLElement>(".add-host-error");
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toContain("different certificate");
    // 실패는 링크를 지우지 않는다 — 고쳐 넣을 수 있어야 한다.
    expect(card().querySelector<HTMLInputElement>("input")?.value).toBe(LINK);
    // 보내는 동안 비활성이 된 컨트롤이 포커스를 body로 떨어뜨린다 — 렌더가 끝난 뒤 되돌려준다.
    expect(document.activeElement).toBe(card().querySelector("input"));
  });

  it("still answers Escape when the send cycle left focus outside the card", async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ error: "remote_host_unreachable" }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    )) as typeof globalThis.fetch;

    const onClose = vi.fn();
    mount(onClose);
    type(LINK);
    await submit();
    // 카드에 건 리스너였다면 여기서 Escape가 죽는다(실측으로 잡힌 결함).
    await act(async () => { document.body.focus(); });
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("pulls Tab back into the card when focus has escaped it", async () => {
    mount(() => undefined);
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);
    await act(async () => {
      outside.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    expect(card().contains(document.activeElement)).toBe(true);
  });

  it("makes the console inert while open and releases it on close", async () => {
    mount(() => undefined);
    expect(shell?.inert).toBe(true);
    await act(async () => root?.unmount());
    root = null;
    expect(shell?.inert).toBe(false);
  });

  it("returns focus to its opener only after the console is no longer inert", async () => {
    // 여는 버튼은 inert가 걸리는 셸 안에 산다 — 되돌리는 순서가 틀리면 실제 브라우저에서
    // focus()가 조용히 무시되고 근처의 다른 버튼이 대신 잡힌다(실측으로 잡힌 결함).
    // jsdom은 inert로 포커스를 막지 않으므로 포커스가 도착한 시점의 inert 값을 재야
    // 이 단정이 순서를 실제로 지킨다 — activeElement만 보면 순서를 뒤집어도 통과한다.
    const opener = document.createElement("button");
    shell?.append(opener);
    let inertWhenFocusLanded: boolean | undefined;
    opener.addEventListener("focus", () => { inertWhenFocusLanded = shell?.inert; });

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(<AddHostDialog openerRef={{ current: opener }} onClose={() => undefined} />));
    expect(document.activeElement).not.toBe(opener);

    await act(async () => root?.unmount());
    root = null;
    expect(document.activeElement).toBe(opener);
    expect(inertWhenFocusLanded).toBe(false);
  });

  it("closes on Escape without contacting the server", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const onClose = vi.fn();
    mount(onClose);
    type(LINK);
    await act(async () => {
      const input = card().querySelector<HTMLInputElement>("input");
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still accepts the response under StrictMode's setup-cleanup-setup cycle", async () => {
    // 개발 채널의 main.tsx는 앱을 StrictMode로 렌더한다 — effect가 setup→cleanup→setup으로
    // 두 번 돌므로, 첫 cleanup이 내린 생존 표시를 두 번째 setup이 되돌리지 않으면 이후 모든
    // 응답이 무시된다: 성공해도 창이 닫히지 않고 실패해도 "확인 중…"에 멈춘다.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const payload = init?.method === "POST" ? { host: HOST } : { hosts: [HOST] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof globalThis.fetch;

    const onClose = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(<StrictMode><AddHostDialog onClose={onClose} /></StrictMode>));
    // 두 사이클 사이에서 cleanup이 여는 자리로 포커스를 되돌리므로, 두 번째 setup이 입력으로
    // 다시 가져오는지도 함께 본다 — 열자마자 포커스가 창 밖에 있으면 안 된다.
    expect(document.activeElement).toBe(card().querySelector("input"));
    type(LINK);
    await submit();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("aborts the in-flight add when the user dismisses the dialog", async () => {
    // 취소가 붙은 창은 정말로 멈춰야 한다 — 인증서 탐침은 6초까지 끌 수 있고, 그 사이
    // 요청이 살아 있으면 취소했다고 믿은 콘솔이 목록에 남는다.
    let sent: AbortSignal | undefined;
    globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      sent = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    }) as unknown as typeof globalThis.fetch;

    mount(() => undefined);
    type(LINK);
    await submit();
    expect(sent).toBeDefined();
    expect(sent?.aborted).toBe(false);

    await act(async () => root?.unmount());
    root = null;
    expect(sent?.aborted).toBe(true);
  });

  it("blocks submission while the field is empty", () => {
    mount(() => undefined);
    const button = card().querySelector<HTMLButtonElement>(".add-host-submit");
    expect(button?.disabled).toBe(true);
    type(LINK);
    expect(card().querySelector<HTMLButtonElement>(".add-host-submit")?.disabled).toBe(false);
  });
});
