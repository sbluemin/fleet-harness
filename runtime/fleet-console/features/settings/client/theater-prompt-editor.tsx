import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { SettingsCard, SettingsRow, SettingsToggle } from "@fleet-console/sdk/settings/browser";

import { useT } from "../../../core/client/src/i18n/index.js";
import type { TheaterInfo } from "../../../core/client/src/integration/types.js";
import { useTheaterLabel } from "../../../core/client/src/hooks/use-store.js";
import { CLAUDE_CODE_CUSTOM_SYSTEM_PROMPT_MAX_CHARS, fetchTheaterSubagents, fetchTheaterSystemPrompt, saveTheaterSubagents, saveTheaterSystemPrompt, type ClaudeCodeSystemPromptMode, type TheaterSystemPrompt } from "./execution-settings.js";

/**
 * Theater 시스템 프롬프트의 편집 상태와 저장 — 데스크톱 Theater Inbox 칸과 폰 시트가 같은 이 controller 하나를 쓴다.
 * 그리기는 각자 하지만 불러오기·자동 저장·긴 초안·잊힘 처리는 여기에만 있다.
 */

export interface TheaterPromptOpenRequest { readonly theater: PromptTheater; readonly anchor: DOMRect | null; readonly returnFocus: HTMLElement | null }
const OPEN_EVENT = "fleet:theater-system-prompt-open";
const CHANGED_EVENT = "fleet:theater-system-prompt-changed";
const FORGOTTEN_EVENT = "fleet:theater-system-prompt-forgotten";
// 서버에 저장할 수 없는 초안만 Theater별로 이 탭에 남긴다. 칸 이동·시트 닫기·다른 Theater 열기는 초안을 버리지 않는다.
// 데스크톱 칸과 폰 시트가 같은 이 모듈의 Map 하나를 읽는다.
const overLimitDrafts = new Map<string, TheaterSystemPrompt>();
// 저장과 불러오기는 한 줄로 선다. 데스크톱 칸에서 폰 시트로 넘어가도(또는 그 반대) 늦은 저장보다 먼저 읽지 않는다.
let promptQueue: Promise<void> = Promise.resolve();
// 빈 「내 지침만」으로 옮긴 뒤 저장까지 기다리는 시간 — 방향키로 지나가는 한 번(대개 수백 ms 안)은 저장하지 않는다.
const EMPTY_OFF_SETTLE_MS = 700;

export function subscribeTheaterSystemPromptForgotten(listener: (theater: string) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<string>).detail);
  window.addEventListener(FORGOTTEN_EVENT, handler);
  return () => window.removeEventListener(FORGOTTEN_EVENT, handler);
}

export function announceTheaterSystemPromptForgotten(theater: string): void {
  window.dispatchEvent(new CustomEvent(FORGOTTEN_EVENT, { detail: theater }));
}

/** 사이드바 Theater 메뉴·폰 Theater 시트의 「시스템 프롬프트」. 데스크톱은 Theater Inbox 가, 폰은 프롬프트 시트가 받는다. */
export function openTheaterSystemPrompt(theater: PromptTheater, returnFocus: HTMLElement | null, anchor?: DOMRect | null): void {
  window.dispatchEvent(new CustomEvent<TheaterPromptOpenRequest>(OPEN_EVENT, { detail: { theater, returnFocus, anchor: anchor ?? null } }));
}

export function subscribeTheaterSystemPromptOpen(listener: (request: TheaterPromptOpenRequest) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<TheaterPromptOpenRequest>).detail);
  window.addEventListener(OPEN_EVENT, handler);
  return () => window.removeEventListener(OPEN_EVENT, handler);
}

export function subscribeTheaterSystemPromptChange(listener: (theaterId: string, prompt: TheaterSystemPrompt | null) => void): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ theaterId: string; prompt: TheaterSystemPrompt | null }>).detail;
    listener(detail.theaterId, detail.prompt);
  };
  window.addEventListener(CHANGED_EVENT, handler);
  return () => window.removeEventListener(CHANGED_EVENT, handler);
}

