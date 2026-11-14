import type { ChromeUiState } from "../contract.js";
import type { RemoteBrowserInputEvent } from "@fleet-console/protocol/desktop";
import {
  createRemoteInputSender,
  isComposingKey,
  matchesConsoleShortcut,
  toRemoteKeyEvent,
  toRemoteMouseEvent,
  toViewportPoint,
  type ContentAlign,
  type RemoteInputSender,
} from "../../remote-browser-input.js";
import { clear, G, glyph, h } from "./dom.js";
import { paintColors, post, shownSpace, spaceName, syncShellMotion, tr } from "./shared.js";

/**
 * 스테이지 문서 — 표시 탭의 페이지가 없는 동안 페이지 자리를 채운다. 페이지 뷰가 서면 그 아래에 가려진다.
 * 보기 전용 셸에서는 페이지 뷰가 없다 — 이 문서가 main 이 밀어 넣는 최신 프레임 한 장을 그 자리에 그린다.
 *
 * 원격 조작이 열리면(`viewOnly.status === "connected"` 이고 프레임이 보이는 동안) 이 문서는
 * 원격 입력 캡처도 맡는다: 포인터·휠·키를 뷰포트 CSS px 로 바꿔 `remote-input` 배치로 main 에 넘기고,
 * 한글 IME 는 포커스 수용 요소(textarea)의 composition 으로 받아 `ime` 이벤트로만 보낸다.
 * 실행 측이 보낸 `<select>`·권한 창은 페이지 위 오버레이로 그리고 답을 `remote-select`·`remote-permission` 으로 돌려준다.
 */

/** 프레임 요소의 `object-position` — chrome.css 의 `.frame` 규칙과 같은 값이어야 한다. */
const FRAME_ALIGN: ContentAlign = { x: "center", y: "top" };

export interface RemoteFrameMeta {
  readonly cssWidth: number;
  readonly cssHeight: number;
}

