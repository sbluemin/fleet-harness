/**
 * OpenUI 렌더러 — Fleet 소유 컴포넌트를 담은 지연 청크.
 * react-lang 라이브러리 등록(등록 스키마는 openui-prune 의 SPECS 그대로) + Fleet 컴포넌트. 판정은 openui-prune 의 정제가 맡고,
 * 렌더러에는 정제한 원문만 넘긴다.
 */
import "./openui-devtools-guard.js";

import { BuiltinActionType, createLibrary, defineComponent, Renderer, useTriggerAction, type ActionPlan } from "@openuidev/react-lang";
import { composeDraft, parseOpenUIOpenTarget, sendableReply, sendableText, type OpenUIOpenPort, type OpenUISendPort } from "./openui-actions.js";
import { formReady, isNode, list, prune, SPECS, sourceAction, STATES, TONES, type Node, type SafeAction, type Verdict } from "./openui-prune.js";
export { composeDraft, sendableDraft, sendableReply } from "./openui-actions.js";
import * as React from "react";
import { z } from "zod";

export type OpenUIState = "todo" | "running" | "waiting" | "done" | "blocked";
export type OpenUITone = "good" | "warn" | "bad";
export interface OpenUIRenderLabels {
  readonly states: Readonly<Record<OpenUIState, string>>;
  readonly tones: Readonly<Record<OpenUITone, string>>;
}

const MAX_TEXT = 200;
const MAX_UNIT = 8;
// 블록마다 바뀌는 값(라벨·확정·포트)은 컨텍스트로 — 라이브러리는 모듈에 하나다.
interface BlockContext {
  readonly labels: OpenUIRenderLabels;
  readonly final: boolean;
  readonly send: OpenUISendPort | null;
  readonly open: OpenUIOpenPort | null;
  readonly sent: string | null;
  readonly activate: (event: React.MouseEvent<HTMLButtonElement>, action: SafeAction, key: string, trigger: ReturnType<typeof useTriggerAction>) => void;
}
const Block = React.createContext<BlockContext | null>(null);
const useBlock = () => React.useContext(Block)!;

function plain(value: unknown): string | null {
  const raw = typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
  if (raw === null) return null;
  return raw.length > MAX_TEXT ? `${raw.slice(0, MAX_TEXT - 1)}…` : raw;
}
// 선택 설명은 공백만 있어도 생략과 같다. 필수 문장·전송 값은 이 규칙으로 정규화하지 않는다.
const optionalPlain = (value: unknown): string | null => typeof value === "string" && !value.trim() ? null : plain(value);
const oneOf = <T extends string>(value: unknown, options: readonly T[]): T | null =>
  typeof value === "string" && (options as readonly string[]).includes(value) ? (value as T) : null;

const toneClass = (tone: OpenUITone | null) => tone ? ` is-${tone}` : "";
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
const StepIndex = React.createContext(0);
function StepRow({ props }: { props: Record<string, unknown> }) {
  const index = React.useContext(StepIndex);
  const state = oneOf(props.state, STATES)!;
  const note = optionalPlain(props.note);
  return <div className={`openui-step is-${state}`} role="listitem">
    <span className="openui-step-index" aria-hidden="true">{index}</span>
    <span className="openui-step-body"><span className="openui-step-label">{plain(props.label)}</span>{note ? <span className="openui-step-note">{note}</span> : null}</span>
    <StateTag state={state} />
  </div>;
}

