/**
 * OpenUI 렌더러 — Fleet 소유 컴포넌트와 엄격 판정을 담은 지연 청크.
 * react-lang 라이브러리 등록(이름·위치 시그니처는 현행과 같은 Zod 객체) + Fleet 컴포넌트 + 엄격 판정(judge).
 */
import "./openui-devtools-guard.js";

import { BuiltinActionType, createLibrary, createParser, defineComponent, Renderer, steps, useTriggerAction, type ActionPlan, type ParseResult } from "@openuidev/react-lang";
import { composeDraft, parseOpenUIOpenTarget, sendableReply, sendableText, type OpenUIOpenPort, type OpenUISendPort } from "./openui-actions.js";
export { composeDraft, sendableDraft, sendableReply } from "./openui-actions.js";
import * as React from "react";
import { z } from "zod";

export type OpenUIState = "todo" | "running" | "waiting" | "done" | "blocked";
export type OpenUITone = "good" | "warn" | "bad";
export interface OpenUIRenderLabels {
  readonly states: Readonly<Record<OpenUIState, string>>;
  readonly tones: Readonly<Record<OpenUITone, string>>;
}

const MAX_SOURCE = 16 * 1024;
const MAX_TEXT = 200;
const MAX_UNIT = 8;
const STATES = ["todo", "running", "waiting", "done", "blocked"] as const;
const TONES = ["good", "warn", "bad"] as const;
const TONE_DOT: Record<OpenUITone, OpenUIState> = { good: "done", warn: "running", bad: "blocked" };

// ---- 1. 등록 스키마 — 기존 모델 계약과 같은 Zod 객체(이름·키 순서 = 위치 인자). 바꾸지 않는다.
const text = z.union([z.string(), z.number()]);
const tone = z.enum(TONES).optional();

// 블록마다 바뀌는 값(라벨·확정·포트)은 컨텍스트로 — 라이브러리는 모듈에 하나다.
type SafeAction = { readonly type: "send"; readonly message: string; readonly max: 200 | 480 } | { readonly type: "open"; readonly url: string };
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

type Node = { type: "element"; typeName: string; props: Record<string, unknown> };
const isNode = (value: unknown, name: string): value is Node =>
  !!value && typeof value === "object" && (value as Node).type === "element" && (value as Node).typeName === name && !!(value as Node).props;
const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
function plain(value: unknown): string | null {
  const raw = typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
  if (raw === null) return null;
  return raw.length > MAX_TEXT ? `${raw.slice(0, MAX_TEXT - 1)}…` : raw;
}
const oneOf = <T extends string>(value: unknown, options: readonly T[]): T | null =>
  typeof value === "string" && (options as readonly string[]).includes(value) ? (value as T) : null;

function Dot({ state, label }: { state: OpenUIState; label: string }) {
  return <span className={`openui-dot is-${state}`} role="img" aria-label={label} />;
}
// 블록 컨텍스트는 대문자 컴포넌트 안에서만 읽는다 — defineComponent 의 component 콜백은 React 가 컴포넌트로 보지 않아 훅 규칙에 걸린다.
function ToneDot({ tone }: { tone: OpenUITone }) {
  const { labels } = useBlock();
  return <Dot state={TONE_DOT[tone]} label={labels.tones[tone]} />;
}
function StateDot({ state }: { state: OpenUIState }) {
  const { labels } = useBlock();
  return <Dot state={state} label={labels.states[state]} />;
}

const statReady = (p: Record<string, unknown>) => plain(p.label) !== null && plain(p.value) !== null;
const stepReady = (p: Record<string, unknown>) => plain(p.label) !== null && oneOf(p.state, STATES) !== null;
const choiceReady = (p: Record<string, unknown>) => typeof p.label === "string" && p.label.trim() !== "" && sendableReply(p.reply) !== null;
const factReady = (p: Record<string, unknown>) => plain(p.label) !== null && plain(p.value) !== null;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
// 흐르는 중에는 판정(LIMITS)이 돌지 않으므로 컴포넌트도 같은 조건을 본다 — 0 ≤ done ≤ total, total > 0.
const progressReady = (p: Record<string, unknown>) =>
  plain(p.label) !== null && finite(p.done) && finite(p.total) && p.total > 0 && p.done >= 0 && p.done <= p.total;