function announce(theaterId: string, prompt: TheaterSystemPrompt | null) {
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { theaterId, prompt } }));
}

/** controller 가 읽는 Theater 의 사실 — 칸과 시트가 가진 Theater 표현이 달라도 id·이름이면 된다. */
export type PromptTheater = Pick<TheaterInfo, "id" | "label">;

export type TheaterPromptStatus = "untouched" | "idle" | "saving" | "saved" | "over" | "error";

export interface TheaterPromptController {
  readonly theater: PromptTheater | null;
  readonly stored: TheaterSystemPrompt | null;
  readonly draft: TheaterSystemPrompt;
  readonly loading: boolean;
  readonly loadFailed: boolean;
  readonly status: TheaterPromptStatus;
  readonly undo: TheaterSystemPrompt | null;
  /** 연 채로 Theater 가 잊혔다 — 편집을 멈추고 남은 글을 보여 준다. 되돌아오면 이어서 저장한다. */
  readonly forgotten: boolean;
  readonly unsaved: boolean;
  readonly copied: boolean;
  /** 초기화·되돌리기 직후 옮길 포커스. 그리는 쪽이 한 번 읽고 비운다. */
  readonly focusAfterReset: { current: "undo" | "select" | null };
  readonly changeMode: (mode: ClaudeCodeSystemPromptMode) => void;
  readonly changeBody: (body: string) => void;
  readonly reset: () => void;
  readonly restore: () => void;
  readonly copyDraft: (selectFallback: () => void) => void;
  readonly discardDraft: () => void;
  readonly flush: () => void;
}

export interface TheaterPromptControllerOptions {
  /** 처음 읽기에서 Theater 가 이미 없었다(404). 그리는 쪽이 닫는다. */
  readonly onMissing: (theater: PromptTheater) => void;
  /** 「초안 버리고 닫기」 — 초안을 버린 뒤 그리는 쪽이 닫는다. */
  readonly onDiscarded: () => void;
}

/**
 * `theater` 가 바뀌면 앞 Theater 의 대기 저장을 먼저 확정하고 새 Theater 를 읽는다. `reopenKey` 가 오르면 같은 Theater 도
 * 다시 읽는다(시트를 다시 연 경우). 언마운트도 같은 확정을 거친다 — 칸 이동·닫기가 입력을 버리지 않는다.
 */
