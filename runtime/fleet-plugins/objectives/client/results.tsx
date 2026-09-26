import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";

import { renderMarkdown } from "@fleet-console/markdown/core";
import "@fleet-console/markdown/styles.css";
import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";

import type { Objective, ObjectiveResult, PrObservation } from "../server/types.js";
import { AttachmentView } from "./attachments.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";

/**
 * 결과물 — 달성 기준 바로 아래, 모든 상태에서 같은 자리. 증거(이미지 썸네일·문서)가 먼저 서고 PR 이 뒤따른다.
 * 사람은 읽기만 한다 — 붙이고 고치는 것은 지휘관의 도구다. PR 상태는 서버의 관측을 그대로 옮기고, 조회 실패는 마지막 성공보다
 * 앞선 주 상태다(마지막 성공은 보조 줄). 파일은 목표·결과물 id 로 받아 온다 — 경로는 브라우저에 오지 않는다.
 */

type T = Translate<ObjectiveMessageKey>;
type PrResult = Extract<ObjectiveResult, { kind: "pr" }>;
type EvidenceResult = Extract<ObjectiveResult, { kind: "evidence" }>;
type PrState = PrObservation["state"];
type PrErrorCode = Extract<PrObservation, { state: "error" }>["error"]["code"];

const STATE_KEYS: Readonly<Record<PrState, ObjectiveMessageKey>> = {
  unchecked: "objectives.results.pr.unchecked",
  open: "objectives.results.pr.open",
  merged: "objectives.results.pr.merged",
  closed: "objectives.results.pr.closed",
  error: "objectives.results.pr.error",
};
const ERROR_KEYS: Readonly<Record<PrErrorCode, ObjectiveMessageKey>> = {
  gh_unavailable: "objectives.results.err.gh_unavailable",
  auth_required: "objectives.results.err.auth_required",
  forbidden: "objectives.results.err.forbidden",
  not_found_or_forbidden: "objectives.results.err.not_found_or_forbidden",
  rate_limited: "objectives.results.err.rate_limited",
  timeout: "objectives.results.err.timeout",
  network: "objectives.results.err.network",
  invalid_response: "objectives.results.err.invalid_response",
  lookup_failed: "objectives.results.err.lookup_failed",
};

/** 파일은 목표·결과물 id 로 받는다. 같은 결과물의 증거가 새 복사본으로 교체되면 evidenceId 가 바뀌므로 그 값을 버전으로 붙여
 *  이미 그려진 썸네일·열린 보기가 옛 파일을 붙들지 않게 한다(서버는 v 를 권한에 쓰지 않고 그 결과물의 현재 파일만 준다). */
export const resultFileUrl = (objectiveId: string, result: Pick<EvidenceResult, "id" | "evidenceId">) => `/plugins/objectives/result/file?objectiveId=${encodeURIComponent(objectiveId)}&resultId=${encodeURIComponent(result.id)}&v=${encodeURIComponent(result.evidenceId)}`;

/** 상대 시각이 낡지 않게 — 30초마다 다시 그린다. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function relative(at: number, now: number, language: ConsoleLocale): string {
  const format = new Intl.RelativeTimeFormat(language, { numeric: "always", style: "short" });
  const seconds = Math.round((at - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(Math.min(seconds, -1), "second");
  if (abs < 3600) return format.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), "hour");
  return format.format(Math.round(seconds / 86_400), "day");
}

const absolute = (at: number, language: ConsoleLocale) => new Date(at).toLocaleString(language, { hour12: false });

function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const extension = (name: string) => name.slice(name.lastIndexOf(".") + 1).toLowerCase();

/** 머리 오른쪽 — 개수, 접혔을 때 조회 실패가 있으면 그 사실도. 결과물이 없으면 「없음」만. */
export function ResultsHeadTools({ objective, t, expanded }: { readonly objective: Objective; readonly t: T; readonly expanded: boolean }) {
  const results = objective.results;
  if (results.length === 0) return <span className="objectives-criteria-count">{t("objectives.results.none")}</span>;
  const failed = results.some((result) => result.kind === "pr" && result.observation.state === "error");
  return <>
    {!expanded && failed ? <span className="objectives-result-state is-error"><i aria-hidden="true" />{t("objectives.results.prFailed")}</span> : null}
    <span className="objectives-criteria-count">{t("objectives.results.count", { count: results.length })}</span>
  </>;
}

