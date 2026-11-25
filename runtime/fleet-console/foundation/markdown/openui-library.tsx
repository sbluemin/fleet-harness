/**
 * OpenUI 렌더러 — Fleet 소유 컴포넌트를 담은 지연 청크.
 * react-lang 라이브러리 등록(등록 스키마는 openui-prune 의 SPECS 그대로) + Fleet 컴포넌트. 판정은 openui-prune 의 정제가 맡고,
 * 렌더러에는 정제한 원문만 넘긴다.
 */
import "./openui-devtools-guard.js";

import { BuiltinActionType, createLibrary, defineComponent, Renderer, useTriggerAction, type ActionPlan } from "@openuidev/react-lang";
import {
  composeChecklistDraft,
  composeDraft,
  parseOpenUIOpenTarget,
  sendableReply,
  sendableText,
  type OpenUIDraftPort,
  type OpenUIEntityBadgeTone,
  type OpenUIOpenPort,
  type OpenUIOpenTarget,
  type OpenUISendPort,
} from "./openui-actions.js";
import {
  BUTTON_VARIANTS,
  CARD_CHILD_NAMES,
  checklistReady,
  EXTENDED_TONES,
  formReady,
  isNode,
  LEAF_CHILD_NAMES,
  list,
  prune,
  SNIPPET_KINDS,
  sourceAction,
  SPECS,
  STATES,
  TONES,
  type Node,
  type SafeAction,
  type Verdict,
} from "./openui-prune.js";
export { composeChecklistDraft, composeDraft, sendableDraft, sendableReply } from "./openui-actions.js";
import * as React from "react";
import { MenuCheckGlyph } from "@fleet-console/ui/react";
import { z } from "zod";

export type OpenUIState = "todo" | "running" | "waiting" | "done" | "blocked";
export type OpenUITone = "good" | "warn" | "bad";
export interface OpenUIRenderLabels {
  readonly states: Readonly<Record<OpenUIState, string>>;
  readonly tones: Readonly<Record<OpenUITone, string>>;
  readonly open?: string;
  readonly unavailable?: string;
  readonly copy?: string;
  readonly copied?: string;
  readonly fillDraft?: string;
  readonly draftFilled?: string;
  readonly sent?: string;
  readonly previewLabel?: string;
  readonly selectedCount?: string;
  readonly selectOneHint?: string;
  readonly cardView?: string;
  readonly tableView?: string;
  readonly entityKinds?: Readonly<Record<OpenUIOpenTarget["kind"], string>>;
}

const MAX_TEXT = 200;
const MAX_UNIT = 8;
const CARD_CHILD_SET: ReadonlySet<string> = new Set(CARD_CHILD_NAMES.filter((name) => name !== "Choices"));
const LEAF_CHILD_SET: ReadonlySet<string> = new Set(LEAF_CHILD_NAMES);
const DEFAULT_ENTITY_KINDS: Readonly<Record<OpenUIOpenTarget["kind"], string>> = {
  commodore: "Commodore",
  objective: "Objective",
  mission: "Mission",
  https: "Link",
};

// 블록마다 바뀌는 값(라벨·확정·포트)은 컨텍스트로 — 라이브러리는 모듈에 하나다.
interface BlockContext {
  readonly labels: OpenUIRenderLabels;
  readonly final: boolean;
  readonly send: OpenUISendPort | null;
  readonly open: OpenUIOpenPort | null;
  readonly draft: OpenUIDraftPort | null;
  readonly sent: string | null;
  readonly drafted: string | null;
  readonly activate: (event: React.MouseEvent<HTMLButtonElement>, action: SafeAction, key: string, trigger: ReturnType<typeof useTriggerAction>) => void;
}
const Block = React.createContext<BlockContext | null>(null);
const useBlock = () => React.useContext(Block)!;
const InsideActions = React.createContext(false);

function plain(value: unknown): string | null {
  const raw = typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
  if (raw === null) return null;
  return raw.length > MAX_TEXT ? `${raw.slice(0, MAX_TEXT - 1)}…` : raw;
}
// 선택 설명은 공백만 있어도 생략과 같다. 필수 문장·전송 값은 이 규칙으로 정규화하지 않는다.
const optionalPlain = (value: unknown): string | null => typeof value === "string" && !value.trim() ? null : plain(value);
const oneOf = <T extends string>(value: unknown, options: readonly T[]): T | null =>
  typeof value === "string" && (options as readonly string[]).includes(value) ? (value as T) : null;

const toneClass = (tone: OpenUITone | OpenUIEntityBadgeTone | null) => tone ? ` is-${tone}` : "";