export function useTheaterPromptController(theater: PromptTheater | null, reopenKey: number, options: TheaterPromptControllerOptions): TheaterPromptController {
  const registeredLabel = useTheaterLabel(theater?.id);
  const [stored, setStored] = useState<TheaterSystemPrompt | null>(null);
  const [draft, setDraft] = useState<TheaterSystemPrompt>({ mode: "on", body: "" });
  // 처음 그림부터 불러오는 중이다 — 읽기 전 빈 폼이 잠깐 서면, 그 폼에 준 포커스가 불러오며 사라진다.
  const [loading, setLoading] = useState(theater !== null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [status, setStatus] = useState<TheaterPromptStatus>("untouched");
  const [undo, setUndo] = useState<TheaterSystemPrompt | null>(null);
  // 연 채로 Theater가 잊히면(다른 창·API·Console Use) 닫지 않고 이 상태로 머문다 — 입력한 글이 조용히
  // 사라지지 않게 보여 주고, 그사이 Theater가 되돌아오면 이어서 저장한다.
  const [forgotten, setForgotten] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reload, setReload] = useState(0);
  const forgottenRef = useRef(false);
  const loadedRef = useRef(false);
  const focusAfterReset = useRef<"undo" | "select" | null>(null);
  const theaterRef = useRef<PromptTheater | null>(null);
  const draftRef = useRef(draft);
  const storedRef = useRef(stored);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchControllerRef = useRef<AbortController | null>(null);
  // 열기/닫기 순서는 렌더보다 앞설 수 있다. 비동기 GET은 렌더 중 동기화되는 state가 아닌 토큰으로 소유권을 판정한다.
  const openIdRef = useRef(0);
  const revisionRef = useRef(0);
  const dirtyRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  // 잊힌 Theater에는 더 저장하지 않는다. 대기 중인 저장·불러오기를 멈추고, 입력은 draft에 그대로 둔다.
  const markForgotten = useCallback(() => {
    if (!theaterRef.current || forgottenRef.current) return;
    forgottenRef.current = true;
    clearTimer();
    ++openIdRef.current;
    fetchControllerRef.current?.abort();
    setLoading(false);
    setUndo(null);
    setCopied(false);
    setForgotten(true);
  }, [clearTimer]);

  const persist = useCallback((theaterId: string, next: TheaterSystemPrompt, keepDraft = false) => {
    if (next.body.length > CLAUDE_CODE_CUSTOM_SYSTEM_PROMPT_MAX_CHARS) {
      overLimitDrafts.set(theaterId, next);
      setStatus("over");
      return;
    }
    if (forgottenRef.current) return;
    const keptDraft = overLimitDrafts.get(theaterId);
    const value = next.mode === "on" && !next.body.trim() ? null : next;
    dirtyRef.current = false;
    setStatus("saving");
    const revision = ++revisionRef.current;
    promptQueue = promptQueue.catch(() => undefined).then(async () => {
      try {
        const saved = (await saveTheaterSystemPrompt(theaterId, value)).prompt;
        announce(theaterId, saved);
        // 앞선 정상 저장이 끝나는 사이 새 긴 초안이 생겼다면 그것까지 지우지 않는다.
        if (!keepDraft && overLimitDrafts.get(theaterId) === keptDraft) overLimitDrafts.delete(theaterId);
        if (theaterRef.current?.id === theaterId && revision === revisionRef.current) {
          storedRef.current = saved;
          setStored(saved);
          setStatus(draftRef.current.body.length > CLAUDE_CODE_CUSTOM_SYSTEM_PROMPT_MAX_CHARS ? "over" : "saved");
        }
      } catch (error) {
        if (theaterRef.current?.id === theaterId && revision === revisionRef.current) {
          // 방송을 놓친 경우(끊긴 스트림)에도 저장이 404로 알려 준다 — 같은 잊힘 상태로 보인다.
          if ((error as { status?: number }).status === 404) { dirtyRef.current = true; markForgotten(); }
          else { dirtyRef.current = true; setStatus("error"); }
        }
      }
    });
  }, [markForgotten]);

  const flush = useCallback(() => {
    clearTimer();
    const current = theaterRef.current;
    if (current && dirtyRef.current) persist(current.id, draftRef.current);
  }, [clearTimer, persist]);

  const theaterId = theater?.id ?? null;
  useEffect(() => {
    const next = theater;
    theaterRef.current = next;
    if (!next) return;
    const openId = ++openIdRef.current;
    revisionRef.current++;
    dirtyRef.current = false;
    forgottenRef.current = false;
    loadedRef.current = false;
    focusAfterReset.current = null;
    storedRef.current = null;
    draftRef.current = { mode: "on", body: "" };
    setStored(null);
    setDraft(draftRef.current);
    setUndo(null);
    setForgotten(false);
    setCopied(false);
    setStatus("untouched");
    setLoadFailed(false);
    setLoading(true);
    const controller = new AbortController();
    fetchControllerRef.current = controller;
    void promptQueue.catch(() => undefined).then(() => {
      if (controller.signal.aborted) return null;
      return fetchTheaterSystemPrompt(next.id, controller.signal);
    }).then((result) => {
      if (openIdRef.current !== openId) return;
      if (!result || controller.signal.aborted) { setLoading(false); setLoadFailed(true); return; }
      const { prompt } = result;
      loadedRef.current = true;
      storedRef.current = prompt;
      // 대기 저장이 끝난 뒤의 초안을 읽는다. 느린 GET과 앞선 저장값은 탭에 남긴 글을 덮지 않는다.
      const keptDraft = overLimitDrafts.get(next.id);
      draftRef.current = keptDraft ?? prompt ?? { mode: "on", body: "" };
      dirtyRef.current = !!keptDraft;
      setStored(prompt);
      setDraft(draftRef.current);
      if (keptDraft) setStatus("over");
      setLoading(false);
    }).catch((error) => {
      if (openIdRef.current !== openId) return;
      if ((error as { status?: number }).status === 404) {
        ++openIdRef.current;
        theaterRef.current = null;
        announceTheaterSystemPromptForgotten(next.label);
        optionsRef.current.onMissing(next);
      } else { setLoading(false); setLoadFailed(true); }
    });
    // 다른 Theater 로 바뀌거나 닫히면, 앞 Theater 의 입력부터 확정한다. 그 뒤의 응답은 이 칸을 고치지 않는다.
    return () => {
      ++openIdRef.current;
      controller.abort();
      flush();
      theaterRef.current = null;
      forgottenRef.current = false;
    };
    // theater 객체가 아니라 id 로 다시 읽는다 — 목록이 새로 읽혀 같은 Theater 의 객체만 바뀐 경우는 그대로다.
  }, [theaterId, reopenKey, reload, flush]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => clearTimer(), [clearTimer]);

  useEffect(() => {
    if (!theater || theaterRef.current?.id !== theater.id) return;
    if (registeredLabel === null) { markForgotten(); return; }
    if (!forgottenRef.current) return;
    // Theater가 되돌아왔다. 저장하지 못한 입력이 있으면 그것을 이어서 저장하고, 없으면 서버 값을 다시 읽는다 —
    // 유예 안의 되돌리기는 값도 함께 되살리지만, 만료 뒤 다시 등록된 Theater에는 옛 값이 없다.
    forgottenRef.current = false;
    setForgotten(false);
    const saved = storedRef.current ?? { mode: "on", body: "" };
    const draftNow = draftRef.current;
    if (loadedRef.current && (dirtyRef.current || draftNow.mode !== saved.mode || draftNow.body !== saved.body)) persist(theater.id, draftNow);
    else setReload((value) => value + 1);
  }, [theater, registeredLabel, markForgotten, persist]);

  const changeMode = (mode: ClaudeCodeSystemPromptMode) => {
    const current = theaterRef.current;
    if (!current) return;
    clearTimer();
    const next = { ...draftRef.current, mode };
    draftRef.current = next;
    setDraft(next);
    setUndo(null);
    setCopied(false);
    if (next.mode === "on" && next.body.length > CLAUDE_CODE_CUSTOM_SYSTEM_PROMPT_MAX_CHARS) {
      // 기본 모드로 돌아가도 긴 글은 버리지 않는다. 서버에는 마지막 정상 본문과 모드만 저장한다.
      overLimitDrafts.set(current.id, next);
      persist(current.id, { mode: "on", body: storedRef.current?.body ?? "" }, true);
    } else if (next.mode === "off" && !next.body.trim()) {
      // 빈 「내 지침만」은 시스템 프롬프트 없이 띄우는 값이다. 방향키로 이 줄을 지나가기만 해도 저장되면 그 사이 뜬 세션이
      // 이 값을 싣는다 — 잠깐 머문 뒤에만 저장하고, 다른 모드로 옮기면 이 대기 저장은 위 clearTimer 가 버린다.
      // 닫기·Theater 전환은 flush 가 확정한다.
      dirtyRef.current = true;
      setStatus("saving");
      timerRef.current = setTimeout(() => persist(current.id, draftRef.current), EMPTY_OFF_SETTLE_MS);
    } else persist(current.id, next);
  };
  const changeBody = (body: string) => {
    const current = theaterRef.current;
    if (!current) return;
    const next = { ...draftRef.current, body };
    draftRef.current = next;
    dirtyRef.current = true;
    setDraft(next);
    setUndo(null);
    setCopied(false);
    clearTimer();
    if (body.length > CLAUDE_CODE_CUSTOM_SYSTEM_PROMPT_MAX_CHARS) {
      overLimitDrafts.set(current.id, next);
      setStatus("over");
      return;
    }
    setStatus("idle");
    timerRef.current = setTimeout(() => persist(current.id, draftRef.current), 1000);
  };
  const reset = () => {
    const current = theaterRef.current;
    if (!current) return;
    clearTimer();
    overLimitDrafts.delete(current.id);
    setUndo(storedRef.current);
    const empty = { mode: "on" as const, body: "" };
    draftRef.current = empty;
    setDraft(empty);
    focusAfterReset.current = "undo";
    persist(current.id, empty);
  };
  const restore = () => {
    const current = theaterRef.current;
    if (!undo || !current) return;
    draftRef.current = undo;
    setDraft(undo);
    persist(current.id, undo);
    focusAfterReset.current = "select";
    setUndo(null);
  };
  const copyDraft = (selectFallback: () => void) => {
    const text = draftRef.current.body;
    // 클립보드 권한이 없으면 글을 선택해 두어 직접 복사할 수 있게 한다.
    if (!navigator.clipboard?.writeText) { selectFallback(); return; }
    void navigator.clipboard.writeText(text).then(() => setCopied(true), selectFallback);
  };
  const discardDraft = () => {
    const current = theaterRef.current;
    if (current) overLimitDrafts.delete(current.id);
    clearTimer();
    dirtyRef.current = false;
    draftRef.current = storedRef.current ?? { mode: "on", body: "" };
    setDraft(draftRef.current);
    setStatus("untouched");
    optionsRef.current.onDiscarded();
  };
  const saved = stored ?? { mode: "on" as const, body: "" };
  const unsaved = forgotten && (draft.mode !== saved.mode || draft.body !== saved.body);
  return { theater, stored, draft, loading, loadFailed, status, undo, forgotten, unsaved, copied, focusAfterReset, changeMode, changeBody, reset, restore, copyDraft, discardDraft, flush };
}

