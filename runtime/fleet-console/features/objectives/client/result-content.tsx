import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { renderMarkdown } from "@fleet-console/markdown/core";
import { installDiagramHydrator } from "@fleet-console/markdown/mermaid";
import "@fleet-console/markdown/styles.css";
import type { ConsoleLocale, Translate } from "@fleet-console/i18n";
import type { ObjectiveResult, PrObservation } from "../shared/types.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";
import { LinkText } from "./link-text.js";

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
export const resultFileUrl = (objectiveId: string, result: Pick<EvidenceResult, "id" | "evidenceId">) => `/api/v1/objectives/result/file?objectiveId=${encodeURIComponent(objectiveId)}&resultId=${encodeURIComponent(result.id)}&v=${encodeURIComponent(result.evidenceId)}`;

/** 상대 시각이 낡지 않게 — 30초마다 다시 그린다. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function relative(at: number, now: number, language: ConsoleLocale): string {
  const format = new Intl.RelativeTimeFormat(language, { numeric: "always", style: "short" });
  const seconds = Math.round((at - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(Math.min(seconds, -1), "second");
  if (abs < 3600) return format.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), "hour");
  return format.format(Math.round(seconds / 86_400), "day");
}

export const absolute = (at: number, language: ConsoleLocale) => new Date(at).toLocaleString(language, { hour12: false });

export function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const extension = (name: string) => name.slice(name.lastIndexOf(".") + 1).toLowerCase();

export function PrRow({ result, t, language, now, missionTag, onView }: { readonly result: PrResult; readonly t: T; readonly language: ConsoleLocale; readonly now: number; readonly missionTag: string; readonly onView?: (opener: HTMLButtonElement) => void }) {
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
    // 장부 행은 결과물 창으로, 창 안의 카드는 PR로 간다. 링크·텍스트 선택은 가로채지 않는다.
    <div className="objectives-result-row is-button" onClick={(event) => {
      if (event.target instanceof Element && event.target.closest("a") || window.getSelection()?.toString()) return;
      if (onView) event.currentTarget.querySelector<HTMLButtonElement>("button.objectives-result-open")?.click();
      else event.currentTarget.querySelector<HTMLAnchorElement>("a.objectives-result-title")?.click();
    }}>
      <span className="objectives-row-ic"><PrGlyph /></span>
      <span className="objectives-result-body">
        <a className="objectives-result-title" href={result.url} target="_blank" rel="noreferrer noopener"><span className="objectives-result-num">#{result.number}</span>{title ?? repository}</a>
        {/* 제목 자리에 저장소가 섰으면 보조 줄에서 다시 말하지 않는다. */}
        {title ? <span className="objectives-result-sub"><span className="is-mono">{repository}</span>{missionTag}</span>
          : missionTag ? <span className="objectives-result-sub">{missionTag.replace(/^ · /, "")}</span> : null}
        {result.note ? <span className="objectives-result-sub"><LinkText text={result.note} /></span> : null}
        {lines}
      </span>
      <span className={`objectives-result-state is-${observation.state}${stale ? " is-stale" : ""}`}><i aria-hidden="true" />{word(observation.state)}</span>
      {onView ? <button type="button" className="objectives-result-open" aria-label={t("objectives.results.openAria", { name: title ?? repository })} onClick={(event) => { event.stopPropagation(); onView(event.currentTarget); }}>{t("objectives.results.open")}</button> : null}
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

/**
 * 보기 방식 — Markdown 은 렌더하고, JSON 은 등록된 json 강조의 코드 블록, 그 밖(LOG·TXT)은 평문 그대로.
 * 등록되지 않은 언어는 자동 감지 강조로 떨어지므로 LOG·TXT 는 렌더러를 거치지 않는다.
 */
function textMode(name: string): "markdown" | "json" | "plain" {
  const ext = extension(name);
  return ext === "md" || ext === "markdown" ? "markdown" : ext === "json" ? "json" : "plain";
}

/** JSON 을 코드 블록으로 감싼다 — 울타리는 본문의 가장 긴 backtick 보다 길게. */
function fencedJson(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}json\n${text}\n${fence}`;
}

export function EvidenceTextContent({ t, src, name }: { readonly t: T; readonly src: string; readonly name: string }) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
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
  const mode = textMode(name);
  const html = useMemo(() => {
    if (!loaded || !("text" in loaded) || mode === "plain") return "";
    const rendered = renderMarkdown(mode === "json" ? fencedJson(loaded.text) : loaded.text, { copyLabel: t("objectives.results.copy"), copyAriaLabel: (language) => t("objectives.results.copyCode", { language }) }).html;
    const doc = new DOMParser().parseFromString(rendered, "text/html");
    neutralizeUntrustedDom(doc.body);
    return doc.body.innerHTML;
  }, [loaded, mode, t]);
  useEffect(() => {
    const root = bodyRef.current;
    if (!root || !html) return;
    neutralizeUntrustedDom(root);
    const observer = new MutationObserver(() => neutralizeUntrustedDom(root));
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "src", "srcset"] });
    installDiagramHydrator(root, {
      renderFailed: (message) => t("objectives.results.diagram.failed", { message }),
      openExpandedAria: t("objectives.results.diagram.open"),
      lightboxTitle: t("objectives.results.diagram.title"),
      close: t("objectives.detail.close"),
      closeExpandedAria: t("objectives.results.diagram.close"),
      zoomControlsAria: t("objectives.results.diagram.zoomControls"),
      zoomOutAria: t("objectives.results.diagram.zoomOut"),
      zoomInAria: t("objectives.results.diagram.zoomIn"),
      fit: t("objectives.results.diagram.fit"),
      fitAria: t("objectives.results.diagram.fitAria"),
      reset: t("objectives.results.diagram.reset"),
      resetAria: t("objectives.results.diagram.resetAria"),
    });
    return () => observer.disconnect();
  }, [html, t]);
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
  return loaded === null ? <div className="objectives-result-textstate" role="status">{t("objectives.results.loading")}</div>
    : "error" in loaded ? <div className="objectives-result-textstate is-error" role="alert">{t("objectives.results.loadFailed", { code: loaded.error })}</div>
    : mode === "plain" ? <div className="markdown-body objectives-result-markdown" tabIndex={0}><pre className="objectives-result-plain"><code>{loaded.text}</code></pre></div>
    : <div ref={bodyRef} className="markdown-body objectives-result-markdown" tabIndex={0} onClick={onCopy} dangerouslySetInnerHTML={{ __html: html }} />;
}

const PrGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="4.5" cy="3.8" r="1.6" /><circle cx="4.5" cy="12.2" r="1.6" /><circle cx="11.5" cy="12.2" r="1.6" /><path d="M4.5 5.4v5.2M11.5 10.6V6.5a2 2 0 0 0-2-2H7.5M9 3l-1.5 1.5L9 6" /></svg>;