const statReady = (p: Record<string, unknown>) => plain(p.label) !== null && plain(p.value) !== null;
const stepReady = (p: Record<string, unknown>) => plain(p.label) !== null && oneOf(p.state, STATES) !== null;
const factReady = (p: Record<string, unknown>) => plain(p.label) !== null && plain(p.value) !== null;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
// 흐르는 중 판정은 더 와도 풀리지 않는 위반만 보므로(열린 숫자는 아님) 컴포넌트도 같은 조건을 본다 — 0 ≤ done ≤ total, total > 0.
const progressReady = (p: Record<string, unknown>) =>
  plain(p.label) !== null && finite(p.done) && finite(p.total) && p.total > 0 && p.done >= 0 && p.done <= p.total;

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
    return items.length ? <div className="openui-steps" role="list">{items.map((item, i) => <StepIndex.Provider key={i} value={i + 1}>{renderNode(item)}</StepIndex.Provider>)}</div> : null;
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
    const max = Math.max(...pairs.map((p) => p.value), unit === "%" ? 100 : 0);
    const format = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
    return (
      <div className="openui-bars">
        {pairs.map((p, i) => (
          <React.Fragment key={i}>
            <span className="openui-bar-label">{p.label}</span>
            <span className="openui-bar-track"><span className="openui-bar-fill" style={{ width: `${max > 0 ? Math.min(100, Math.max(0, (p.value / max) * 100)) : 0}%` }} /></span>
            <span className="openui-bar-value">{`${format.format(p.value)}${unit}`}</span>
          </React.Fragment>
        ))}
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
const Fact = defineComponent({
  ...SPECS.Fact,
  component: ({ props }) => {
    const t = oneOf(props.tone, TONES);
    return (
      <div className="openui-fact" role="listitem">
        <span className="openui-fact-label">{plain(props.label)}</span>
        <span className={`openui-fact-value${toneClass(t)}`}>{t ? <ToneLabel tone={t} /> : null}{plain(props.value)}</span>
      </div>
    );
  },
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
    return (
      <div className={`openui-callout openui-rule${toneClass(t)}`} role="note">
        {t ? <ToneLabel tone={t} /> : null}
        <span className="openui-callout-text">{sentence}</span>
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
    const format = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
    return (
      <div className="openui-bars openui-progress">
        <span className="openui-bar-label">{plain(props.label)}</span>
        <span className="openui-bar-track"><span className="openui-bar-fill" style={{ width: `${Math.min(100, Math.max(0, (done / total) * 100))}%` }} /></span>
        <span className="openui-bar-value">{`${format.format(done)}/${format.format(total)}`}</span>
        {note ? <span className="openui-progress-note">{note}</span> : null}
      </div>
    );
  },
});
// 은퇴한 선택지 — 안내 문면에서 빠져 새 답에는 나오지 않는다. 옛 기록의 카드가 코드 블록으로 떨어지지 않도록 파서 등록과 판정은
// 남기되, 아무것도 그리지 않고 Card 도 자식에서 거른다. 형제(표·사실·단추)는 그대로 그린다.
const Choice = defineComponent({
  ...SPECS.Choice,
  component: () => null,
});
const Choices = defineComponent({
  ...SPECS.Choices,
  component: () => null,
});

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
function runtimeAction(value: unknown, label: unknown): SafeAction | null {
  if (value == null) return sourceAction(value, label);
  const plan = runtimePlan.safeParse(value);
  if (!plan.success) return null;
  const step = plan.data.steps[0];
  if (step.type === "open_url") return parseOpenUIOpenTarget(step.url) ? { type: "open", url: step.url } : null;
  const message = sendableReply(step.message);
  return message ? { type: "send", message, max: 200 } : null;
}
function ActionButton({ label, action }: { label: string; action: unknown }) {
  const block = useBlock();
  const trigger = useTriggerAction();
  const key = React.useId();
  const safe = runtimeAction(action, label);
  if (!safe) {
    const refused = refusedRuntimeOpen(action);
    return refused === null ? null : <span className="openui-inert is-inert" title={refused}><span>{label}</span></span>;
  }
  const target = safe.type === "open" ? parseOpenUIOpenTarget(safe.url) : null;
  const tail = target?.kind === "https" ? target.hostname : target?.kind === "objective" || target?.kind === "commodore" ? `${target.kind}:${target.id.slice(0, 8)}` : target?.kind === "mission" ? `mission:${target.number}` : null;
  const contents = <><span>{label}</span>{tail ? <span className={`openui-button-tail${target?.kind === "https" ? "" : " is-internal"}`}>{tail}</span> : null}</>;
  if (target && !block.open?.accepts(target)) return <span className="openui-inert is-inert" title={safe.type === "open" ? safe.url : undefined}>{contents}</span>;
  return <button type="button" className="openui-button" aria-pressed={block.sent === key ? true : undefined} title={safe.type === "open" ? safe.url : safe.message}
    disabled={!block.final || (safe.type === "send" && block.sent !== null)} aria-disabled={safe.type === "send" && !block.send ? true : undefined}
    onClick={(event) => block.activate(event, safe, key, trigger)}>{contents}</button>;
}
const Button = defineComponent({
  ...SPECS.Button,
  component: ({ props }) => <ActionButton label={String(props.label)} action={props.action} />,
});

const Input = defineComponent({ ...SPECS.Input, component: () => null });
const Select = defineComponent({ ...SPECS.Select, component: () => null });
function FormFields({ props }: { props: Record<string, unknown> }) {
  const block = useBlock();
  const trigger = useTriggerAction();
  const key = React.useId();
  const fields = list(props.fields) as Node[];
  const [values, setValues] = React.useState<ReadonlyMap<string, string>>(() => new Map(fields.map((field) => [String(field.props.name), field.typeName === "Select" ? String(list(field.props.options)[0] ?? "") : ""])));
  const disabled = !block.final || !block.send || block.sent !== null;
  const draft = composeDraft(String(props.template), values);
  const complete = fields.every((f) => !!values.get(String(f.props.name))?.trim());
  const update = (name: string, value: string) => setValues((current) => new Map(current).set(name, value));
  return <div className="openui-form" role="group">{fields.map((field) => {
    const name = String(field.props.name);
    return <label className="openui-field" key={name}><span className="openui-field-label">{String(field.props.label)}</span>{field.typeName === "Input"
      ? <input className="openui-input" type="text" maxLength={80} autoComplete="off" spellCheck={false} disabled={disabled} value={values.get(name) ?? ""} onChange={(e) => update(name, e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} />
      : <select className="openui-select" disabled={disabled} value={String(list(field.props.options).indexOf(values.get(name)))} onChange={(e) => { const option = list(field.props.options)[Number(e.currentTarget.value)]; if (typeof option === "string") update(name, option); }} onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}>{list(field.props.options).map((option, i) => <option key={i} value={String(i)}>{String(option)}</option>)}</select>}</label>;
  })}<div className="openui-form-actions"><button type="button" className="openui-button is-primary" aria-pressed={block.sent === key ? true : undefined} title={String(props.template)} disabled={disabled || !complete || !draft}
    onClick={(event) => { if (complete && draft) block.activate(event, { type: "send", message: draft, max: 480 }, key, trigger); }}>{String(props.submit)}</button></div></div>;
}
const Form = defineComponent({
  ...SPECS.Form,
  component: ({ props }) => formReady(props) ? <FormFields key={JSON.stringify(props.fields)} props={props} /> : null,
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
    return <div className="openui-moment" role="listitem">
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
      <div className="openui-compare-head" aria-hidden="true"><span /><span>{before}</span><span>{after}</span></div>{renderNode(items)}
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
    const format = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
    return <React.Fragment>
      <span className="openui-bar-label">{plain(props.label)}</span>
      <svg className="openui-spark" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d={smoothSparkline(points)} fill="none" vectorEffect="non-scaling-stroke" /></svg>
      <span className="openui-bar-value"><span className="openui-sr">{`${format.format(values[0]!)}${unit} → `}</span>{`${format.format(values[values.length - 1]!)}${unit}`}</span>
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
const CHILDREN = new Set(["Stats", "Steps", "Bars", "Table", "Facts", "Callout", "Progress", "Timeline", "Compare", "Tags", "Sparklines", "Button", "Form"]);
const Card = defineComponent({
  ...SPECS.Card,
  component: ({ props, renderNode }) => {
    const title = plain(props.title);
    const children = list(props.children).filter((child) => !!child && typeof child === "object" && CHILDREN.has((child as Node).typeName));
    return (
      <section className="openui">
        {title ? <p className="openui-title">{title}</p> : null}
        {renderNode(children)}
      </section>
    );
  },
});

export const library = createLibrary({ components: [Card, Stats, Stat, Steps, Step, Bars, Table, Facts, Fact, Callout, Progress, Choices, Choice, Timeline, Moment, Compare, Delta, Tags, Tag, Sparklines, Sparkline, Button, Form, Input, Select], root: "Card" });

/** 정제 판정 — 확정이면 render(정제한 원문) 또는 hide, 흐르는 중이면 render 또는 hold. Renderer 에 원문을 넘기기 전에 동기로 한 번. */
export function judge(source: string, final: boolean): Verdict {
  return prune(source, final).verdict;
}

/** 블록 하나의 React 트리 — 클릭 클로저가 만든 일회 허가만 onAction에서 소비한다. Query·toolProvider는 주지 않는다. */
export function OpenUIView({ source, final, labels, send, open }: { source: string; final: boolean; labels: OpenUIRenderLabels; send: OpenUISendPort | null; open: OpenUIOpenPort | null }) {
  const [sent, setSent] = React.useState<string | null>(null);
  const locked = React.useRef(false);
  const grant = React.useRef<{ action: SafeAction; at: { x: number; y: number } } | null>(null);
  const activate: BlockContext["activate"] = (event, action, key, trigger) => {
    if (!event.nativeEvent.isTrusted || !final) return;
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
  return <Block.Provider value={{ labels, final, send, open, sent, activate }}>
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