/**
 * 모드마다 모델에 무엇이 실리는지 — 고르기 전에 결과가 읽히도록 데스크톱 칸과 폰 시트가 모드 줄마다 이 문장을 붙인다.
 * 본문이 비었을 때의 결과는 고른 줄 아래 따로 선다(`useTheaterPromptEmptyNotice`).
 */
export function useTheaterPromptModeDescriptions(mobile = false): Record<ClaudeCodeSystemPromptMode, string> {
  const t = useT(mobile);
  return { on: t("sidebar.theater.prompt.captionOn"), append: t("sidebar.theater.prompt.captionAppend"), off: t("sidebar.theater.prompt.captionOff") };
}

/** 본문을 쓰는 모드인데 지침이 비었을 때만 서는 안내. 「내 지침만」이면 시스템 프롬프트 없이 뜨므로 그리는 쪽이 경고로 세운다. */
export function useTheaterPromptEmptyNotice(draft: TheaterSystemPrompt): string | null {
  const t = useT();
  if (draft.mode === "on" || draft.body.trim()) return null;
  return t(draft.mode === "append" ? "sidebar.theater.prompt.captionEmpty" : "sidebar.theater.prompt.captionOffEmpty");
}

/** 한도의 90%부터 글자 수가 경고 쪽으로 선다 — 넘기 전에 남은 여유가 보이게. */
export function isNearPromptLimit(draft: TheaterSystemPrompt): boolean {
  return !isOverPromptLimit(draft) && draft.body.length >= CLAUDE_CODE_CUSTOM_SYSTEM_PROMPT_MAX_CHARS * 0.9;
}