const Stat = defineComponent({
  name: "Stat",
  description: "One metric tile.",
  props: z.object({ label: z.string(), value: text, note: text.optional(), tone }),
  component: ({ props }) => {
    const t = oneOf(props.tone, TONES);
    const note = plain(props.note);
    return (
      <div className="openui-stat">
        <span className="openui-stat-label">{t ? <ToneDot tone={t} /> : null}{plain(props.label)}</span>
        <span className="openui-stat-value">{plain(props.value)}</span>
        {note ? <span className="openui-stat-note">{note}</span> : null}
      </div>
    );
  },
});
const Stats = defineComponent({
  name: "Stats",
  description: "Row of up to four metric tiles.",
  props: z.object({ items: z.array(Stat.ref) }),
  component: ({ props, renderNode }) => {
    const items = list(props.items).filter((item) => isNode(item, "Stat") && statReady(item.props));
    return items.length ? <div className="openui-stats openui-face" role="group">{renderNode(items)}</div> : null;
  },
});
const Step = defineComponent({
  name: "Step",
  description: "One work item and its state.",
  props: z.object({ label: z.string(), state: z.enum(STATES), note: text.optional() }),
  component: ({ props }) => {
    const state = oneOf(props.state, STATES)!;
    const note = plain(props.note);
    return (
      <div className={`openui-step is-${state}`} role="listitem">
        <StateDot state={state} />
        <span className="openui-step-label">{plain(props.label)}</span>
        {note ? <span className="openui-step-note">{note}</span> : null}
      </div>
    );
  },
});
const Steps = defineComponent({
  name: "Steps",
  description: "List of work items with their states.",
  props: z.object({ items: z.array(Step.ref) }),
  component: ({ props, renderNode }) => {
    const items = list(props.items).filter((item) => isNode(item, "Step") && stepReady(item.props));
    return items.length ? <div className="openui-steps openui-face" role="list">{renderNode(items)}</div> : null;
  },
});
const Bars = defineComponent({
  name: "Bars",
  description: "Horizontal bars for label/value pairs.",
  props: z.object({ labels: z.array(z.string()), values: z.array(z.number()), unit: z.string().optional() }),
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
      <div className="openui-bars openui-face">
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
  name: "Table",
  description: "Compact table; rows are arrays of cells.",
  props: z.object({ columns: z.array(z.string()), rows: z.array(z.array(text)) }),
  component: ({ props }) => {
    const columns = list(props.columns);
    if (!columns.length) return null;
    return (
      <div className="openui-table-frame openui-face">
        <table className="openui-table">
          <thead><tr>{columns.map((c, i) => <th key={i}>{plain(c) ?? ""}</th>)}</tr></thead>
          <tbody>{list(props.rows).map((row, r) => <tr key={r}>{columns.map((_, i) => <td key={i}>{plain(list(row)[i]) ?? ""}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  },
});
const Fact = defineComponent({
  name: "Fact",
  description: "One label/value detail.",
  props: z.object({ label: z.string(), value: text, tone }),
  component: ({ props }) => {
    const t = oneOf(props.tone, TONES);
    return (
      <div className="openui-fact" role="listitem">
        <span className="openui-fact-label">{t ? <ToneDot tone={t} /> : null}{plain(props.label)}</span>
        <span className="openui-fact-value">{plain(props.value)}</span>
      </div>
    );
  },
});
const Facts = defineComponent({
  name: "Facts",
  description: "Label/value details such as PR, commit or check result.",
  props: z.object({ items: z.array(Fact.ref) }),
  component: ({ props, renderNode }) => {
    const items = list(props.items).filter((item) => isNode(item, "Fact") && factReady(item.props));
    return items.length ? <div className="openui-facts openui-face" role="list">{renderNode(items)}</div> : null;
  },
});
const Callout = defineComponent({
  name: "Callout",
  description: "One sentence to stand out.",
  props: z.object({ text: z.string(), tone }),
  component: ({ props }) => {
    const sentence = plain(props.text);
    if (!sentence) return null;
    const t = oneOf(props.tone, TONES);
    return (
      <div className="openui-callout openui-face" role="note">
        {t ? <ToneDot tone={t} /> : null}
        <span className="openui-callout-text">{sentence}</span>
      </div>
    );
  },
});
// 분수 진행률 — 막대의 한 줄 문법(이름 · 트랙 · 값)을 그대로 입는다. 값은 "done/total", 채움 폭은 계산한 비율 하나다.
const Progress = defineComponent({
  name: "Progress",
  description: "Fractional progress such as 3 of 5 missions.",
  props: z.object({ label: z.string(), done: z.number(), total: z.number(), note: text.optional() }),
  component: ({ props }) => {
    if (!progressReady(props)) return null;
    const done = props.done as number;
    const total = props.total as number;
    const note = plain(props.note);
    const format = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
    return (
      <div className="openui-bars openui-progress openui-face">
        <span className="openui-bar-label">{plain(props.label)}</span>
        <span className="openui-bar-track"><span className="openui-bar-fill" style={{ width: `${Math.min(100, Math.max(0, (done / total) * 100))}%` }} /></span>
        <span className="openui-bar-value">{`${format.format(done)}/${format.format(total)}`}</span>
        {note ? <span className="openui-progress-note">{note}</span> : null}
      </div>
    );
  },
});
const DecisionLayout = React.createContext(false);
function ChoiceButton({ label, reply, why, effect }: { label: string; reply: string; why?: string; effect?: string }) {
  const block = useBlock();
  const decision = React.useContext(DecisionLayout);
  const trigger = useTriggerAction();
  const key = React.useId();
  return <button type="button" className={`${decision ? "openui-option" : "openui-choice"}${block.sent === key ? " is-selected" : ""}`} title={reply}
    disabled={!block.final || block.sent !== null} aria-disabled={block.final && !block.send ? true : undefined}
    onClick={(event) => block.activate(event, { type: "send", message: reply, max: 200 }, key, trigger)}>
    {decision ? <><span className="openui-option-label">{label}</span>{why ? <span className="openui-option-why">{why}</span> : null}{effect ? <span className="openui-option-effect">{effect}</span> : null}</> : label}
  </button>;
}
const Choice = defineComponent({
  name: "Choice",
  description: "One answer sent as the person's message when clicked.",
  props: z.object({ label: z.string(), reply: z.string(), why: z.string().optional(), effect: z.string().optional() }),
  component: ({ props }) => <ChoiceButton label={(props.label as string).trim()} reply={sendableReply(props.reply)!} {...(typeof props.why === "string" ? { why: props.why } : {})} {...(typeof props.effect === "string" ? { effect: props.effect } : {})} />,
});
const Choices = defineComponent({
  name: "Choices",
  description: "Two to four answers the person can pick.",
  props: z.object({ items: z.array(Choice.ref) }),
  component: ({ props, renderNode }) => {
    const items = list(props.items).filter((item) => isNode(item, "Choice") && choiceReady(item.props));
    const decision = items.some((item) => isNode(item, "Choice") && (plain(item.props.why) || plain(item.props.effect)));
    return items.length ? <DecisionLayout.Provider value={decision}><div className={decision ? "openui-decision openui-face" : "openui-choices"} role="group">{renderNode(items)}</div></DecisionLayout.Provider> : null;
  },
});

// 등록 때는 액션 문법을 알리지만, 판정은 단일 리터럴 단계만 허용한다. Action·Run·상태 변경은 실행기에 닿지 않는다.
function sourceAction(value: unknown, label: unknown): SafeAction | null {
  if (value == null) {
    const message = sendableReply(label);
    return message ? { type: "send", message, max: 200 } : null;
  }
  const action = z.object({ k: z.literal("Comp"), name: z.enum(["OpenUrl", "ToAssistant"]), args: z.tuple([z.object({ k: z.literal("Str"), v: z.string() }).strict()]), mappedProps: z.record(z.string(), z.unknown()).optional() }).strict().safeParse(value);
  if (!action.success) return null;
  const raw = action.data.args[0].v;
  if (action.data.name === "OpenUrl") return parseOpenUIOpenTarget(raw) ? { type: "open", url: raw } : null;
  const message = sendableReply(raw);
  return message ? { type: "send", message, max: 200 } : null;
}
function runtimeAction(value: unknown, label: unknown): SafeAction | null {
  if (value == null) return sourceAction(value, label);
  const plan = z.object({ steps: z.tuple([z.union([
    z.object({ type: z.literal("open_url"), url: z.string() }).strict(),
    z.object({ type: z.literal("continue_conversation"), message: z.string() }).strict(),
  ])]) }).strict().safeParse(value);
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
  if (!safe) return null;
  const target = safe.type === "open" ? parseOpenUIOpenTarget(safe.url) : null;
  const tail = target?.kind === "https" ? target.hostname : target?.kind === "objective" ? `objective:${target.id.slice(0, 8)}` : target?.kind === "mission" ? `mission:${target.number}` : null;
  const contents = <><span>{label}</span>{tail ? <span className="openui-button-target">{tail}</span> : null}</>;
  if (target && !block.open?.accepts(target)) return <span className="openui-button is-inert" title={safe.type === "open" ? safe.url : undefined}>{contents}</span>;
  return <button type="button" className={`openui-choice openui-button${block.sent === key ? " is-selected" : ""}`} title={safe.type === "open" ? safe.url : safe.message}
    disabled={!block.final || (safe.type === "send" && block.sent !== null)} aria-disabled={safe.type === "send" && !block.send ? true : undefined}
    onClick={(event) => block.activate(event, safe, key, trigger)}>{contents}</button>;
}
const Button = defineComponent({
  name: "Button", description: "Send a message or ask the host to open a visible target.",
  props: z.object({ label: z.string(), action: z.union([steps.OpenUrl.ref, steps.ToAssistant.ref]).optional() }),
  component: ({ props }) => <ActionButton label={String(props.label)} action={props.action} />,
});

const fieldName = z.string().regex(/^[a-z][a-z0-9_]{0,15}$/);
// 한 줄 판정은 표시용 문장에도 적용한다. 명령 접두 규칙은 전송 문장에만 적용한다.
const line = (max: number) => z.string().refine((v) => {
  const t = v.trim();
  // eslint-disable-next-line no-control-regex
  return !!t && t.length <= max && !/[\u0000-\u001f\u007f\p{Zl}\p{Zp}]/u.test(v);
});
const inputLimit = z.object({ name: fieldName, label: line(40) });
const selectLimit = inputLimit.extend({ options: z.array(line(40)).min(2).max(6).refine((values) => new Set(values).size === values.length) });
function formReady(p: Record<string, unknown>): boolean {
  const fields = list(p.fields);
  if (!fields.length || fields.length > 4 || typeof p.template !== "string" || !line(160).safeParse(p.template).success) return false;
  const names = fields.flatMap((f) => isNode(f, "Input") && inputLimit.safeParse(f.props).success || isNode(f, "Select") && selectLimit.safeParse(f.props).success ? [(f as Node).props.name as string] : []);
  if (names.length !== fields.length || new Set(names).size !== names.length || /^[{/@]/u.test(p.template.trim())) return false;
  const used = new Set<string>();
  const rest = p.template.replace(/\{([a-z][a-z0-9_]{0,15})\}/g, (_, name: string) => { used.add(name); return ""; });
  return !/[{}]/u.test(rest) && names.every((name) => used.has(name)) && [...used].every((name) => names.includes(name));
}
const Input = defineComponent({ name: "Input", description: "One single-line field.", props: z.object({ name: z.string(), label: z.string() }), component: () => null });
const Select = defineComponent({ name: "Select", description: "Choose one value.", props: z.object({ name: z.string(), label: z.string(), options: z.array(z.string()) }), component: () => null });
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
  return <div className="openui-form openui-face" role="group"><div className="openui-fields">{fields.map((field) => {
    const name = String(field.props.name);
    return <label className="openui-field" key={name}><span>{String(field.props.label)}</span>{field.typeName === "Input"
      ? <input type="text" maxLength={80} autoComplete="off" spellCheck={false} disabled={disabled} value={values.get(name) ?? ""} onChange={(e) => update(name, e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} />
      : <select disabled={disabled} value={String(list(field.props.options).indexOf(values.get(name)))} onChange={(e) => { const option = list(field.props.options)[Number(e.currentTarget.value)]; if (typeof option === "string") update(name, option); }} onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}>{list(field.props.options).map((option, i) => <option key={i} value={String(i)}>{String(option)}</option>)}</select>}</label>;
  })}</div><button type="button" className={`openui-choice${block.sent === key ? " is-selected" : ""}`} title={String(props.template)} disabled={disabled || !complete || !draft}
    onClick={(event) => { if (complete && draft) block.activate(event, { type: "send", message: draft, max: 480 }, key, trigger); }}>{String(props.submit)}</button></div>;
}
const Form = defineComponent({
  name: "Form", description: "A few fields composing one message, sent only when clicked.",
  props: z.object({ fields: z.array(z.union([Input.ref, Select.ref])), template: z.string(), submit: z.string() }),
  component: ({ props }) => formReady(props) ? <FormFields key={JSON.stringify(props.fields)} props={props} /> : null,
});
const momentReady = (p: Record<string, unknown>) => plain(p.time) !== null && plain(p.label) !== null && (p.state == null || oneOf(p.state, STATES) !== null);
const deltaReady = (p: Record<string, unknown>) => plain(p.label) !== null && plain(p.before) !== null && plain(p.after) !== null;
const sparkReady = (p: Record<string, unknown>) => plain(p.label) !== null && Array.isArray(p.values) && p.values.length >= 2 && p.values.length <= 32 && p.values.every((v) => finite(v) && Math.abs(v) <= 1e15);
const CompareHeadings = React.createContext({ before: "", after: "" });
const Moment = defineComponent({
  name: "Moment",
  description: "One timed event.",
  props: z.object({ time: z.string(), label: z.string(), state: z.enum(STATES).optional(), note: text.optional() }),
  component: ({ props }) => {
    const state = oneOf(props.state, STATES);
    const note = plain(props.note);
    return <div className={`openui-moment is-${state ?? "none"}`} role="listitem">
      <span className="openui-moment-time">{plain(props.time)}</span>
      <span className="openui-moment-rail">{state ? <StateDot state={state} /> : <span className="openui-dot" aria-hidden="true" />}</span>
      <span className="openui-moment-body"><span className="openui-moment-label">{plain(props.label)}</span>{note ? <span className="openui-moment-note">{note}</span> : null}</span>
    </div>;
  },
});
const Timeline = defineComponent({
  name: "Timeline",
  description: "Timed events in order.",
  props: z.object({ items: z.array(Moment.ref) }),
  component: ({ props, renderNode }) => {
    const items = list(props.items).filter((item) => isNode(item, "Moment") && momentReady(item.props));
    return items.length ? <div className="openui-timeline openui-face" role="list">{renderNode(items)}</div> : null;
  },
});
function DeltaRow({ props }: { props: Record<string, unknown> }) {
  const headings = React.useContext(CompareHeadings);
  const t = oneOf(props.tone, TONES);
  return <div className="openui-delta" role="listitem">
    <span className="openui-delta-label">{plain(props.label)}</span>
    <span className="openui-delta-before"><span className="openui-delta-caption">{headings.before}</span><span className="openui-delta-value">{plain(props.before)}</span></span>
    <span className="openui-delta-after"><span className="openui-delta-caption">{headings.after}</span><span className="openui-delta-value">{t ? <ToneDot tone={t} /> : null}{plain(props.after)}</span></span>
  </div>;
}
const Delta = defineComponent({
  name: "Delta",
  description: "One before/after comparison.",
  props: z.object({ label: z.string(), before: text, after: text, tone }),
  component: ({ props }) => <DeltaRow props={props} />,
});
const Compare = defineComponent({
  name: "Compare",
  description: "Two named columns compared by row.",
  props: z.object({ before: z.string(), after: z.string(), items: z.array(Delta.ref) }),
  component: ({ props, renderNode }) => {
    const before = plain(props.before), after = plain(props.after);
    const items = list(props.items).filter((item) => isNode(item, "Delta") && deltaReady(item.props));
    return before && after && items.length ? <CompareHeadings.Provider value={{ before, after }}><div className="openui-compare openui-face" role="list">
      <div className="openui-compare-head" aria-hidden="true"><span /><span>{before}</span><span>{after}</span></div>{renderNode(items)}
    </div></CompareHeadings.Provider> : null;
  },
});
const Tag = defineComponent({
  name: "Tag",
  description: "One noninteractive label.",
  props: z.object({ label: z.string(), tone }),
  component: ({ props }) => {
    const t = oneOf(props.tone, TONES);
    return <span className="openui-tag" role="listitem">{t ? <ToneDot tone={t} /> : null}{plain(props.label)}</span>;
  },
});
const Tags = defineComponent({
  name: "Tags",
  description: "A group of noninteractive labels.",
  props: z.object({ items: z.array(Tag.ref) }),
  component: ({ props, renderNode }) => {
    const items = list(props.items).filter((item) => isNode(item, "Tag") && plain(item.props.label) !== null);
    return items.length ? <div className="openui-tags" role="list">{renderNode(items)}</div> : null;
  },
});
const Sparkline = defineComponent({
  name: "Sparkline",
  description: "One numeric trend, oldest first.",
  props: z.object({ label: z.string(), values: z.array(z.number()), unit: z.string().optional() }),
  component: ({ props }) => {
    if (!sparkReady(props)) return null;
    const values = props.values as number[];
    const lo = Math.min(...values), hi = Math.max(...values);
    const round2 = (v: number) => String(Math.round(v * 100) / 100);
    const points = values.map((v, i) => `${round2(i / (values.length - 1) * 100)},${round2(hi === lo ? 10 : 2 + (1 - (v - lo) / (hi - lo)) * 16)}`).join(" ");
    const unit = typeof props.unit === "string" ? props.unit.slice(0, MAX_UNIT) : "";
    const format = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
    return <React.Fragment>
      <span className="openui-bar-label">{plain(props.label)}</span>
      <svg className="openui-spark" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true" focusable="false"><polyline points={points} fill="none" vectorEffect="non-scaling-stroke" /></svg>
      <span className="openui-bar-value"><span className="openui-sr">{`${format.format(values[0]!)}${unit} → `}</span>{`${format.format(values[values.length - 1]!)}${unit}`}</span>
    </React.Fragment>;
  },
});
const Sparklines = defineComponent({
  name: "Sparklines",
  description: "Up to four numeric trends.",
  props: z.object({ items: z.array(Sparkline.ref) }),
  component: ({ props, renderNode }) => {
    const items = list(props.items).filter((item) => isNode(item, "Sparkline") && sparkReady(item.props));
    return items.length ? <div className="openui-bars openui-sparklines openui-face">{renderNode(items)}</div> : null;
  },
});
const CHILDREN = new Set(["Stats", "Steps", "Bars", "Table", "Facts", "Callout", "Progress", "Choices", "Timeline", "Compare", "Tags", "Sparklines", "Button", "Form"]);
const Card = defineComponent({
  name: "Card",
  description: "Titled group of components.",
  props: z.object({ title: z.string(), children: z.array(z.union([Stats.ref, Steps.ref, Bars.ref, Table.ref, Facts.ref, Callout.ref, Progress.ref, Choices.ref, Timeline.ref, Compare.ref, Tags.ref, Sparklines.ref, Button.ref, Form.ref])) }),
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

// ---- 2. 상한 — 등록 스키마와 따로 둔 Zod 판정(lang-core 는 max/refine 을 보지 않는다, 실측). 노드마다 safeParse.
const reply = z.string().refine((value) => sendableReply(value) !== null);
// 자식 자리에는 허용된 컴포넌트만 — lang-core 는 union 소속을 검사하지 않는다(실측: Card 직속 Stat 이 오류 없이 통과).
const element = (...names: [string, ...string[]]) => z.object({ type: z.literal("element"), typeName: z.enum(names) });
const short = (max: number) => z.string().refine((value) => { const t = value.trim(); return t.length > 0 && t.length <= max; });
const LIMITS: Readonly<Record<string, z.ZodType>> = {
  Card: z.object({ title: z.string(), children: z.array(element("Stats", "Steps", "Bars", "Table", "Facts", "Callout", "Progress", "Choices", "Timeline", "Compare", "Tags", "Sparklines", "Button", "Form")).max(8) }),
  Timeline: z.object({ items: z.array(element("Moment")).min(1).max(12) }),
  Moment: z.object({ time: short(20), label: z.string(), state: z.enum(STATES).nullish(), note: text.nullish() }),
  Compare: z.object({ before: short(40), after: short(40), items: z.array(element("Delta")).min(1).max(8) }),
  Delta: z.object({ label: z.string(), before: text, after: text, tone: z.enum(TONES).nullish() }),
  Tags: z.object({ items: z.array(element("Tag")).min(1).max(12) }),
  Tag: z.object({ label: short(32), tone: z.enum(TONES).nullish() }),
  Sparklines: z.object({ items: z.array(element("Sparkline")).min(1).max(4) }),
  Sparkline: z.object({ label: z.string(), values: z.array(z.number().finite().min(-1e15).max(1e15)).min(2).max(32), unit: z.string().nullish() }),
  Stats: z.object({ items: z.array(element("Stat")).max(4) }),
  Stat: z.object({ label: z.string(), value: text, note: text.nullish(), tone: z.enum(TONES).nullish() }),
  Steps: z.object({ items: z.array(element("Step")).max(50) }),
  Step: z.object({ label: z.string(), state: z.enum(STATES), note: text.nullish() }),
  Bars: z.object({ labels: z.array(z.string()), values: z.array(z.number().finite()), unit: z.string().nullish() })
    .refine((p) => Math.min(p.labels.length, p.values.length) <= 12),
  Table: z.object({ columns: z.array(z.string()).max(8), rows: z.array(z.array(text).max(8)).max(50) }),
  Facts: z.object({ items: z.array(element("Fact")).max(8) }),
  Fact: z.object({ label: z.string(), value: text, tone: z.enum(TONES).nullish() }),
  Callout: z.object({ text: z.string(), tone: z.enum(TONES).nullish() }),
  Progress: z.object({ label: z.string(), done: z.number().finite().min(0), total: z.number().finite().gt(0), note: text.nullish() })
    .refine((p) => p.done <= p.total),
  Choices: z.object({ items: z.array(element("Choice")).min(2).max(4) }),
  Choice: z.object({ label: short(40), reply, why: line(120).nullish(), effect: line(120).nullish() }),
  Button: z.object({ label: line(40), action: z.unknown().optional() }).refine((p) => sourceAction(p.action, p.label) !== null),
  Form: z.object({ fields: z.array(element("Input", "Select")).min(1).max(4), template: z.string(), submit: line(24) }),
  Input: inputLimit,
  Select: selectLimit,
};

export type Verdict = { kind: "render" } | { kind: "hold" } | { kind: "fallback" };
const parser = createParser(library.toJSONSchema(), "Card");

/**
 * 엄격 판정 — 확정이면 하나라도 걸리면 fallback, 흐르는 중이면 hold(지난 그림 유지). Renderer 에 원문을 넘기기 전에 동기로 한 번.
 */
export function judge(source: string, final: boolean): Verdict {
  const no: Verdict = final ? { kind: "fallback" } : { kind: "hold" };
  if (!source.trim() || source.length > MAX_SOURCE) return no;
  let result: ParseResult;
  try { result = parser.parse(source); } catch { return no; }
  // 정적 그림 밖의 기능은 흐르는 중에도 그리지 않는다(Query 로더·상태 바인딩이 한 번도 서지 않게).
  if (result.queryStatements.length || result.mutationStatements.length || Object.keys(result.stateDeclarations).length || result.rootExpression !== undefined) return no;
  const root = result.root as Node | null;
  if (!root || root.typeName !== "Card") return no;
  if (final && (result.meta.incomplete || result.meta.unresolved.length)) return no;
  if (final && result.meta.errors.some((error) => error.severity !== "warning")) return no;
  let choices = 0;
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.every(visit);
    if (!value || typeof value !== "object") return true;
    if ((value as Node).type !== "element") return false;
    const node = value as Node;
    const limit = LIMITS[node.typeName];
    // 액션 때문에 부모까지 동적으로 표시된다. Button.action의 단일 리터럴만 예외이며 다른 AST 객체는 visit이 거절한다.
    if (!limit || (final && !limit.safeParse(node.props).success)) return false;
    if ((node.typeName === "Choices" || node.typeName === "Form") && ++choices > 1) return false;
    if (node.typeName === "Form" && final && !formReady(node.props)) return false;
    return Object.entries(node.props).every(([key, child]) => node.typeName === "Button" && key === "action" ? sourceAction(child, node.props.label) !== null : visit(child));
  };
  return visit(root) ? { kind: "render" } : no;
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
