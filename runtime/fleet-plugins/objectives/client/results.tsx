import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";

import { renderMarkdown } from "@fleet-console/markdown/core";
import { installDiagramHydrator } from "@fleet-console/markdown/mermaid";
import "@fleet-console/markdown/styles.css";
import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";

import type { Objective, ObjectiveMission, ObjectiveResult, PrObservation } from "../server/types.js";
import { AttachmentView } from "./attachments.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";
import { LinkText } from "./link-text.js";

/**
 * 결과물 장부 — 임무 순서의 현재 결과물과 마지막 기록 한 줄. 임무 밖 연결도 끝 묶음에서 읽는다.
 * 사람은 읽기만 한다 — 붙이고 고치는 것은 지휘관의 도구다. 파일은 목표·결과물 id 로 받으며 PR 상태는 서버 관측 그대로다.
 * Artifact는 외부 링크만 열고 사본·미리보기·관측을 만들지 않는다. 기록 회차별 결과물 이력은 아니다.
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

export const resultGroupKey = (objectiveId: string, missionId: string = "loose") => `result:${objectiveId}:${missionId}`;

export function ObjectiveResults({ objective, t, language, onShowMission, highlightMission, groupOpen, onToggleGroup }: {
  readonly objective: Objective; readonly t: T; readonly language: ConsoleLocale;
  /** 그래프로 가는 ↗ — 그래프가 없는 자리(모바일 상세)는 넘기지 않고, 그때는 ↗ 칸도 세우지 않는다. */
  readonly onShowMission?: (missionId: string) => void; readonly highlightMission: string | null;
  readonly groupOpen: (key: string) => boolean; readonly onToggleGroup: (key: string) => void;
}) {
  const now = useNow();
  // 열린 보기는 resultId로 고른다. 묶음 이동·교체도 현재 객체를 따르고, 이미지 넘기기는 같은 묶음 안에서만 한다.
  const [viewingId, setViewingId] = useState<string | null>(null);
  const openerRefs = useRef(new Map<string, HTMLButtonElement>());
  const openerRef = (id: string) => (node: HTMLButtonElement | null) => { if (node) openerRefs.current.set(id, node); else openerRefs.current.delete(id); };
  const groups = objective.missions.map((mission, index) => ({ mission, n: index + 1, results: objective.results.filter((result) => result.sourceMissionId === mission.id) })).filter((group) => group.results.length > 0);
  const knownMissions = new Set(objective.missions.map((mission) => mission.id));
  const loose = objective.results.filter((result) => !result.sourceMissionId || !knownMissions.has(result.sourceMissionId));
  const ordered = [...groups.flatMap((group) => group.results), ...loose];
  const evidence = ordered.filter((result): result is EvidenceResult => result.kind === "evidence");
  const source = (result: ObjectiveResult) => {
    const n = result.sourceMissionId ? objective.missions.findIndex((mission) => mission.id === result.sourceMissionId) + 1 : 0;
    return n > 0 ? t("objectives.results.mission", { n }) : t(result.sourceMissionId ? "objectives.results.looseRemoved" : "objectives.results.looseNoSource");
  };
  const sourceTag = (result: ObjectiveResult) => result.sourceMissionId && knownMissions.has(result.sourceMissionId) ? "" : ` · ${source(result)}`;
  const uploaded = (result: EvidenceResult) => t("objectives.results.uploaded", { ago: relative(result.capturedAt, now, language) });
  const close = () => { if (viewingId) openerRefs.current.get(viewingId)?.focus(); setViewingId(null); };
  const viewingLive = viewingId ? evidence.find((result) => result.id === viewingId) ?? null : null;
  const viewingGroup = groups.find((group) => group.results.some((result) => result.id === viewingId));
  const images = (viewingGroup?.results ?? loose).filter((result): result is EvidenceResult => result.kind === "evidence" && result.mediaType !== "text/plain");
  const imageIndex = viewingLive ? images.indexOf(viewingLive) : -1;
  const viewerImages = images.map((result) => ({
    src: resultFileUrl(objective.id, result), title: result.label ?? null, note: result.note ?? null,
    caption: `${result.name}${result.width && result.height ? ` · ${result.width}×${result.height}` : ""} · ${uploaded(result)} · ${source(result)}`,
  }));
  const group = (mission: ObjectiveMission | null, n: number, results: readonly ObjectiveResult[]) => {
    const record = mission?.records.at(-1);
    const key = resultGroupKey(objective.id, mission?.id);
    const open = groupOpen(key);
    const bodyId = `objectives-result-body-${objective.id}-${mission?.id ?? "loose"}`;
    const name = mission ? `${t("objectives.graph.detail", { n })} · ${mission.text}` : t("objectives.results.loose");
    const groupImages = results.filter((result): result is EvidenceResult => result.kind === "evidence" && result.mediaType !== "text/plain");
    return <section key={mission?.id ?? "loose"} data-result-mission={mission?.id} className={`objectives-result-group${mission ? "" : " is-loose"}${highlightMission === mission?.id ? " is-highlight" : ""}`}>
      <div className="objectives-result-group-bar">
        <button type="button" className="objectives-result-group-head" aria-label={`${name} · ${t("objectives.results.title")} ${t("objectives.results.count", { count: results.length })}`} aria-expanded={open} aria-controls={bodyId} onClick={() => onToggleGroup(key)}>
          <span className="objectives-result-mission-n" aria-hidden="true">{mission ? n : "—"}</span><span className="objectives-result-mission-title">{mission?.text ?? t("objectives.results.loose")}</span>
          <span className="objectives-result-group-count">{t("objectives.results.count", { count: results.length })}</span>
          <span className="objectives-section-chev" aria-hidden="true"><ChevronGlyph /></span>
        </button>
        {!onShowMission ? null : mission ? <button type="button" className="objectives-glyph objectives-result-goto" aria-label={`${t("objectives.graph.detail", { n })} · ${t("objectives.results.showInGraph")}`} title={t("objectives.results.showInGraph")} onClick={() => onShowMission(mission.id)}>↗</button>
          : <span className="objectives-result-goto-space" aria-hidden="true" />}
      </div>
      <div id={bodyId} className="objectives-result-group-body" hidden={!open}>
      {record ? <div className="objectives-result-record">
        <span title={record.lines[0] ?? ""}><LinkText text={record.lines[0] ?? ""} /></span>
        <time dateTime={new Date(record.at).toISOString()} title={absolute(record.at, language)}>{t("objectives.results.lastRecord", { time: relative(record.at, now, language) })}</time>
      </div> : null}
      {groupImages.length ? <div className="objectives-result-strip">{groupImages.map((result) => {
        const title = result.label ?? result.name;
        return <div key={result.id} className="objectives-result-thumb">
          <button ref={openerRef(result.id)} type="button" className="objectives-result-thumb-hit" aria-label={`${t("objectives.results.zoom", { name: title })} · ${source(result)}`} title={`${result.name} · ${uploaded(result)} · ${source(result)}`} onClick={() => setViewingId(result.id)}>
            <span className="objectives-result-img"><img src={resultFileUrl(objective.id, result)} alt="" loading="lazy" draggable={false} /></span>
          </button>
          <span className="objectives-result-name" onClick={(event) => { if (event.target instanceof Element && event.target.closest("a")) return; setViewingId(result.id); }}><LinkText text={title} /></span>
          {!mission ? <span className="objectives-result-sub">{source(result)}</span> : null}
        </div>;
      })}</div> : null}
      {results.filter((result): result is EvidenceResult => result.kind === "evidence" && result.mediaType === "text/plain").map((result) => <div key={result.id} className="objectives-result-row is-button" onClick={(event) => { if (event.target instanceof Element && event.target.closest("a")) return; setViewingId(result.id); }}>
        <span className="objectives-row-ic"><DocGlyph /></span>
        <span className="objectives-result-body">
          <span className="objectives-result-title is-mono"><LinkText text={result.label ?? result.name} /></span>
          <span className="objectives-result-sub">{result.label ? `${result.name} · ` : ""}{t("objectives.results.text", { size: bytesLabel(result.bytes) })} · <time dateTime={new Date(result.capturedAt).toISOString()} title={absolute(result.capturedAt, language)}>{uploaded(result)}</time>{sourceTag(result)}</span>
          {result.note ? <span className="objectives-result-sub"><LinkText text={result.note} /></span> : null}
        </span>
        <button ref={openerRef(result.id)} type="button" className="objectives-result-open" aria-label={`${t("objectives.results.openAria", { name: result.label ?? result.name })} · ${source(result)}`} onClick={() => setViewingId(result.id)}>{t("objectives.results.open")}</button>
      </div>)}
      {results.filter((result) => result.kind === "artifact").map((result) => {
        const name = result.label ?? t("objectives.results.artifact.untitled");
        return <div key={result.id} className="objectives-result-row is-button is-artifact" onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("a") || window.getSelection()?.toString()) return;
          event.currentTarget.querySelector<HTMLAnchorElement>("a")?.click();
        }}>
          <span className="objectives-row-ic"><ArtifactGlyph /></span>
          <span className="objectives-result-body">
            <a className={`objectives-result-title${result.label ? "" : " is-placeholder"}`} href={result.url} target="_blank" rel="noopener noreferrer" aria-label={t("objectives.results.artifact.openAria", { name })} title={t("objectives.results.artifact.tooltip")}>{name}</a>
            <span className="objectives-result-sub"><span className="is-mono">claude.ai</span>{sourceTag(result)}</span>
            {result.note ? <span className="objectives-result-sub">{result.note}</span> : null}
          </span>
          <span className="objectives-result-open" aria-hidden="true">{t("objectives.results.artifact.newTab")}<ExternalGlyph /></span>
        </div>;
      })}
      {results.filter((result): result is PrResult => result.kind === "pr").map((result) => <PrRow key={result.id} result={result} t={t} language={language} now={now} missionTag={sourceTag(result)} />)}
      </div>
    </section>;
  };

  const artifactVisible = groups.some(({ mission, results }) => groupOpen(resultGroupKey(objective.id, mission.id)) && results.some((result) => result.kind === "artifact"))
    || groupOpen(resultGroupKey(objective.id)) && loose.some((result) => result.kind === "artifact");
  return <div className="objectives-results">
    {groups.map(({ mission, n, results }) => group(mission, n, results))}
    {loose.length ? group(null, 0, loose) : null}
    {artifactVisible ? <p className="objectives-artifact-notice"><InfoGlyph /><span>{t("objectives.results.artifact.notice")}</span></p> : null}
    {viewingLive ? createPortal(
      viewingLive.mediaType === "text/plain"
        ? <EvidenceTextView t={t} src={resultFileUrl(objective.id, viewingLive)} name={viewingLive.name} caption={`${viewingLive.name} · ${bytesLabel(viewingLive.bytes)} · ${uploaded(viewingLive)} · ${source(viewingLive)}`} onClose={close} />
        : <AttachmentView t={t} images={viewerImages} index={imageIndex} onIndex={(index) => setViewingId(images[index]!.id)} onClose={close} />,
      document.body,
    ) : null}
  </div>;
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
    // 행 어디를 눌러도 PR 이 열린다 — 행 안의 링크(제목·노트)와 텍스트 선택은 가로채지 않는다.
    <div className="objectives-result-row is-button" onClick={(event) => {
      if (event.target instanceof Element && event.target.closest("a") || window.getSelection()?.toString()) return;
      event.currentTarget.querySelector<HTMLAnchorElement>("a.objectives-result-title")?.click();
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

type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
type ResizeRect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
const RESIZE_DIRS: readonly ResizeDir[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
/** 리사이즈 한계 — 최소 360×160, 화면 가장자리에서 12px 안(폭 ≤ 100vw − 24, 높이 ≤ 100dvh − 24). */
const RESIZE_MIN_W = 360;
const RESIZE_MIN_H = 160;
const RESIZE_GAP = 12;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
/** 뷰포트가 줄면 크기를 먼저 줄이고 위치를 화면 안으로 되돌린다. */
function fitRect(rect: ResizeRect, vw: number, vh: number): ResizeRect {
  const w = Math.min(clamp(rect.w, RESIZE_MIN_W, vw - RESIZE_GAP * 2), vw);
  const h = Math.min(clamp(rect.h, RESIZE_MIN_H, vh - RESIZE_GAP * 2), vh);
  const x = Math.max(0, clamp(rect.x, RESIZE_GAP, vw - RESIZE_GAP - w));
  const y = Math.max(0, clamp(rect.y, RESIZE_GAP, vh - RESIZE_GAP - h));
  return rect.x === x && rect.y === y && rect.w === w && rect.h === h ? rect : { x, y, w, h };
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
  const mode = textMode(name);
  const html = useMemo(() => {
    if (!loaded || !("text" in loaded) || mode === "plain") return "";
    const rendered = renderMarkdown(mode === "json" ? fencedJson(loaded.text) : loaded.text, { copyLabel: t("objectives.results.copy"), copyAriaLabel: (language) => t("objectives.results.copyCode", { language }) }).html;
    const doc = new DOMParser().parseFromString(rendered, "text/html");
    neutralizeUntrustedDom(doc.body);
    return doc.body.innerHTML;
  }, [loaded, mode, t]);
  useEffect(() => { closeRef.current?.focus(); }, []);
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
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 확대 다이어그램이 이 보기를 inert로 두는 동안 키 처리는 위 모달에 맡긴다.
      if (closeRef.current?.closest("[inert]")) return;
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
  // 크기는 이 보기를 연 동안만 산다 — 다시 열면 내용 폭(fit-content)으로 연다. 끌지 않은 반대쪽 변은 제자리에 둔다.
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const figureRef = useRef<HTMLElement | null>(null);
  const [rect, setRect] = useState<ResizeRect | null>(null);
  const [resizing, setResizing] = useState(false);
  // 닫기 글리프가 틀 밖으로 걸치는 만큼 화면 안 여백이 모자라면 안으로 들인다 — 오른쪽 여백 계산에 뷰포트 폭이 필요하다.
  const [viewW, setViewW] = useState(0);
  const sized = rect !== null;
  useEffect(() => {
    if (!sized) return;
    const onResize = () => {
      const view = backdropRef.current;
      if (!view) return;
      setViewW(view.clientWidth);
      setRect((current) => current && fitRect(current, view.clientWidth, view.clientHeight));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [sized]);
  const onResizeStart = useCallback((event: ReactPointerEvent<HTMLSpanElement>, dir: ResizeDir) => {
    const view = backdropRef.current;
    const figure = figureRef.current;
    if (event.button !== 0 || !view || !figure) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const origin = view.getBoundingClientRect();
    const box = figure.getBoundingClientRect();
    const start = { px: event.clientX, py: event.clientY, x: box.left - origin.left, y: box.top - origin.top, w: box.width, h: box.height };
    setRect({ x: start.x, y: start.y, w: start.w, h: start.h });
    setViewW(view.clientWidth);
    setResizing(true);
    const move = (ev: PointerEvent) => {
      const vw = view.clientWidth, vh = view.clientHeight;
      const dx = ev.clientX - start.px, dy = ev.clientY - start.py;
      let { x, y, w, h } = start;
      if (dir.includes("e")) w = clamp(start.w + dx, RESIZE_MIN_W, vw - RESIZE_GAP - start.x);
      if (dir.includes("w")) { x = clamp(start.x + dx, RESIZE_GAP, start.x + start.w - RESIZE_MIN_W); w = start.x + start.w - x; }
      if (dir.includes("s")) h = clamp(start.h + dy, RESIZE_MIN_H, vh - RESIZE_GAP - start.y);
      if (dir.includes("n")) { y = clamp(start.y + dy, RESIZE_GAP, start.y + start.h - RESIZE_MIN_H); h = start.y + start.h - y; }
      setRect(fitRect({ x, y, w, h }, vw, vh));
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      handle.removeEventListener("lostpointercapture", end);
      setResizing(false);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("lostpointercapture", end);
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
    <div ref={backdropRef} className="objectives-zoom-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <figure ref={figureRef} className={`objectives-att-view objectives-result-textview${rect ? " is-sized" : ""}${resizing ? " is-resizing" : ""}`} role="dialog" aria-modal="true" aria-label={caption} style={rect ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h, "--objectives-tv-room-top": `${rect.y}px`, "--objectives-tv-room-right": `${viewW - rect.x - rect.w}px` } as CSSProperties : undefined}>
        {RESIZE_DIRS.map((dir) => <span key={dir} className={`objectives-result-resize is-${dir}`} aria-hidden="true" onPointerDown={(event) => onResizeStart(event, dir)} />)}
        <button ref={closeRef} type="button" className="objectives-att-view-close" aria-label={t("objectives.detail.close")} title={t("objectives.detail.close")} onClick={onClose}><CloseGlyph /></button>
        {loaded === null ? <div className="objectives-result-textstate" role="status">{t("objectives.results.loading")}</div>
          : "error" in loaded ? <div className="objectives-result-textstate is-error" role="alert">{t("objectives.results.loadFailed", { code: loaded.error })}</div>
          : mode === "plain"
            ? <div className="markdown-body objectives-result-markdown" tabIndex={0}><pre className="objectives-result-plain"><code>{loaded.text}</code></pre></div>
            : <div ref={bodyRef} className="markdown-body objectives-result-markdown" tabIndex={0} onClick={onCopy} dangerouslySetInnerHTML={{ __html: html }} />}
        <figcaption>{caption}</figcaption>
      </figure>
    </div>
  );
}

const ChevronGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" /></svg>;
const ArtifactGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M2 6h12M4.5 4.3h.1M6.5 4.3h.1M6 8.5l-1.5 1.5L6 11.5M10 8.5l1.5 1.5-1.5 1.5" /></svg>;
const ExternalGlyph = () => <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 2.5H2.5v7h7V7M7 2.5h2.5V5M9.5 2.5 5.5 6.5" /></svg>;
const InfoGlyph = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M8 7v4M8 4.8h.01" /></svg>;
const CloseGlyph = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>;
/** 결과물 구획 머리 — 상자에 담긴 산출물. */
export const ResultsGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 5.2 8 2.5l5.5 2.7v5.6L8 13.5l-5.5-2.7z" /><path d="M2.5 5.2 8 7.9l5.5-2.7M8 7.9v5.6" /></svg>;
const PrGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="4.5" cy="3.8" r="1.6" /><circle cx="4.5" cy="12.2" r="1.6" /><circle cx="11.5" cy="12.2" r="1.6" /><path d="M4.5 5.4v5.2M11.5 10.6V6.5a2 2 0 0 0-2-2H7.5M9 3l-1.5 1.5L9 6" /></svg>;
const DocGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.5 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V5.5z" /><path d="M9.5 2v3.5H13M5.8 8.5h4.4M5.8 11h3" /></svg>;