export function mountStage(): {
  render(state: ChromeUiState): void;
  frame(tabId: string | null, src: string | null, meta?: RemoteFrameMeta | null): void;
} {
  const root = h("div", { class: "empty" });
  const image = h("img", { class: "frame", alt: "", draggable: false, hidden: true as unknown as boolean });
  // 한글 IME 조합 입력을 받는 포커스 수용 요소. 화면에는 보이지 않지만 OS IME 가 붙을 수 있게
  // 포커스 가능 상태로 둔다 — 조합 중인 글자는 이 요소가 아니라 실행 측 페이지에 닿는다.
  const imeTarget = h("textarea", {
    class: "remote-ime",
    attrs: { "aria-hidden": "true", tabindex: "-1", autocomplete: "off", autocorrect: "off", autocapitalize: "off", spellcheck: "false" },
  });
  document.body.append(image, imeTarget, root);
  let last: ChromeUiState | null = null;
  /** 지금 그림이 어느 탭의 것인가 — 보는 탭이 바뀌면 옛 탭의 그림을 남기지 않는다. */
  let shownTab: string | null = null;
  /** 실행 측 뷰포트 CSS 크기 — frame() 이 준 최신 값. 없으면 레터박스 보정 없이 요소 전체를 쓴다. */
  let cssSize: RemoteFrameMeta | null = null;
  /** 이 탭으로 보내는 배치 송신기 — 탭이 바뀌면 seq 충돌을 피하려고 새로 만든다. */
  let sender: RemoteInputSender | null = null;
  let senderTab: string | null = null;

  const inputActive = (): boolean =>
    last?.viewOnly?.control === true && last?.viewOnly?.status === "connected" && !image.hidden && shownTab !== null;

  /** 에이전트가 표시 탭을 모는 동안은 로컬과 똑같이 사람 입력을 막는다. */
  const inputAllowed = (): boolean => inputActive() && last?.control?.holder !== "agent";

  const shortcutSet = (): ReadonlySet<string> => new Set(last?.viewOnly?.shortcuts ?? []);

  const ensureSender = (): RemoteInputSender | null => {
    const tabId = last?.chrome?.activeTabId ?? null;
    if (tabId === null || !inputAllowed()) {
      sender = null;
      senderTab = null;
      return null;
    }
    if (!sender || senderTab !== tabId) {
      senderTab = tabId;
      const spaceId = last?.spaceId ?? undefined;
      sender = createRemoteInputSender({
        tabId,
        ...(spaceId ? { spaceId } : {}),
        // 재적재 뒤 seq 가 0으로 돌아가 실행 측 순서 검사를 헷갈리지 않게 시각 기반 시작점.
        startSeq: Date.now() % 1_000_000,
        transport: {
          send: (batch) => {
            // 한 프레임에 몰린 입력은 다음 프레임까지 모아 최신·합산 1건으로 묶는다.
            // discrete(down/up/key/IME)도 최대 한 프레임만 늦는다 — 원격 지연에 비하면 무시할 수준이다.
            const events: RemoteBrowserInputEvent[] = [...batch.events];
            return new Promise<void>((resolve) => {
              const fire = (): void => {
                post("stage", "remote-input", { tabId: batch.tabId, seq: batch.seq, events });
                resolve();
              };
              if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => fire());
              else setTimeout(fire, 16);
            });
          },
        },
      });
    }
    return sender;
  };

  const toViewport = (clientX: number, clientY: number): { x: number; y: number } | null => {
    if (cssSize === null) {
      const box = image.getBoundingClientRect();
      if (!(box.width > 0 && box.height > 0)) return null;
      return { x: Math.min(Math.max(clientX - box.left, 0), box.width), y: Math.min(Math.max(clientY - box.top, 0), box.height) };
    }
    const box = image.getBoundingClientRect();
    return toViewportPoint(clientX, clientY, { x: box.left, y: box.top, width: box.width, height: box.height }, cssSize, FRAME_ALIGN);
  };

  const focusIme = (): void => {
    if (!inputAllowed()) return;
    try {
      imeTarget.focus({ preventScroll: true });
    } catch {
      imeTarget.focus();
    }
  };

  const renderViewer = (state: ChromeUiState): void => {
    const t = tr(state);
    const chrome = state.chrome;
    const view = state.viewOnly!;
    const tab = chrome?.tabs.find((candidate) => candidate.id === chrome.activeTabId) ?? null;
    if (tab === null || tab.id !== shownTab || view.status !== "connected") {
      shownTab = null;
      image.hidden = true;
      image.removeAttribute("src");
    }
    document.documentElement.dataset.viewOnly = "true";
    image.alt = tab ? tab.title || t("viewOnly") : "";
    clear(root);
    root.hidden = !image.hidden;
    if (!image.hidden) return;
    const space = shownSpace(state);
    const title = view.status === "unmanaged" ? t("viewOnly.unmanaged") : view.status === "manager_disconnected" ? t("viewOnly.disconnected")
      : tab ? t("viewOnly.waiting") : space?.kind === "commodore" ? t("spaces.emptyTitle", { name: spaceName(t, space) }) : t("viewOnly.noTabs");
    root.append(h("span", { class: "empty-glyph" }, glyph(G.globe, 28)), h("p", { class: "empty-title", text: title }));
  };

  // ---------- 원격 입력 캡처 ----------

  const onPointerDown = (event: MouseEvent): void => {
    if (!inputAllowed()) return;
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    const point = toViewport(event.clientX, event.clientY);
    if (!point) return;
    focusIme();
    event.preventDefault();
    ensureSender()?.pushMouse(toRemoteMouseEvent("down", point, {
      alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey,
      button: event.button as 0 | 1 | 2, clickCount: 1,
    }));
  };

  const onPointerMove = (event: MouseEvent): void => {
    if (!inputAllowed()) return;
    const point = toViewport(event.clientX, event.clientY);
    if (!point) return;
    // 버튼을 누른 채 움직이면 드래그 — down/move/up 순서 그대로 실행 측에 닿는다.
    ensureSender()?.pushMouse(toRemoteMouseEvent("move", point, {
      alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey,
    }));
  };

  const onPointerUp = (event: MouseEvent): void => {
    if (!inputAllowed()) return;
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    const point = toViewport(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    ensureSender()?.pushMouse(toRemoteMouseEvent("up", point, {
      alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey,
      button: event.button as 0 | 1 | 2, clickCount: 1,
    }));
  };

  const onWheel = (event: WheelEvent): void => {
    if (!inputAllowed()) return;
    const point = toViewport(event.clientX, event.clientY);
    if (!point) return;
    // 줄 단위(deltaMode 1)면 Chromium 픽셀 기준에 맞춘다 — 실행 측과 같은 자리에서 뭉친다.
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    event.preventDefault();
    ensureSender()?.pushMouse(toRemoteMouseEvent("wheel", point, {
      alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey,
      deltaX: event.deltaX * unit, deltaY: event.deltaY * unit,
    }));
  };

  const onKey = (event: KeyboardEvent, type: "keyDown" | "keyUp"): void => {
    if (!inputAllowed()) return;
    // IME 조합 키(keyCode 229 / isComposing)는 키 경로가 아니라 composition 경로로만 보낸다.
    if (isComposingKey({ keyCode: event.keyCode, isComposing: event.isComposing, key: event.key })) return;
    // 등록된 Console 전역 단축키와 같은 문장이면 실행 측으로 보내지 않는다 — 그 자리에서 Console 이 받는다.
    if (type === "keyDown" && matchesConsoleShortcut({ meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, code: event.code }, shortcutSet(), last?.platform ?? "")) return;
    event.preventDefault();
    ensureSender()?.pushKey(toRemoteKeyEvent({
      key: event.key, code: event.code, keyCode: event.keyCode, isComposing: event.isComposing, repeat: event.repeat,
      alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey,
    }, type));
  };

  const onComposition = (event: CompositionEvent): void => {
    if (!inputAllowed()) return;
    const senderNow = ensureSender();
    if (!senderNow) return;
    if (event.type === "compositionend") {
      senderNow.pushIme({ kind: "ime", type: "commit", text: event.data ?? "" });
      return;
    }
    // compositionstart 는 글자 없이 시작만 알린다 — update/commit 이 실제 내용을 싣는다.
    if (event.type === "compositionupdate") senderNow.pushIme({ kind: "ime", type: "composition", text: event.data ?? "" });
  };

  image.addEventListener("mousedown", onPointerDown);
  image.addEventListener("mousemove", onPointerMove);
  image.addEventListener("mouseup", onPointerUp);
  // 우클릭 메뉴는 스테이지에서 열지 않는다 — down/up(right) 쌍이 실행 측에 닿아 그 페이지의 메뉴가 열린다.
  image.addEventListener("contextmenu", (event) => { if (inputAllowed()) event.preventDefault(); });
  image.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", (event) => onKey(event, "keyDown"));
  window.addEventListener("keyup", (event) => onKey(event, "keyUp"));
  imeTarget.addEventListener("compositionstart", onComposition);
  imeTarget.addEventListener("compositionupdate", onComposition);
  imeTarget.addEventListener("compositionend", onComposition);
  // 조합 없이 요소에 직접 들어간 글은 두 번 들어가지 않게 비운다 — 키 이벤트가 이미 실행 측으로 갔다.
  imeTarget.addEventListener("input", (event) => {
    if (!event.isComposing && imeTarget.value !== "") imeTarget.value = "";
  });
  imeTarget.addEventListener("focus", () => { if (inputActive()) ensureSender()?.pushFocus(true); });
  imeTarget.addEventListener("blur", () => { if (inputActive()) ensureSender()?.pushFocus(false); });

  return {
    render(state) {
      last = state;
      paintColors(state.colors);
      syncShellMotion(state.shellClosing);
      document.documentElement.lang = state.lang;
      if (state.viewOnly) { renderViewer(state); return; }
      delete document.documentElement.dataset.viewOnly;
      shownTab = null; cssSize = null; sender = null; senderTab = null;
      image.hidden = true; image.removeAttribute("src"); root.hidden = false;
      const t = tr(state);
      clear(root);
      const chrome = state.chrome;
      // 표시 탭이 있으면 페이지 뷰가 이 자리를 채운다 — 에뮬레이션으로 뷰보다 작게 그려질 때 빈 상태 문구가 비치지 않게 비운다.
      if (!chrome || (chrome.available && chrome.activeTabId !== null)) return;
      // 방금 열려 탭이 아직 없는 동안과 못 여는 까닭을 같은 자리에서 말한다.
      const unavailable = !chrome.available;
      // 사령관 스페이스의 빈 화면은 어느 스페이스가 비어 있는지만 한 줄로 말한다.
      const space = shownSpace(state);
      const inCommodore = !unavailable && space?.kind === "commodore";
      const title = unavailable ? t(chrome.reason === "shared" ? "unavailable.shared" : "unavailable.desktop_required") : inCommodore ? t("spaces.emptyTitle", { name: spaceName(t, space) }) : t("emptyTitle");
      const body = unavailable ? (chrome.reason === "shared" ? t("unavailable.sharedBody") : null) : inCommodore ? null : t("emptyBody");
      root.append(h("span", { class: "empty-glyph" }, glyph(G.globe, 28)), h("p", { class: "empty-title", text: title }));
      if (body) root.append(h("p", { class: "empty-body", text: body }));
    },
    /** main 이 보는 탭의 최신 프레임(`data:image/jpeg` URL)을 준다. 보는 탭이 아닌 프레임과 그 밖의 주소는 버린다. */
    frame(tabId, src, meta = null) {
      if (!last?.viewOnly || tabId === null || src === null || !src.startsWith("data:image/jpeg;base64,") || last.chrome?.activeTabId !== tabId) return;
      shownTab = tabId;
      if (meta && meta.cssWidth > 0 && meta.cssHeight > 0) cssSize = { cssWidth: meta.cssWidth, cssHeight: meta.cssHeight };
      image.src = src;
      image.hidden = false;
      renderViewer(last);
    },
  };
}