export function useTheaterPromptModeNames(mobile = false): Record<ClaudeCodeSystemPromptMode, string> {
  const t = useT(mobile);
  return { on: t("sidebar.theater.prompt.modeOn"), append: t("sidebar.theater.prompt.modeAppend"), off: t("sidebar.theater.prompt.modeOff") };
}

export function isOverPromptLimit(draft: TheaterSystemPrompt): boolean {
  return draft.body.length > CLAUDE_CODE_CUSTOM_SYSTEM_PROMPT_MAX_CHARS;
}

/**
 * Theater의 서브에이전트 — 켜져 있으면(기본) 서브에이전트 호출 자리에 Objectives 구성원이 선다. 프롬프트와 달리
 * Console이 호출마다 읽으므로 실행 중인 세션도 다음 호출부터 따른다. 저장은 누르는 즉시이며, 실패하면 되돌린다.
 * 데스크톱 Theater Inbox 는 이 칸을 따로 세우고(`titled` 없음 — 칸 제목이 대신한다), 폰 시트는 프롬프트 아래에 붙인다.
 */
export function TheaterSubagentsSection({ theaterId, mobile = false, titled = true }: { readonly theaterId: string; readonly mobile?: boolean; readonly titled?: boolean }) {
  const t = useT(mobile);
  const [replaced, setReplaced] = useState<boolean | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "saving" | "loadFailed" | "saveFailed">("loading");
  const revisionRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    setState("loading");
    void fetchTheaterSubagents(theaterId, controller.signal).then((result) => {
      setReplaced(!result.subagentsKept);
      setState("ready");
    }, () => { if (!controller.signal.aborted) setState("loadFailed"); });
    return () => controller.abort();
  }, [theaterId]);

  const change = (next: boolean) => {
    const previous = replaced;
    const revision = ++revisionRef.current;
    setReplaced(next);
    setState("saving");
    void saveTheaterSubagents(theaterId, !next).then((result) => {
      if (revision !== revisionRef.current) return;
      setReplaced(!result.subagentsKept);
      setState("ready");
    }, () => {
      if (revision !== revisionRef.current) return;
      setReplaced(previous);
      setState("saveFailed");
    });
  };

  if (mobile) {
    return state === "loading" ? <p className="settings-mobile-note" role="status">{t("sidebar.theater.prompt.loading")}</p>
      : state === "loadFailed" ? <p className="settings-mobile-note is-error" role="alert">{t("sidebar.theater.subagents.loadFailed")}</p>
        : <>
          <SettingsCard>
            <SettingsRow label={t("sidebar.theater.subagents.toggle")} hint={t(replaced ? "sidebar.theater.subagents.on" : "sidebar.theater.subagents.off")}>
              <SettingsToggle checked={replaced === true} busy={state === "saving"} ariaLabel={t("sidebar.theater.subagents.toggle")} onChange={change} />
            </SettingsRow>
          </SettingsCard>
          {state === "saveFailed" ? <p className="settings-mobile-note is-error" role="alert">{t("sidebar.theater.subagents.saveFailed")}</p> : null}
        </>;
  }
  return (
    <div className="theater-subagents" role="group" aria-labelledby={titled ? "theater-subagents-title" : undefined} aria-label={titled ? undefined : t("sidebar.theater.subagents.title")}>
      {titled ? <strong id="theater-subagents-title">{t("sidebar.theater.subagents.title")}</strong> : null}
      {state === "loading" ? <p role="status">{t("sidebar.theater.prompt.loading")}</p>
        : state === "loadFailed" ? <p className="theater-prompt-save is-error" role="alert">{t("sidebar.theater.subagents.loadFailed")}</p>
          : <>
            <SettingsToggle checked={replaced === true} busy={state === "saving"} label={t("sidebar.theater.subagents.toggle")} onChange={change} />
            <p className="theater-prompt-caption">{t(replaced ? "sidebar.theater.subagents.on" : "sidebar.theater.subagents.off")}</p>
            {state === "saveFailed" ? <p className="theater-prompt-save is-error" role="alert">{t("sidebar.theater.subagents.saveFailed")}</p> : null}
          </>}
    </div>
  );
}

/** 초기화·되돌리기 뒤 포커스를 옮긴다 — 데스크톱 칸과 폰 시트가 각자 자기 단추로. */
export function useFocusAfterReset(controller: TheaterPromptController, targets: { readonly undo: () => HTMLElement | null; readonly select: () => HTMLElement | null }): void {
  useLayoutEffect(() => {
    const next = controller.focusAfterReset.current;
    if (!next) return;
    (next === "undo" ? targets.undo() : targets.select())?.focus();
    controller.focusAfterReset.current = null;
  });
}