export function ObjectiveResults({ objective, t, language }: { readonly objective: Objective; readonly t: T; readonly language: ConsoleLocale }) {
  const now = useNow();
  // 열린 보기는 결과물 id 로만 기억한다 — 교체되면 지금 객체(새 파일·형식)를 다시 고르고, 떼어지면 닫힌다.
  const [viewingId, setViewingId] = useState<string | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const evidence = objective.results.filter((result): result is EvidenceResult => result.kind === "evidence");
  const prs = objective.results.filter((result): result is PrResult => result.kind === "pr");
  const images = evidence.filter((result) => result.mediaType !== "text/plain");
  const texts = evidence.filter((result) => result.mediaType === "text/plain");
  const missionTag = (missionId: string | undefined) => {
    const index = missionId ? objective.missions.findIndex((mission) => mission.id === missionId) : -1;
    return index >= 0 ? ` · ${t("objectives.results.mission", { n: index + 1 })}` : "";
  };
  const uploaded = (result: EvidenceResult) => t("objectives.results.uploaded", { ago: relative(result.capturedAt, now, language) });
  const open = (result: EvidenceResult, opener: HTMLButtonElement) => { openerRef.current = opener; setViewingId(result.id); };
  const close = () => { setViewingId(null); openerRef.current?.focus(); };
  const viewingLive = viewingId ? evidence.find((result) => result.id === viewingId) ?? null : null;

  return (
    <div className="objectives-results">
      {evidence.length ? <div className="objectives-results-kind">{t("objectives.results.evidence", { count: evidence.length })}</div> : null}
      {images.length ? (
        <div className="objectives-result-strip">
          {images.map((result) => {
            const title = result.label ?? result.name;
            return (
              <button key={result.id} type="button" className="objectives-result-thumb" aria-label={t("objectives.results.zoom", { name: title })} title={`${result.name}${result.width && result.height ? ` · ${result.width}×${result.height}` : ""} · ${uploaded(result)}`} onClick={(event) => open(result, event.currentTarget)}>
                <span className="objectives-result-img"><img src={resultFileUrl(objective.id, result)} alt="" loading="lazy" draggable={false} /></span>
                <span className="objectives-result-name">{title}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {texts.map((result) => (
        <button key={result.id} type="button" className="objectives-result-row is-button" aria-label={t("objectives.results.openAria", { name: result.label ?? result.name })} onClick={(event) => open(result, event.currentTarget)}>
          <span className="objectives-row-ic"><DocGlyph /></span>
          <span className="objectives-result-body">
            <span className="objectives-result-title is-mono">{result.label ?? result.name}</span>
            <span className="objectives-result-sub">
              {result.label ? `${result.name} · ` : ""}{t("objectives.results.text", { size: bytesLabel(result.bytes) })} · <time dateTime={new Date(result.capturedAt).toISOString()} title={absolute(result.capturedAt, language)}>{uploaded(result)}</time>{missionTag(result.sourceMissionId)}
            </span>
            {result.note ? <span className="objectives-result-sub">{result.note}</span> : null}
          </span>
          <span className="objectives-result-open" aria-hidden="true">{t("objectives.results.open")}</span>
        </button>
      ))}
      {prs.length ? <div className="objectives-results-kind">{t("objectives.results.prs")}</div> : null}
      {prs.map((result) => <PrRow key={result.id} result={result} t={t} language={language} now={now} missionTag={missionTag(result.sourceMissionId)} />)}
      {viewingLive ? createPortal(
        viewingLive.mediaType === "text/plain"
          ? <EvidenceTextView t={t} src={resultFileUrl(objective.id, viewingLive)} name={viewingLive.name} caption={`${viewingLive.name} · ${bytesLabel(viewingLive.bytes)} · ${uploaded(viewingLive)}`} onClose={close} />
          : <AttachmentView t={t} src={resultFileUrl(objective.id, viewingLive)} caption={`${viewingLive.name}${viewingLive.width && viewingLive.height ? ` · ${viewingLive.width}×${viewingLive.height}` : ""} · ${uploaded(viewingLive)}`} onClose={close} />,
        document.body,
      ) : null}
    </div>
  );
}

function PrRow({ result, t, language, now, missionTag }: { readonly result: PrResult; readonly t: T; readonly language: ConsoleLocale; readonly now: number; readonly missionTag: string }) {
  const observation = result.observation;
  const ago = (time: number) => relative(time, now, language);
  const repository = `${result.owner}/${result.repo}`;
  // 제목 — 지휘관이 붙인 label, 없으면 GitHub 에서 확인한 PR 제목(조회 실패 때도 이전 제목이 남는다), 둘 다 없으면 저장소.
  const title = result.label ?? observation.title;
  const word = (state: PrState) => t(STATE_KEYS[state]);
  // 조회 실패가 주 상태다 — 오래됨 표시는 성공한 관측에만 붙는다. 시각에 올리면 절대 시각이 뜬다.
  const stale = observation.stale && observation.state !== "error" && observation.state !== "unchecked";
  const previous = observation.lastSuccess;
  let lines;
  if (observation.state === "unchecked") {
    lines = <>
      <span className="objectives-result-sub">{t("objectives.results.pr.never")}</span>
      {previous ? <span className="objectives-result-sub" title={absolute(previous.checkedAt, language)}>{t("objectives.results.pr.previous", { state: word(previous.state), ago: ago(previous.checkedAt) })}</span> : null}
    </>;
  } else if (observation.state === "error") {
    lines = <>
      <span className="objectives-result-sub is-error" title={absolute(observation.checkedAt, language)}>{t(ERROR_KEYS[observation.error.code])} · {t("objectives.results.pr.tried", { ago: ago(observation.checkedAt) })}</span>
      {previous
        ? <span className="objectives-result-sub" title={absolute(previous.checkedAt, language)}>{t("objectives.results.pr.last", { state: word(previous.state), ago: ago(previous.checkedAt) })}</span>
        : <span className="objectives-result-sub">{t("objectives.results.pr.noSuccess")}</span>}
    </>;
  } else {
    lines = <span className="objectives-result-sub" title={absolute(observation.checkedAt, language)}>{t("objectives.results.pr.checked", { ago: ago(observation.checkedAt) })}{stale ? <span className="objectives-result-stale"> · {t("objectives.results.pr.stale")}</span> : null}</span>;
  }
  return (
    <div className="objectives-result-row">
      <span className="objectives-row-ic"><PrGlyph /></span>
      <span className="objectives-result-body">
        <a className="objectives-result-title" href={result.url} target="_blank" rel="noreferrer noopener"><span className="objectives-result-num">#{result.number}</span>{title ?? repository}</a>
        {/* 제목 자리에 저장소가 섰으면 보조 줄에서 다시 말하지 않는다. */}
        {title ? <span className="objectives-result-sub"><span className="is-mono">{repository}</span>{missionTag}</span>
          : missionTag ? <span className="objectives-result-sub">{missionTag.replace(/^ · /, "")}</span> : null}
        {result.note ? <span className="objectives-result-sub">{result.note}</span> : null}
        {lines}
      </span>
      <span className={`objectives-result-state is-${observation.state}${stale ? " is-stale" : ""}`}><i aria-hidden="true" />{word(observation.state)}</span>
    </div>
  );
}

/** 링크는 http(s)·mailto·# 만 살리고, 이미지는 불러오지 않는다 — 증거 문서가 브라우저에 다른 곳의 자원을 부르게 두지 않는다. */
function neutralizeUntrustedDom(root: ParentNode): void {
  for (const anchor of root.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href") ?? "";
    if (href && !/^(https?:|mailto:|#)/i.test(href)) {
      anchor.removeAttribute("href");
      anchor.setAttribute("role", "link");
      anchor.setAttribute("aria-disabled", "true");
    }
  }
  for (const element of root.querySelectorAll("img[src], img[srcset], source[src], source[srcset]")) {
    element.removeAttribute("src");
    element.removeAttribute("srcset");
    if (element.tagName === "IMG") element.setAttribute("aria-hidden", "true");
  }
}

/** Markdown 은 렌더하고, 그 밖의 텍스트(LOG·JSON·TXT)는 원문 그대로 코드 블록으로 감싼다. 울타리는 본문의 가장 긴 backtick 보다 길게. */
function asMarkdown(name: string, text: string): string {
  const ext = extension(name);
  if (ext === "md" || ext === "markdown") return text;
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${ext === "json" ? "json" : "text"}\n${text}\n${fence}`;
}

function EvidenceTextView({ t, src, name, caption, onClose }: { readonly t: T; readonly src: string; readonly name: string; readonly caption: string; readonly onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [loaded, setLoaded] = useState<{ readonly text: string } | { readonly error: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(null);
    fetch(src, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const code = ((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? `http_${response.status}`;
          setLoaded({ error: code });
          return;
        }
        setLoaded({ text: await response.text() });
      })
      .catch(() => { if (!controller.signal.aborted) setLoaded({ error: "network" }); });
    return () => controller.abort();
  }, [src]);
  const html = useMemo(() => {
    if (!loaded || !("text" in loaded)) return "";
    const rendered = renderMarkdown(asMarkdown(name, loaded.text), { copyLabel: t("objectives.results.copy"), copyAriaLabel: (language) => t("objectives.results.copyCode", { language }) }).html;
    const doc = new DOMParser().parseFromString(rendered, "text/html");
    neutralizeUntrustedDom(doc.body);
    return doc.body.innerHTML;
  }, [loaded, name, t]);
  useEffect(() => { closeRef.current?.focus(); }, []);
  useEffect(() => {
    const root = bodyRef.current;
    if (!root || !html) return;
    neutralizeUntrustedDom(root);
    const observer = new MutationObserver(() => neutralizeUntrustedDom(root));
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "src", "srcset"] });
    return () => observer.disconnect();
  }, [html]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCloseRef.current(); return; }
      if (event.key !== "Tab") return;
      // 초점은 이 보기 안에서만 돈다 — 닫기 글리프와 본문(스크롤·링크·복사) 사이.
      const focusables = [...(closeRef.current?.closest("[role=dialog]")?.querySelectorAll<HTMLElement>("button, a[href], [tabindex='0']") ?? [])];
      if (focusables.length === 0) return;
      const index = focusables.indexOf(document.activeElement as HTMLElement);
      const next = focusables[(index + (event.shiftKey ? -1 : 1) + focusables.length) % focusables.length]!;
      event.preventDefault();
      next.focus();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  const onCopy = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action="copy-code"]');
    const code = button?.closest("pre")?.getAttribute("data-code");
    if (!button || !code) return;
    void navigator.clipboard?.writeText(code).then(() => {
      const original = button.textContent;
      button.textContent = t("objectives.results.copied");
      window.setTimeout(() => { button.textContent = original; }, 1200);
    }, () => undefined);
  }, [t]);
  return (
    <div className="objectives-zoom-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <figure className="objectives-att-view objectives-result-textview" role="dialog" aria-modal="true" aria-label={caption}>
        <button ref={closeRef} type="button" className="objectives-att-view-close" aria-label={t("objectives.detail.close")} title={t("objectives.detail.close")} onClick={onClose}><CloseGlyph /></button>
        {loaded === null ? <div className="objectives-result-textstate" role="status">{t("objectives.results.loading")}</div>
          : "error" in loaded ? <div className="objectives-result-textstate is-error" role="alert">{t("objectives.results.loadFailed", { code: loaded.error })}</div>
          : <div ref={bodyRef} className="markdown-body objectives-result-markdown" tabIndex={0} onClick={onCopy} dangerouslySetInnerHTML={{ __html: html }} />}
        <figcaption>{caption}</figcaption>
      </figure>
    </div>
  );
}

const CloseGlyph = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>;
/** 결과물 구획 머리 — 상자에 담긴 산출물. */
export const ResultsGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 5.2 8 2.5l5.5 2.7v5.6L8 13.5l-5.5-2.7z" /><path d="M2.5 5.2 8 7.9l5.5-2.7M8 7.9v5.6" /></svg>;
const PrGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="4.5" cy="3.8" r="1.6" /><circle cx="4.5" cy="12.2" r="1.6" /><circle cx="11.5" cy="12.2" r="1.6" /><path d="M4.5 5.4v5.2M11.5 10.6V6.5a2 2 0 0 0-2-2H7.5M9 3l-1.5 1.5L9 6" /></svg>;
const DocGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.5 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V5.5z" /><path d="M9.5 2v3.5H13M5.8 8.5h4.4M5.8 11h3" /></svg>;