function IconSvg({ d, size = 14, className }: { readonly d: string; readonly size?: number; readonly className?: string }) {
  return (
    <svg className={className ? `openui-glyph ${className}` : "openui-glyph"} viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}
const ChevronRightIcon = () => <IconSvg d="m9 6 6 6-6 6" size={13} />;
const ChevronDownIcon = ({ rotated = false }: { readonly rotated?: boolean }) => <IconSvg d="m6 9 6 6 6-6" size={14} className={rotated ? "is-rotated" : undefined} />;
const ExternalIcon = () => <IconSvg d="M7 17 17 7M9 7h8v8" size={13} />;
const SendIcon = () => <IconSvg d="M22 2 11 13M22 2l-7 20-4-9-9-4Z" size={13} />;
const DraftIcon = () => <IconSvg d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" size={13} />;
const CopyIcon = () => <IconSvg d="M8 8h11v11H8zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" size={13} />;
const GlobeIcon = () => <IconSvg d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" size={15} />;
const TargetIcon = () => <IconSvg d="M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" size={15} />;
const FlagIcon = () => <IconSvg d="M5 21V4h11l-2.5 4L16 12H5" size={15} />;
const BanIcon = () => <IconSvg d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM5.6 5.6l12.8 12.8" size={14} />;

function MongleMark({ tone }: { readonly tone?: string }) {
  return (
    <span className={`openui-entity-avatar is-mongle${tone ? ` is-tone-${tone}` : ""}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" width={18} height={18} fill="none" aria-hidden="true" focusable="false">
        <path d="M8.5 11.2h.01M15.5 11.2h.01" stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" />
        <path d="M9.5 15.2c1.2 1.1 3.8 1.1 5 0" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
      </svg>
    </span>
  );
}

// 블록 컨텍스트는 대문자 컴포넌트 안에서만 읽는다. tone은 보이는 색과 읽기 라벨, state는 보이는 글자 태그로 전한다.
function ToneLabel({ tone, suffix = false }: { tone: OpenUITone; suffix?: boolean }) {
  const { labels } = useBlock();
  return <span className="openui-sr">{suffix ? ` (${labels.tones[tone]})` : `${labels.tones[tone]}: `}</span>;
}
function StateTag({ state }: { state: OpenUIState }) {
  const { labels } = useBlock();
  const tone = { todo: "", running: " is-warn", waiting: " is-wait", done: " is-good", blocked: " is-bad" }[state];
  return <span className={`openui-tag${tone}`}>{labels.states[state]}</span>;
}

const StepIndex = React.createContext<{ readonly index: number; readonly last: boolean }>({ index: 0, last: true });
function StepRow({ props }: { props: Record<string, unknown> }) {
  const { index, last } = React.useContext(StepIndex);
  const state = oneOf(props.state, STATES)!;
  const note = optionalPlain(props.note);
  const marker = state === "done" ? "✓" : state === "blocked" ? "!" : state === "running" ? "▸" : state === "waiting" ? "…" : String(index);
  return <div className={`openui-step is-${state}${last ? " is-last" : ""}`} role="listitem">
    <span className="openui-step-rail" aria-hidden="true">
      <span className="openui-step-index">{marker}</span>
      {last ? null : <span className="openui-step-connector" />}
    </span>
    <span className="openui-step-body"><span className="openui-step-label">{plain(props.label)}</span>{note ? <span className="openui-step-note">{note}</span> : null}</span>
    <StateTag state={state} />
  </div>;
}

function useCopyState(): { readonly copied: boolean; readonly copy: (value: string) => void } {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<number | null>(null);
  React.useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  const copy = React.useCallback((value: string) => {
    void navigator.clipboard?.writeText(value).catch(() => {});
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = null; setCopied(false); }, 1600);
  }, []);
  return { copied, copy };
}

const statReady = (p: Record<string, unknown>) => plain(p.label) !== null && plain(p.value) !== null;
const stepReady = (p: Record<string, unknown>) => plain(p.label) !== null && oneOf(p.state, STATES) !== null;
const factReady = (p: Record<string, unknown>) => plain(p.label) !== null && plain(p.value) !== null;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const progressReady = (p: Record<string, unknown>) =>
  plain(p.label) !== null && finite(p.done) && finite(p.total) && p.total > 0 && p.done >= 0 && p.done <= p.total;
const segmentReady = (p: Record<string, unknown>) => plain(p.label) !== null && finite(p.value) && p.value >= 0;

const Stat = defineComponent({
  ...SPECS.Stat,
  component: ({ props }) => {
    const t = oneOf(props.tone, TONES);
    const note = optionalPlain(props.note);
    return (
      <div className={`openui-stat openui-rule${toneClass(t)}`}>
        <span className="openui-stat-label">{plain(props.label)}</span>
        <span className="openui-stat-value">{t ? <ToneLabel tone={t} /> : null}{plain(props.value)}</span>
        {note ? <span className="openui-stat-note">{note}</span> : null}
      </div>
    );
  },
});
const Stats = defineComponent({
  ...SPECS.Stats,
  component: ({ props, renderNode }) => {
    const items = list(props.items).filter((item) => isNode(item, "Stat") && statReady(item.props));
    return items.length ? <div className="openui-stats" role="group">{renderNode(items)}</div> : null;
  },
});
const Step = defineComponent({
  ...SPECS.Step,
  component: ({ props }) => <StepRow props={props} />,
});
const Steps = defineComponent({
  ...SPECS.Steps,
  component: ({ props, renderNode }) => {
    const items = list(props.items).filter((item) => isNode(item, "Step") && stepReady(item.props));
    return items.length ? <div className="openui-steps" role="list">{items.map((item, i) => <StepIndex.Provider key={i} value={{ index: i + 1, last: i === items.length - 1 }}>{renderNode(item)}</StepIndex.Provider>)}</div> : null;
  },
});
const Bars = defineComponent({
  ...SPECS.Bars,
  component: ({ props }) => {
    const labels = list(props.labels);
    const values = list(props.values);
    const pairs: { label: string; value: number }[] = [];
    for (let i = 0; i < Math.min(labels.length, values.length); i++) {
      const label = plain(labels[i]);
      const value = values[i];
      if (label !== null && typeof value === "number" && Number.isFinite(value)) pairs.push({ label, value });
    }
    if (!pairs.length) return null;
    const unit = typeof props.unit === "string" ? props.unit.slice(0, MAX_UNIT) : "";
    const peak = Math.max(...pairs.map((p) => p.value));
    const max = Math.max(peak, unit === "%" ? 100 : 0);
    const format = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
    return (
      <div className="openui-bars">
        {pairs.map((p, i) => {
          const lead = pairs.length > 1 && p.value === peak && peak > 0;
          return (
            <React.Fragment key={i}>
              <span className={`openui-bar-label${lead ? " is-lead" : ""}`}>{p.label}</span>
              <span className={`openui-bar-track${lead ? " is-lead" : ""}`}><span className="openui-bar-fill" style={{ width: `${max > 0 ? Math.min(100, Math.max(0, (p.value / max) * 100)) : 0}%` }} /></span>
              <span className={`openui-bar-value${lead ? " is-lead" : ""}`}>{`${format.format(p.value)}${unit}`}</span>
            </React.Fragment>
          );
        })}
      </div>
    );
  },
});
const Table = defineComponent({
  ...SPECS.Table,
  component: ({ props }) => {
    const columns = list(props.columns);
    if (!columns.length) return null;
    return (
      <div className="openui-table-frame openui-frame">
        <table className="openui-table">
          <thead><tr>{columns.map((c, i) => <th key={i}>{plain(c) ?? ""}</th>)}</tr></thead>
          <tbody>{list(props.rows).map((row, r) => <tr key={r}>{columns.map((_, i) => <td key={i}>{plain(list(row)[i]) ?? ""}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  },
});
function FactRow({ props }: { props: Record<string, unknown> }) {
  const { labels } = useBlock();
  const { copied, copy } = useCopyState();
  const t = oneOf(props.tone, TONES);
  const value = plain(props.value) ?? "";
  const copyable = props.copyable === true && value.length > 0;
  return (
    <div className="openui-fact" role="listitem">
      <span className="openui-fact-label">{plain(props.label)}</span>
      <span className={`openui-fact-value${toneClass(t)}`}>
        {t ? <ToneLabel tone={t} /> : null}
        {value}
        {copyable ? (
          <button type="button" className={`openui-copy-inline${copied ? " is-copied" : ""}`} aria-label={copied ? (labels.copied ?? "Copied") : (labels.copy ?? "Copy")} onClick={(event) => { if (event.nativeEvent.isTrusted) copy(value); }}>
            {copied ? <MenuCheckGlyph className="openui-button-check" /> : <CopyIcon />}
            <span>{copied ? (labels.copied ?? "Copied") : (labels.copy ?? "Copy")}</span>
          </button>
        ) : null}
      </span>
    </div>
  );
}
const Fact = defineComponent({
  ...SPECS.Fact,
  component: ({ props }) => <FactRow props={props} />,
});
const Facts = defineComponent({
  ...SPECS.Facts,
  component: ({ props, renderNode }) => {
    const items = list(props.items).filter((item) => isNode(item, "Fact") && factReady(item.props));
    return items.length ? <div className="openui-facts openui-frame" role="list">{renderNode(items)}</div> : null;
  },
});
const Callout = defineComponent({
  ...SPECS.Callout,
  component: ({ props }) => {
    const sentence = plain(props.text);
    if (!sentence) return null;
    const t = oneOf(props.tone, TONES);
    const title = optionalPlain(props.title);
    const mark = t === "good" ? "✓" : t === "warn" ? "!" : t === "bad" ? "×" : "i";
    return (
      <div className={`openui-callout openui-rule${toneClass(t)}`} role="note">
        <span className="openui-callout-mark" aria-hidden="true">{mark}</span>
        <span className="openui-callout-body">
          {title ? <span className="openui-callout-title">{title}</span> : null}
          {t ? <ToneLabel tone={t} /> : null}
          <span className="openui-callout-text">{sentence}</span>
        </span>
      </div>
    );
  },
});
// 분수 진행률 — 막대의 한 줄 문법(이름 · 트랙 · 값)을 그대로 입는다. 값은 "done/total", 채움 폭은 계산한 비율 하나다.
const Progress = defineComponent({
  ...SPECS.Progress,
  component: ({ props }) => {
    if (!progressReady(props)) return null;
    const done = props.done as number;
    const total = props.total as number;
    const note = optionalPlain(props.note);
    const pct = Math.min(100, Math.max(0, (done / total) * 100));
    const format = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
    return (
      <div className="openui-bars openui-progress">
        <span className="openui-bar-label">{plain(props.label)}</span>
        <span className={`openui-bar-track${pct >= 100 ? " is-good" : " is-lead"}`}><span className="openui-bar-fill" style={{ width: `${pct}%` }} /></span>
        <span className="openui-bar-value">{`${format.format(done)}/${format.format(total)}`}</span>
        {note ? <span className="openui-progress-note">{note}</span> : null}
      </div>
    );
  },
});
// 다중 구간 상태 바 — 완료·진행·대기·막힘 비율을 한 줄 비례 세그먼트와 범례로 표현한다.
const Segment = defineComponent({ ...SPECS.Segment, component: () => null });
const Breakdown = defineComponent({
  ...SPECS.Breakdown,
  component: ({ props }) => {
    const label = plain(props.label);
    const items = list(props.segments).filter((item) => isNode(item, "Segment") && segmentReady(item.props)) as Node[];
    const total = items.reduce((sum, seg) => sum + (seg.props.value as number), 0);
    if (!label || !items.length || total <= 0) return null;
    const note = optionalPlain(props.note);
    const format = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
    return (
      <div className="openui-breakdown" role="group" aria-label={label}>
        <div className="openui-breakdown-head">
          <span className="openui-breakdown-label">{label}</span>
          {note ? <span className="openui-breakdown-note">{note}</span> : null}
        </div>
        <div className="openui-breakdown-track">
          {items.map((seg, i) => {
            const val = seg.props.value as number;
            const pct = Math.round((val / total) * 1000) / 10;
            const t = oneOf(seg.props.tone, EXTENDED_TONES);
            return val > 0 ? <span key={i} className={`openui-bar-fill openui-breakdown-seg${toneClass(t)}`} style={{ width: `${pct}%` }} /> : null;
          })}
        </div>
        <div className="openui-breakdown-legend" role="list">
          {items.map((seg, i) => {
            const t = oneOf(seg.props.tone, EXTENDED_TONES);
            return (
              <span key={i} className={`openui-breakdown-item${toneClass(t)}`} role="listitem">
                <span className="openui-breakdown-dot" aria-hidden="true" />
                <span className="openui-breakdown-name">{plain(seg.props.label)}</span>
                <span className="openui-breakdown-val">{format.format(seg.props.value as number)}</span>
              </span>
            );
          })}
        </div>
      </div>
    );
  },
});

// 은퇴한 선택지 — 안내 문면에서 빠져 새 답에는 나오지 않는다. 옛 기록의 카드가 코드 블록으로 떨어지지 않도록 파서 등록과 판정은
// 남기되, 아무것도 그리지 않고 Card 도 자식에서 거른다. 형제(표·사실·단추)는 그대로 그린다.
const Choice = defineComponent({ ...SPECS.Choice, component: () => null });
const Choices = defineComponent({ ...SPECS.Choices, component: () => null });

// 등록 때는 액션 문법을 알리지만, 판정은 단일 리터럴 단계만 허용한다. Action·Run·상태 변경은 실행기에 닿지 않는다.
const runtimePlan = z.object({ steps: z.tuple([z.union([
  z.object({ type: z.literal("open_url"), url: z.string() }).strict(),
  // 업스트림은 context를 생략해도 undefined 키를 붙인다. 정의된 숨은 값은 여전히 거절한다.
  z.object({ type: z.literal("continue_conversation"), message: z.string(), context: z.undefined().optional() }).strict(),
])]) }).strict();
function refusedRuntimeOpen(value: unknown): string | null {
  const plan = runtimePlan.safeParse(value);
  const step = plan.success ? plan.data.steps[0] : null;
  return step?.type === "open_url" && !parseOpenUIOpenTarget(step.url) ? step.url : null;
}
function runtimeAction(value: unknown, label: unknown, variant?: unknown): SafeAction | null {
  const isDraft = variant === "draft";
  if (value == null) return sourceAction(value, label, variant);
  const plan = runtimePlan.safeParse(value);
  if (!plan.success) return null;
  const step = plan.data.steps[0];
  if (step.type === "open_url") {
    if (isDraft) return null;
    return parseOpenUIOpenTarget(step.url) ? { type: "open", url: step.url } : null;
  }
  const message = sendableReply(step.message);
  return message ? { type: isDraft ? "draft" : "send", message, max: 200 } : null;
}

/** 사령관·목표·미션·외부 링크를 사람 친화적 엔티티 카드로 그린다. 클라이언트 스토어 해석이 있으면 실제 이름·상태·아바타를 우선 쓴다. */
function EntitySurface({
  rawTarget,
  fallbackTitle,
  fallbackSubtitle,
  fallbackBadge,
  fallbackTone,
  asButtonClass = false,
}: {
  readonly rawTarget: string;
  readonly fallbackTitle?: string | null;
  readonly fallbackSubtitle?: string | null;
  readonly fallbackBadge?: string | null;
  readonly fallbackTone?: OpenUIEntityBadgeTone | null;
  readonly asButtonClass?: boolean;
}) {
  const block = useBlock();
  const trigger = useTriggerAction();
  const key = React.useId();
  const target = parseOpenUIOpenTarget(rawTarget);
  const kinds = block.labels.entityKinds ?? DEFAULT_ENTITY_KINDS;
  const openLabel = block.labels.open ?? "Open";
  const unavailableLabel = block.labels.unavailable ?? "Unavailable";

  if (!target || !block.open?.accepts(target)) {
    const resolved = target ? block.open?.resolve?.(target) ?? null : null;
    const title = resolved?.title || fallbackTitle || (target ? kinds[target.kind] : unavailableLabel);
    const sub = resolved?.subtitle ?? fallbackSubtitle ?? null;
    return (
      <span className="openui-inert openui-entity is-inert is-unavailable" title={rawTarget}>
        <span className="openui-entity-avatar is-unavailable" aria-hidden="true"><BanIcon /></span>
        <span className="openui-entity-meta">
          <span className="openui-entity-name-row">
            <span className="openui-entity-name">{title}</span>
            <span className="openui-tag">{unavailableLabel}</span>
          </span>
          {sub ? <span className="openui-entity-sub">{sub}</span> : null}
        </span>
      </span>
    );
  }

  const resolved = block.open.resolve?.(target) ?? null;
  const defaultTitle = target.kind === "https"
    ? target.hostname
    : target.kind === "mission"
      ? `${kinds.mission} #${target.number}`
      : kinds[target.kind];
  const title = resolved?.title || fallbackTitle || defaultTitle;
  const subtitle = resolved?.subtitle ?? fallbackSubtitle ?? (target.kind === "https" ? target.hostname : target.kind === "mission" ? `${kinds.mission} #${target.number}` : kinds[target.kind]);
  const badge = resolved?.badge ?? fallbackBadge ?? null;
  const badgeTone = resolved?.badgeTone ?? fallbackTone ?? null;
  const goLabel = resolved?.actionLabel ?? (target.kind === "https" ? target.hostname : openLabel);

  const avatar = target.kind === "commodore"
    ? <MongleMark tone={resolved?.avatarTone} />
    : target.kind === "objective"
      ? <span className="openui-entity-avatar is-objective" aria-hidden="true"><TargetIcon /></span>
      : target.kind === "mission"
        ? <span className="openui-entity-avatar is-mission" aria-hidden="true"><FlagIcon /></span>
        : <span className="openui-entity-avatar is-https" aria-hidden="true"><GlobeIcon /></span>;

  const safe: SafeAction = { type: "open", url: rawTarget };
  return (
    <button
      type="button"
      className={asButtonClass ? "openui-button openui-entity" : "openui-entity"}
      title={rawTarget}
      disabled={!block.final}
      onClick={(event) => block.activate(event, safe, key, trigger)}
    >
      {avatar}
      <span className="openui-entity-meta">
        <span className="openui-entity-name-row">
          <span className="openui-entity-name">{title}</span>
          {badge ? <span className={`openui-tag${toneClass(badgeTone)}`}>{badge}</span> : null}
        </span>
        {subtitle ? <span className="openui-entity-sub">{subtitle}</span> : null}
      </span>
      <span className="openui-entity-go">
        <span className="openui-entity-go-label">{goLabel}</span>
        {target.kind === "https" ? <ExternalIcon /> : <ChevronRightIcon />}
      </span>
    </button>
  );
}

function ActionButton({ label, action, variant }: { readonly label: string; readonly action: unknown; readonly variant?: unknown }) {
  const block = useBlock();
  const trigger = useTriggerAction();
  const inActions = React.useContext(InsideActions);
  const key = React.useId();
  const v = oneOf(variant, BUTTON_VARIANTS);
  const safe = runtimeAction(action, label, v);
  if (!safe) {
    const refused = v === "draft" ? null : refusedRuntimeOpen(action);
    return refused === null ? null : (
      <span className="openui-inert is-inert" title={refused}>
        <BanIcon />
        <span>{label}</span>
        <span className="openui-tag">{block.labels.unavailable ?? "Unavailable"}</span>
      </span>
    );
  }
  const target = safe.type === "open" ? parseOpenUIOpenTarget(safe.url) : null;
  // 카드 직속 내부 엔티티 탐색 버튼(과거 기록의 Button("Open Commodore", @OpenUrl("commodore:...")) 포함)은 자동으로 리치 엔티티 카드로 승격한다.
  if (safe.type === "open" && target && target.kind !== "https" && !inActions) {
    return <EntitySurface rawTarget={safe.url} fallbackTitle={label} asButtonClass />;
  }
  if (target && !block.open?.accepts(target)) {
    const resolved = block.open?.resolve?.(target) ?? null;
    return (
      <span className="openui-inert is-inert" title={safe.type === "open" ? safe.url : undefined}>
        <BanIcon />
        <span>{resolved?.title || label}</span>
        <span className="openui-tag">{block.labels.unavailable ?? "Unavailable"}</span>
      </span>
    );
  }
  const tail = target?.kind === "https" ? target.hostname : null;
  const resolved = target && target.kind !== "https" ? block.open?.resolve?.(target) ?? null : null;
  const visibleLabel = resolved?.title || label;
  const isSent = safe.type === "send" && block.sent === key;
  const isDrafted = safe.type === "draft" && block.drafted === key;
  const glyph = isSent || isDrafted
    ? <MenuCheckGlyph className="openui-button-check" />
    : safe.type === "draft"
      ? <DraftIcon />
      : safe.type === "open"
        ? (target?.kind === "https" ? <ExternalIcon /> : <ChevronRightIcon />)
        : <SendIcon />;
  const cls = `openui-button${v === "primary" ? " is-primary" : v === "draft" ? " is-draft" : ""}${safe.type === "open" ? " is-open" : ""}${isDrafted ? " is-drafted" : ""}`;
  return (
    <button
      type="button"
      className={cls}
      aria-pressed={isSent ? true : undefined}
      title={safe.type === "open" ? safe.url : safe.message}
      disabled={!block.final || (safe.type === "send" && block.sent !== null) || (safe.type === "draft" && !block.draft)}
      aria-disabled={(safe.type === "send" && !block.send) || (safe.type === "draft" && !block.draft) ? true : undefined}
      onClick={(event) => block.activate(event, safe, key, trigger)}
    >
      {glyph}
      <span>{visibleLabel}</span>
      {tail ? <span className="openui-button-tail">{tail}</span> : null}
    </button>
  );
}
const Button = defineComponent({
  ...SPECS.Button,
  component: ({ props }) => <ActionButton label={String(props.label)} action={props.action} variant={props.variant} />,
});
const Actions = defineComponent({
  ...SPECS.Actions,
  component: ({ props, renderNode }) => {
    const items = list(props.items).filter((item) => isNode(item, "Button"));
    return items.length ? (
      <InsideActions.Provider value={true}>
        <div className="openui-actions" role="group">{renderNode(items)}</div>
      </InsideActions.Provider>
    ) : null;
  },
});
const EntityCard = defineComponent({
  ...SPECS.EntityCard,
  component: ({ props }) => {
    const rawTarget = typeof props.target === "string" ? props.target : "";
    if (!rawTarget) return null;
    return (
      <EntitySurface
        rawTarget={rawTarget}
        fallbackTitle={optionalPlain(props.title)}
        fallbackSubtitle={optionalPlain(props.subtitle)}
        fallbackBadge={optionalPlain(props.badge)}
        fallbackTone={oneOf(props.tone, EXTENDED_TONES)}
      />
    );
  },
});
const EntityList = defineComponent({
  ...SPECS.EntityList,
  component: ({ props, renderNode }) => {
    const items = list(props.items).filter((item) => isNode(item, "EntityCard"));
    return items.length ? <div className="openui-entities" role="list">{renderNode(items)}</div> : null;
  },
});

const Input = defineComponent({ ...SPECS.Input, component: () => null });
const Select = defineComponent({ ...SPECS.Select, component: () => null });
function FormFields({ props }: { props: Record<string, unknown> }) {
  const block = useBlock();
  const trigger = useTriggerAction();
  const key = React.useId();
  const draftKey = React.useId();
  const fields = list(props.fields) as Node[];
  const [values, setValues] = React.useState<ReadonlyMap<string, string>>(() => new Map(fields.map((field) => [String(field.props.name), field.typeName === "Select" ? String(list(field.props.options)[0] ?? "") : ""])));
  const disabled = !block.final || !block.send || block.sent !== null;
  const draft = composeDraft(String(props.template), values);
  const complete = fields.every((f) => !!values.get(String(f.props.name))?.trim());
  const cols = fields.length === 1 ? "1" : fields.length === 3 ? "3" : "2";
  const update = (name: string, value: string) => setValues((current) => new Map(current).set(name, value));
  return (
    <div className="openui-form" data-cols={cols} role="group">
      {fields.map((field) => {
        const name = String(field.props.name);
        const placeholder = optionalPlain(field.props.placeholder) ?? undefined;
        return (
          <label className="openui-field" key={name}>
            <span className="openui-field-label">{String(field.props.label)}</span>
            {field.typeName === "Input" ? (
              <input
                className="openui-input"
                type="text"
                maxLength={80}
                autoComplete="off"
                spellCheck={false}
                placeholder={placeholder}
                disabled={disabled}
                value={values.get(name) ?? ""}
                onChange={(e) => update(name, e.currentTarget.value)}
                onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
              />
            ) : (
              <span className="openui-select-wrap">
                <select
                  className="openui-select"
                  disabled={disabled}
                  value={String(list(field.props.options).indexOf(values.get(name)))}
                  onChange={(e) => { const option = list(field.props.options)[Number(e.currentTarget.value)]; if (typeof option === "string") update(name, option); }}
                  onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
                >
                  {list(field.props.options).map((option, i) => <option key={i} value={String(i)}>{String(option)}</option>)}
                </select>
                <span className="openui-select-chev" aria-hidden="true"><ChevronDownIcon /></span>
              </span>
            )}
          </label>
        );
      })}
      {complete && draft ? (
        <div className="openui-preview">
          <span className="openui-preview-label">{block.labels.previewLabel ?? "Message to send"}</span>
          <span className="openui-preview-text">{draft}</span>
        </div>
      ) : null}
      <div className="openui-form-actions">
        {block.draft ? (
          <button
            type="button"
            className={`openui-button is-draft${block.drafted === draftKey ? " is-drafted" : ""}`}
            disabled={!block.final || !complete || !draft}
            onClick={(event) => { if (complete && draft) block.activate(event, { type: "draft", message: draft, max: 480 }, draftKey, trigger); }}
          >
            {block.drafted === draftKey ? <MenuCheckGlyph className="openui-button-check" /> : <DraftIcon />}
            <span>{block.drafted === draftKey ? (block.labels.draftFilled ?? "Filled") : (block.labels.fillDraft ?? "Edit in input")}</span>
          </button>
        ) : null}
        <button
          type="button"
          className="openui-button is-primary"
          aria-pressed={block.sent === key ? true : undefined}
          title={complete && draft ? draft : String(props.submit)}
          disabled={disabled || !complete || !draft}
          onClick={(event) => { if (complete && draft) block.activate(event, { type: "send", message: draft, max: 480 }, key, trigger); }}
        >
          {block.sent === key ? <MenuCheckGlyph className="openui-button-check" /> : <SendIcon />}
          <span>{String(props.submit)}</span>
        </button>
      </div>
    </div>
  );
}
const Form = defineComponent({
  ...SPECS.Form,
  component: ({ props }) => formReady(props) ? <FormFields key={JSON.stringify(props.fields)} props={props} /> : null,
});

const CheckItem = defineComponent({ ...SPECS.CheckItem, component: () => null });
function ChecklistFields({ props }: { props: Record<string, unknown> }) {
  const block = useBlock();
  const trigger = useTriggerAction();
  const key = React.useId();
  const draftKey = React.useId();
  const items = list(props.items) as Node[];
  const [checked, setChecked] = React.useState<readonly boolean[]>(() => items.map((item) => item.props.checked === true));
  const disabled = !block.final || !block.send || block.sent !== null;
  const selectedValues = items.flatMap((item, i) => checked[i] ? [optionalPlain(item.props.value) ?? String(item.props.label)] : []);
  const draft = composeChecklistDraft(String(props.template), selectedValues);
  const countText = (block.labels.selectedCount ?? "{count} selected").replace("{count}", String(selectedValues.length));
  const toggle = (index: number) => setChecked((current) => current.map((v, i) => (i === index ? !v : v)));
  return (
    <div className="openui-checklist" role="group">
      <div className="openui-checklist-items">
        {items.map((item, i) => {
          const note = optionalPlain(item.props.note);
          const on = checked[i] === true;
          return (
            <label key={i} className={`openui-check-row${on ? " is-checked" : ""}`}>
              <input type="checkbox" className="openui-checkbox" checked={on} disabled={disabled} onChange={() => toggle(i)} />
              <span className="openui-check-body">
                <span className="openui-check-label">{String(item.props.label)}</span>
                {note ? <span className="openui-check-note">{note}</span> : null}
              </span>
            </label>
          );
        })}
      </div>
      <div className="openui-preview">
        <span className="openui-preview-label">{countText}</span>
        <span className="openui-preview-text">{draft ?? (block.labels.selectOneHint ?? "Select at least one item")}</span>
      </div>
      <div className="openui-form-actions">
        {block.draft ? (
          <button
            type="button"
            className={`openui-button is-draft${block.drafted === draftKey ? " is-drafted" : ""}`}
            disabled={!block.final || !draft}
            onClick={(event) => { if (draft) block.activate(event, { type: "draft", message: draft, max: 480 }, draftKey, trigger); }}
          >
            {block.drafted === draftKey ? <MenuCheckGlyph className="openui-button-check" /> : <DraftIcon />}
            <span>{block.drafted === draftKey ? (block.labels.draftFilled ?? "Filled") : (block.labels.fillDraft ?? "Edit in input")}</span>
          </button>
        ) : null}
        <button
          type="button"
          className="openui-button is-primary"
          aria-pressed={block.sent === key ? true : undefined}
          title={draft ?? String(props.submit)}
          disabled={disabled || !draft}
          onClick={(event) => { if (draft) block.activate(event, { type: "send", message: draft, max: 480 }, key, trigger); }}
        >
          {block.sent === key ? <MenuCheckGlyph className="openui-button-check" /> : <SendIcon />}
          <span>{String(props.submit)}</span>
        </button>
      </div>
    </div>
  );
}
const Checklist = defineComponent({
  ...SPECS.Checklist,
  component: ({ props }) => checklistReady(props) ? <ChecklistFields key={JSON.stringify(props.items)} props={props} /> : null,
});

function SnippetBox({ props }: { props: Record<string, unknown> }) {
  const { labels } = useBlock();
  const { copied, copy } = useCopyState();
  const label = plain(props.label);
  const code = typeof props.code === "string" ? props.code : "";
  const kind = oneOf(props.kind, SNIPPET_KINDS) ?? "code";
  if (!label || !code.trim()) return null;
  const lines = code.split("\n");
  return (
    <div className={`openui-snippet is-${kind}`}>
      <div className="openui-snippet-bar">
        <span className="openui-snippet-label">{label}</span>
        <button
          type="button"
          className={`openui-copy-inline${copied ? " is-copied" : ""}`}
          onClick={(event) => { if (event.nativeEvent.isTrusted) copy(code); }}
        >
          {copied ? <MenuCheckGlyph className="openui-button-check" /> : <CopyIcon />}
          <span>{copied ? (labels.copied ?? "Copied") : (labels.copy ?? "Copy")}</span>
        </button>
      </div>
      <div className="openui-snippet-body">
        {kind === "diff" ? lines.map((lineText, i) => {
          const lineCls = lineText.startsWith("+") ? " is-add" : lineText.startsWith("-") ? " is-del" : "";
          return <span key={i} className={`openui-snippet-line${lineCls}`}>{lineText || " "}</span>;
        }) : code}
      </div>
    </div>
  );
}
const Snippet = defineComponent({
  ...SPECS.Snippet,
  component: ({ props }) => <SnippetBox props={props} />,
});

const Tab = defineComponent({ ...SPECS.Tab, component: () => null });
function TabsView({ items, renderNode }: { readonly items: readonly Node[]; readonly renderNode: (nodes: unknown) => React.ReactNode }) {
  const [active, setActive] = React.useState(0);
  const safeIndex = active < items.length ? active : 0;
  const current = items[safeIndex];
  const children = current ? list(current.props.children).filter((child) => isNode(child) && LEAF_CHILD_SET.has(child.typeName)) : [];
  return (
    <div className="openui-tabs">
      <div className="openui-tablist" role="tablist">
        {items.map((item, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={i === safeIndex}
            className={`openui-tab${i === safeIndex ? " is-active" : ""}`}
            onClick={() => setActive(i)}
          >
            {plain(item.props.label)}
          </button>
        ))}
      </div>
      <div className="openui-tabpanel" role="tabpanel">{renderNode(children)}</div>
    </div>
  );
}
const Tabs = defineComponent({
  ...SPECS.Tabs,
  component: ({ props, renderNode }) => {
    const items = list(props.items).filter((item) => isNode(item, "Tab") && plain(item.props.label) !== null && list(item.props.children).length > 0) as Node[];
    return items.length >= 2 ? <TabsView items={items} renderNode={renderNode} /> : null;
  },
});

function CollapsibleView({ label, initialOpen, children, renderNode }: { readonly label: string; readonly initialOpen: boolean; readonly children: readonly unknown[]; readonly renderNode: (nodes: unknown) => React.ReactNode }) {
  const [open, setOpen] = React.useState(initialOpen);
  return (
    <div className={`openui-collapsible${open ? " is-open" : ""}`}>
      <button type="button" className="openui-collapsible-trigger" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="openui-collapsible-label">{label}</span>
        <ChevronDownIcon rotated={open} />
      </button>
      {open ? <div className="openui-collapsible-body">{renderNode(children)}</div> : null}
    </div>
  );
}
const Collapsible = defineComponent({
  ...SPECS.Collapsible,
  component: ({ props, renderNode }) => {
    const label = plain(props.label);
    const children = list(props.children).filter((child) => isNode(child) && LEAF_CHILD_SET.has(child.typeName));
    return label && children.length ? <CollapsibleView label={label} initialOpen={props.open === true} children={children} renderNode={renderNode} /> : null;
  },
});

const momentReady = (p: Record<string, unknown>) => plain(p.time) !== null && plain(p.label) !== null && (p.state == null || oneOf(p.state, STATES) !== null);
const deltaReady = (p: Record<string, unknown>) => plain(p.label) !== null && plain(p.before) !== null && plain(p.after) !== null;
const sparkReady = (p: Record<string, unknown>) => plain(p.label) !== null && Array.isArray(p.values) && p.values.length >= 2 && p.values.length <= 32 && p.values.every((v) => finite(v) && Math.abs(v) <= 1e15);
const CompareHeadings = React.createContext({ before: "", after: "" });
const Moment = defineComponent({
  ...SPECS.Moment,
  component: ({ props }) => {
    const state = oneOf(props.state, STATES);
    const note = optionalPlain(props.note);
    const stateTone = state === "done" ? " is-good" : state === "running" ? " is-warn" : state === "blocked" ? " is-bad" : state === "waiting" ? " is-wait" : "";
    return <div className={`openui-moment${stateTone}`} role="listitem">
      <span className="openui-moment-dot" aria-hidden="true" />
      <span className="openui-moment-time">{plain(props.time)}</span>
      <span className="openui-moment-line"><span className="openui-moment-label">{plain(props.label)}</span>{state ? <StateTag state={state} /> : null}{note ? <span className="openui-moment-note">{note}</span> : null}</span>
    </div>;
  },
});
const Timeline = defineComponent({
  ...SPECS.Timeline,
  component: ({ props, renderNode }) => {
    const items = list(props.items).filter((item) => isNode(item, "Moment") && momentReady(item.props));
    return items.length ? <div className="openui-timeline" role="list">{renderNode(items)}</div> : null;
  },
});
function DeltaRow({ props }: { props: Record<string, unknown> }) {
  const headings = React.useContext(CompareHeadings);
  const t = oneOf(props.tone, TONES);
  return <div className="openui-delta" role="listitem">
    <span className="openui-delta-label">{plain(props.label)}</span>
    <span className="openui-delta-before"><span className="openui-delta-caption">{headings.before}</span><span className="openui-delta-value">{plain(props.before)}</span></span>
    <span className="openui-delta-arrow" aria-hidden="true">→</span>
    <span className={`openui-delta-after${toneClass(t)}`}><span className="openui-delta-caption">{headings.after}</span><span className="openui-delta-value">{t ? <ToneLabel tone={t} /> : null}{plain(props.after)}</span></span>
  </div>;
}
const Delta = defineComponent({
  ...SPECS.Delta,
  component: ({ props }) => <DeltaRow props={props} />,
});
const Compare = defineComponent({
  ...SPECS.Compare,
  component: ({ props, renderNode }) => {
    const before = plain(props.before), after = plain(props.after);
    const items = list(props.items).filter((item) => isNode(item, "Delta") && deltaReady(item.props));
    return before && after && items.length ? <CompareHeadings.Provider value={{ before, after }}><div className="openui-compare openui-frame" role="list">
      <div className="openui-compare-head" aria-hidden="true"><span /><span>{before}</span><span /><span>{after}</span></div>{renderNode(items)}
    </div></CompareHeadings.Provider> : null;
  },
});
const Tag = defineComponent({
  ...SPECS.Tag,
  component: ({ props }) => {
    const t = oneOf(props.tone, TONES);
    return <span className={`openui-tag${toneClass(t)}`} role="listitem">{plain(props.label)}{t ? <ToneLabel tone={t} suffix /> : null}</span>;
  },
});
const Tags = defineComponent({
  ...SPECS.Tags,
  component: ({ props, renderNode }) => {
    const items = list(props.items).filter((item) => isNode(item, "Tag") && plain(item.props.label) !== null);
    return items.length ? <div className="openui-tags" role="list">{renderNode(items)}</div> : null;
  },
});
// 단조 3차 — 이웃 기울기의 부호가 다르면 접선을 0으로 두어 극값을 넘지 않는다. 좌표·제어점은 계산한 숫자뿐이다.
function smoothSparkline(points: readonly (readonly [number, number])[]): string {
  const n = points.length;
  const dx: number[] = [], slopes: number[] = [], tangents: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = points[i + 1]![0] - points[i]![0];
    slopes[i] = (points[i + 1]![1] - points[i]![1]) / dx[i]!;
  }
  tangents[0] = slopes[0]!;
  tangents[n - 1] = slopes[n - 2]!;
  for (let i = 1; i < n - 1; i++) {
    const left = slopes[i - 1]!, right = slopes[i]!;
    tangents[i] = left * right <= 0 ? 0 : 3 * (dx[i - 1]! + dx[i]!) / ((2 * dx[i]! + dx[i - 1]!) / left + (dx[i]! + 2 * dx[i - 1]!) / right);
  }
  const round2 = (value: number) => Math.round(value * 100) / 100;
  let d = `M${round2(points[0]![0])} ${round2(points[0]![1])}`;
  for (let i = 0; i < n - 1; i++) {
    const [x, y] = points[i]!, [nextX, nextY] = points[i + 1]!;
    d += ` C${round2(x + dx[i]! / 3)} ${round2(y + tangents[i]! * dx[i]! / 3)} ${round2(nextX - dx[i]! / 3)} ${round2(nextY - tangents[i + 1]! * dx[i]! / 3)} ${round2(nextX)} ${round2(nextY)}`;
  }
  return d;
}
const Sparkline = defineComponent({
  ...SPECS.Sparkline,
  component: ({ props }) => {
    if (!sparkReady(props)) return null;
    const values = props.values as number[];
    const lo = Math.min(...values), hi = Math.max(...values);
    const round2 = (v: number) => Math.round(v * 100) / 100;
    const points = values.map((v, i): readonly [number, number] => [round2(i / (values.length - 1) * 100), round2(hi === lo ? 10 : 2 + (1 - (v - lo) / (hi - lo)) * 16)]);
    const unit = typeof props.unit === "string" ? props.unit.slice(0, MAX_UNIT) : "";
    const t = oneOf(props.tone, TONES);
    const format = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
    const first = values[0]!;
    const last = values[values.length - 1]!;
    const pctChange = first !== 0 ? Math.round(((last - first) / Math.abs(first)) * 100) : null;
    const deltaLabel = pctChange !== null && Number.isFinite(pctChange) && Math.abs(pctChange) <= 9999
      ? `${pctChange > 0 ? "+" : ""}${pctChange}%`
      : null;
    return <React.Fragment>
      <span className="openui-bar-label">{plain(props.label)}</span>
      <svg className={`openui-spark${toneClass(t)}`} viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d={smoothSparkline(points)} fill="none" vectorEffect="non-scaling-stroke" /></svg>
      <span className={`openui-bar-value openui-spark-value${toneClass(t)}`}>
        <span className="openui-sr">{`${format.format(first)}${unit} → `}</span>
        {deltaLabel ? <span className="openui-spark-delta">{deltaLabel}</span> : null}
        <span>{`${format.format(last)}${unit}`}</span>
      </span>
    </React.Fragment>;
  },
});
const Sparklines = defineComponent({
  ...SPECS.Sparklines,
  component: ({ props, renderNode }) => {
    const items = list(props.items).filter((item) => isNode(item, "Sparkline") && sparkReady(item.props));
    return items.length ? <div className="openui-bars openui-sparklines">{renderNode(items)}</div> : null;
  },
});
const Card = defineComponent({
  ...SPECS.Card,
  component: ({ props, renderNode }) => {
    const title = plain(props.title);
    const subtitle = optionalPlain(props.subtitle);
    const children = list(props.children).filter((child) => !!child && typeof child === "object" && CARD_CHILD_SET.has((child as Node).typeName));
    return (
      <section className="openui">
        {title || subtitle ? (
          <div className="openui-head">
            {title ? <p className="openui-title">{title}</p> : null}
            {subtitle ? <span className="openui-subtitle">{subtitle}</span> : null}
          </div>
        ) : null}
        {renderNode(children)}
      </section>
    );
  },
});

export const library = createLibrary({
  components: [
    Card, Stats, Stat, Steps, Step, Bars, Table, Facts, Fact, Callout, Progress, Choices, Choice,
    Timeline, Moment, Compare, Delta, Tags, Tag, Sparklines, Sparkline, Button, Actions, Form, Input, Select,
    EntityCard, EntityList, Checklist, CheckItem, Tabs, Tab, Collapsible, Snippet, Breakdown, Segment,
  ],
  root: "Card",
});

/** 정제 판정 — 확정이면 render(정제한 원문) 또는 hide, 흐르는 중이면 render 또는 hold. Renderer 에 원문을 넘기기 전에 동기로 한 번. */
export function judge(source: string, final: boolean): Verdict {
  return prune(source, final).verdict;
}

/** 블록 하나의 React 트리 — 클릭 클로저가 만든 일회 허가만 onAction에서 소비한다. Query·toolProvider는 주지 않는다. */
export function OpenUIView({
  source,
  final,
  labels,
  send,
  open,
  draft = null,
}: {
  readonly source: string;
  readonly final: boolean;
  readonly labels: OpenUIRenderLabels;
  readonly send: OpenUISendPort | null;
  readonly open: OpenUIOpenPort | null;
  readonly draft?: OpenUIDraftPort | null;
}) {
  const [sent, setSent] = React.useState<string | null>(null);
  const [drafted, setDrafted] = React.useState<string | null>(null);
  const draftTimer = React.useRef<number | null>(null);
  const locked = React.useRef(false);
  const grant = React.useRef<{ action: SafeAction; at: { x: number; y: number } } | null>(null);
  React.useEffect(() => () => { if (draftTimer.current !== null) window.clearTimeout(draftTimer.current); }, []);
  const activate: BlockContext["activate"] = (event, action, key, trigger) => {
    if (!event.nativeEvent.isTrusted || !final) return;
    if (action.type === "draft") {
      if (!draft || !sendableText(action.message, action.max)) return;
      draft(action.message);
      setDrafted(key);
      if (draftTimer.current !== null) window.clearTimeout(draftTimer.current);
      draftTimer.current = window.setTimeout(() => { draftTimer.current = null; setDrafted(null); }, 1800);
      return;
    }
    const target = action.type === "open" ? parseOpenUIOpenTarget(action.url) : null;
    if (action.type === "send") {
      if (locked.current || !send || !sendableText(action.message, action.max)) return;
      locked.current = true;
      setSent(key);
    } else if (!target || !open?.accepts(target)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    grant.current = { action, at: event.detail === 0 ? { x: rect.left + rect.width / 2, y: rect.bottom } : { x: event.clientX, y: event.clientY } };
    const plan: ActionPlan = { steps: [action.type === "send" ? { type: "continue_conversation", message: action.message } : { type: "open_url", url: action.url }] };
    // 허용 단계는 onAction을 동기로 부른다. 다른 시점의 이벤트에는 허가가 없다.
    try { void trigger(action.type === "send" ? action.message : "", undefined, plan); } finally { grant.current = null; }
  };
  return <Block.Provider value={{ labels, final, send, open, draft, sent, drafted, activate }}>
    <Renderer.Root response={source} library={library} isStreaming={!final} publishObservability={false} onAction={(event) => {
      const allowed = grant.current;
      grant.current = null;
      if (!allowed || !final) return;
      if (event.type === BuiltinActionType.ContinueConversation && allowed.action.type === "send" && !Object.keys(event.params).length) {
        const message = sendableText(event.humanFriendlyMessage, allowed.action.max);
        if (message && message === allowed.action.message) send?.(message);
      } else if (event.type === BuiltinActionType.OpenUrl && allowed.action.type === "open" && event.params.url === allowed.action.url) {
        const target = parseOpenUIOpenTarget(event.params.url);
        if (target && open?.accepts(target)) open.open(target, allowed.at);
      }
    }}><Renderer.Content className="openui-content" /></Renderer.Root>
  </Block.Provider>;
}
