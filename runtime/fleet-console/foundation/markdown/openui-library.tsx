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
const choiceReady = (p: Record<string, unknown>) => typeof p.label === "string" && p.label.trim() !== "" && sendableReply(p.reply) !== null;
const factReady = (p: Record<string, unknown>) => plain(p.label) !== null && plain(p.value) !== null;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
// 흐르는 중 판정은 더 와도 풀리지 않는 위반만 보므로(열린 숫자는 아님) 컴포넌트도 같은 조건을 본다 — 0 ≤ done ≤ total, total > 0.
const progressReady = (p: Record<string, unknown>) =>
  plain(p.label) !== null && finite(p.done) && finite(p.total) && p.total > 0 && p.done >= 0 && p.done <= p.total;

const Stat = defineComponent({
  name: "Stat",
  description: "One metric tile.",
  props: z.object({ label: z.string(), value: text, note: text.optional(), tone }),
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
  name: "Stats",
  description: "Row of up to four metric tiles.",
  props: z.object({ items: z.array(Stat.ref) }),
  component: ({ props, renderNode }) => {
    const items = list(props.items).filter((item) => isNode(item, "Stat") && statReady(item.props));
    return items.length ? <div className="openui-stats" role="group">{renderNode(items)}</div> : null;
  },
});
const Step = defineComponent({
  name: "Step",
  description: "One work item and its state.",
  props: z.object({ label: z.string(), state: z.enum(STATES), note: text.optional() }),
  component: ({ props }) => <StepRow props={props} />,
});
const Steps = defineComponent({
  name: "Steps",
  description: "List of work items with their states.",
  props: z.object({ items: z.array(Step.ref) }),
  component: ({ props, renderNode }) => {
    const items = list(props.items).filter((item) => isNode(item, "Step") && stepReady(item.props));
    return items.length ? <div className="openui-steps" role="list">{items.map((item, i) => <StepIndex.Provider key={i} value={i + 1}>{renderNode(item)}</StepIndex.Provider>)}</div> : null;
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
  name: "Table",
  description: "Compact table; rows are arrays of cells.",
  props: z.object({ columns: z.array(z.string()), rows: z.array(z.array(text)) }),
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
  name: "Fact",
  description: "One label/value detail.",
  props: z.object({ label: z.string(), value: text, tone }),
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
  name: "Facts",
  description: "Label/value details such as PR, commit or check result.",
  props: z.object({ items: z.array(Fact.ref) }),
  component: ({ props, renderNode }) => {
    const items = list(props.items).filter((item) => isNode(item, "Fact") && factReady(item.props));
    return items.length ? <div className="openui-facts openui-frame" role="list">{renderNode(items)}</div> : null;
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
      <div className={`openui-callout openui-rule${toneClass(t)}`} role="note">
        {t ? <ToneLabel tone={t} /> : null}
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
const DecisionLayout = React.createContext(false);
function ChoiceButton({ label, reply, why, effect }: { label: string; reply: string; why: string | null; effect: string | null }) {
  const block = useBlock();
  const decision = React.useContext(DecisionLayout);
  const trigger = useTriggerAction();
  const key = React.useId();
  return <button type="button" className={decision ? "openui-option" : "openui-button"} title={reply} aria-pressed={block.sent === key ? true : undefined}
    disabled={!block.final || block.sent !== null} aria-disabled={block.final && !block.send ? true : undefined}
    onClick={(event) => block.activate(event, { type: "send", message: reply, max: 200 }, key, trigger)}>
    {decision ? <><span className="openui-option-text"><span className="openui-option-label">{label}</span>{why ? <span className="openui-option-why">{why}</span> : null}{effect ? <span className="openui-option-effect">{effect}</span> : null}</span><span className="openui-option-mark" aria-hidden="true" /></> : label}
  </button>;
}
const Choice = defineComponent({
  name: "Choice",
  description: "One answer sent as the person's message when clicked.",
  props: z.object({ label: z.string(), reply: z.string(), why: z.string().optional(), effect: z.string().optional() }),
  component: ({ props }) => <ChoiceButton label={(props.label as string).trim()} reply={sendableReply(props.reply)!} why={optionalPlain(props.why)} effect={optionalPlain(props.effect)} />,
});
const Choices = defineComponent({
  name: "Choices",
  description: "Two to four answers the person can pick.",
  props: z.object({ items: z.array(Choice.ref) }),
  component: ({ props, renderNode }) => {
    const items = list(props.items).filter((item) => isNode(item, "Choice") && choiceReady(item.props));
    const decision = items.some((item) => isNode(item, "Choice") && (optionalPlain(item.props.why) || optionalPlain(item.props.effect)));
    return items.length ? <DecisionLayout.Provider value={decision}><div className={decision ? "openui-decision" : "openui-choices"} role="group">{renderNode(items)}</div></DecisionLayout.Provider> : null;
  },
});

// 등록 때는 액션 문법을 알리지만, 판정은 단일 리터럴 단계만 허용한다. Action·Run·상태 변경은 실행기에 닿지 않는다.
const literalAction = z.object({ k: z.literal("Comp"), name: z.enum(["OpenUrl", "ToAssistant"]), args: z.tuple([z.object({ k: z.literal("Str"), v: z.string() }).strict()]), mappedProps: z.record(z.string(), z.unknown()).optional() }).strict();
const runtimePlan = z.object({ steps: z.tuple([z.union([
  z.object({ type: z.literal("open_url"), url: z.string() }).strict(),
  // 업스트림은 context를 생략해도 undefined 키를 붙인다. 정의된 숨은 값은 여전히 거절한다.
  z.object({ type: z.literal("continue_conversation"), message: z.string(), context: z.undefined().optional() }).strict(),
])]) }).strict();
// 형태는 단일 @OpenUrl 리터럴인데 대상만 거부된 단추 — 블록 전체를 코드로 떨구지 않고 누를 수 없는 라벨로 남긴다.
// 대상 판정은 그대로라 권한은 넓어지지 않는다. 다른 형태의 액션(Run·Action·숨은 인자)은 여전히 블록을 거절한다.
function refusedSourceOpen(value: unknown): string | null {
  const action = literalAction.safeParse(value);
  return action.success && action.data.name === "OpenUrl" && !parseOpenUIOpenTarget(action.data.args[0].v) ? action.data.args[0].v : null;
}
function refusedRuntimeOpen(value: unknown): string | null {
  const plan = runtimePlan.safeParse(value);
  const step = plan.success ? plan.data.steps[0] : null;
  return step?.type === "open_url" && !parseOpenUIOpenTarget(step.url) ? step.url : null;
}
const buttonAction = (value: unknown, label: unknown) => sourceAction(value, label) !== null || refusedSourceOpen(value) !== null;
function sourceAction(value: unknown, label: unknown): SafeAction | null {
  if (value == null) {
    const message = sendableReply(label);
    return message ? { type: "send", message, max: 200 } : null;
  }
  const action = literalAction.safeParse(value);
  if (!action.success) return null;
  const raw = action.data.args[0].v;
  if (action.data.name === "OpenUrl") return parseOpenUIOpenTarget(raw) ? { type: "open", url: raw } : null;
  const message = sendableReply(raw);
  return message ? { type: "send", message, max: 200 } : null;
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
  const tail = target?.kind === "https" ? target.hostname : target?.kind === "objective" ? `objective:${target.id.slice(0, 8)}` : target?.kind === "mission" ? `mission:${target.number}` : null;
  const contents = <><span>{label}</span>{tail ? <span className={`openui-button-tail${target?.kind === "https" ? "" : " is-internal"}`}>{tail}</span> : null}</>;
  if (target && !block.open?.accepts(target)) return <span className="openui-inert is-inert" title={safe.type === "open" ? safe.url : undefined}>{contents}</span>;
  return <button type="button" className="openui-button" aria-pressed={block.sent === key ? true : undefined} title={safe.type === "open" ? safe.url : safe.message}
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
const line = (max: number, allowEmpty = false) => z.string().refine((v) => {
  const t = v.trim();
  // eslint-disable-next-line no-control-regex
  return (allowEmpty || !!t) && t.length <= max && !/[\u0000-\u001f\u007f\p{Zl}\p{Zp}]/u.test(v);
});
const inputLimit = z.object({ name: fieldName, label: line(40) });
const selectLimit = inputLimit.extend({ options: z.array(line(40)).min(2).max(6).refine((values) => new Set(values).size === values.length) });
function formReady(p: Record<string, unknown>): boolean {
  const fields = list(p.fields);
  if (!fields.length || fields.length > 4 || typeof p.template !== "string" || !line(160).safeParse(p.template).success) return false;
  const names = fields.flatMap((f) => isNode(f, "Input") && inputLimit.safeParse(f.props).success || isNode(f, "Select") && selectLimit.safeParse(f.props).success ? [(f as Node).props.name as string] : []);
  // 첫 필드가 만든 명령 접두는 composeDraft의 완성 문장 판정과 전송 직전 검사에서 거절한다.
  if (names.length !== fields.length || new Set(names).size !== names.length || /^[/@]/u.test(p.template.trim())) return false;
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
  return <div className="openui-form" role="group">{fields.map((field) => {
    const name = String(field.props.name);
    return <label className="openui-field" key={name}><span className="openui-field-label">{String(field.props.label)}</span>{field.typeName === "Input"
      ? <input className="openui-input" type="text" maxLength={80} autoComplete="off" spellCheck={false} disabled={disabled} value={values.get(name) ?? ""} onChange={(e) => update(name, e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} />
      : <select className="openui-select" disabled={disabled} value={String(list(field.props.options).indexOf(values.get(name)))} onChange={(e) => { const option = list(field.props.options)[Number(e.currentTarget.value)]; if (typeof option === "string") update(name, option); }} onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}>{list(field.props.options).map((option, i) => <option key={i} value={String(i)}>{String(option)}</option>)}</select>}</label>;
  })}<div className="openui-form-actions"><button type="button" className="openui-button is-primary" aria-pressed={block.sent === key ? true : undefined} title={String(props.template)} disabled={disabled || !complete || !draft}
    onClick={(event) => { if (complete && draft) block.activate(event, { type: "send", message: draft, max: 480 }, key, trigger); }}>{String(props.submit)}</button></div></div>;
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
    const note = optionalPlain(props.note);
    return <div className="openui-moment" role="listitem">
      <span className="openui-moment-time">{plain(props.time)}</span>
      <span className="openui-moment-line"><span className="openui-moment-label">{plain(props.label)}</span>{state ? <StateTag state={state} /> : null}{note ? <span className="openui-moment-note">{note}</span> : null}</span>
    </div>;
  },
});
const Timeline = defineComponent({
  name: "Timeline",
  description: "Timed events in order.",
  props: z.object({ items: z.array(Moment.ref) }),
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
    return before && after && items.length ? <CompareHeadings.Provider value={{ before, after }}><div className="openui-compare openui-frame" role="list">
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
    return <span className={`openui-tag${toneClass(t)}`} role="listitem">{plain(props.label)}{t ? <ToneLabel tone={t} suffix /> : null}</span>;
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
  name: "Sparkline",
  description: "One numeric trend, oldest first.",
  props: z.object({ label: z.string(), values: z.array(z.number()), unit: z.string().optional() }),
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
  name: "Sparklines",
  description: "Up to four numeric trends.",
  props: z.object({ items: z.array(Sparkline.ref) }),
  component: ({ props, renderNode }) => {
    const items = list(props.items).filter((item) => isNode(item, "Sparkline") && sparkReady(item.props));
    return items.length ? <div className="openui-bars openui-sparklines">{renderNode(items)}</div> : null;
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
  Choice: z.object({ label: short(40), reply, why: line(120, true).nullish(), effect: line(120, true).nullish() }),
  Button: z.object({ label: line(40), action: z.unknown().optional() }).refine((p) => buttonAction(p.action, p.label)),
  Form: z.object({ fields: z.array(element("Input", "Select")).min(1).max(4), template: z.string(), submit: line(24) }),
  Input: inputLimit,
  Select: selectLimit,
};

export type Verdict = { kind: "render" } | { kind: "hold" } | { kind: "fallback" };
const parser = createParser(library.toJSONSchema(), "Card");

// ---- 3. 흐르는 중 확정 위반 — 원문이 더 와도 풀리지 않는 위반만 흐르는 중에 fallback 으로 앞당긴다.
// 파서 결과에는 노드 단위 완결 표시가 없다(요소의 partial 은 블록 전체 값이다). 그래서 문장 경계로 완결을 정한다.
// 아래 규칙은 lang-core 1.0.1 의 실측 동작에 기댄다: 미해소 참조는 배열에서 빠지고 필수 자리면 null-required,
// 열린 문장(partial)은 enum 을 보지 않으며, union 소속은 검사하지 않고, 노드 탈락에는 오류가 붙는다(null 값 참조만 예외).
// 버전을 올리면 이 가정을 다시 실측한다.
type LimitIssue = z.core.$ZodIssue;
// 미해소 참조로는 생기지 않는 오류 — 완결 문장에서 나면 최종에도 남는다. null-required 는 참조가 풀리면 사라질 수 있어 뺀다.
const SETTLED_ERRORS = new Set<string>(["unknown-component", "unknown-function", "inline-reserved", "excess-args", "type-mismatch", "missing-required"]);
// 정적 그림 밖의 기능 — 한 번 나오면 최종에도 남는다.
const dynamic = (result: ParseResult) =>
  !!(result.queryStatements.length || result.mutationStatements.length || Object.keys(result.stateDeclarations).length || result.rootExpression !== undefined);
const limitIssues = (node: Node): readonly LimitIssue[] => {
  const check = LIMITS[node.typeName]?.safeParse(node.props);
  return check && !check.success ? check.error.issues : [];
};
const arrayCount = (issue: LimitIssue, code: "too_big" | "too_small") => issue.code === code && "origin" in issue && issue.origin === "array";
const placeholders = (template: string) => new Set([...template.matchAll(/\{([a-z][a-z0-9_]{0,15})\}/g)].map((match) => match[1]));
// 요소 트리에서 found 가 참인 노드가 있는지. Button.action 은 visit 처럼 따로 본다. 요소 아닌 객체는 other 가 정한다.
function someNode(root: unknown, found: (node: Node) => boolean, other: () => boolean = () => false): boolean {
  const go = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(go);
    if (!value || typeof value !== "object") return false;
    if ((value as Node).type !== "element") return other();
    const node = value as Node;
    return found(node) || Object.entries(node.props).some(([key, child]) => !(node.typeName === "Button" && key === "action") && go(child));
  };
  return go(root);
}
// 마지막 완결 문장의 끝. 규칙 출처: lang-core 1.0.1 createStreamParser 의 scanNewCompleted —
// 문자열(" ' 와 escape) 밖, 괄호 깊이 0, 삼항 깊이 0 인 줄바꿈이 문장을 끝내고, 다음 비공백이 ? 면 이어진다.
// 주석 전처리는 따라 하지 않는다 — 대신 호출자가 그 접두를 파서가 미완성으로 보지 않는지 확인한다.
function settledEnd(source: string): number {
  let depth = 0, ternary = 0, quote = "", escaped = false, end = -1;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "\"" || c === "'") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    else if (c === "?" && depth === 0) ternary++;
    else if (c === ":" && depth === 0 && ternary > 0) ternary--;
    else if (c === "\n" && depth === 0 && ternary === 0 && /\S/.exec(source.slice(i + 1))?.[0] !== "?") end = i;
  }
  return end;
}
// 템플릿과 이미 해소된 필드만으로 확정되는 Form 결함 — formReady 에서 '아직 안 온 필드'에 달린 조건만 뺐다.
function formSettledBad(p: Record<string, unknown>): boolean {
  const fields = list(p.fields);
  if (fields.length > 4 || typeof p.template !== "string" || !line(160).safeParse(p.template).success || /^[/@]/u.test(p.template.trim())) return true;
  const names = fields.flatMap((f) => isNode(f, "Input") || isNode(f, "Select") ? [String(f.props.name)] : []);
  const used = placeholders(p.template);
  return new Set(names).size !== names.length || /[{}]/u.test(p.template.replace(/\{([a-z][a-z0-9_]{0,15})\}/g, "")) || names.some((name) => !used.has(name));
}
// 완결 문장 접두의 확정 위반. 원문 요소 수는 미해소 참조마다 대역 Tag 하나를 채워 다시 센다(union 소속을 보지 않으므로 어느 요소 자리에도 하나로 세진다).
// 많다는 언제나 믿는다 — 대역 탈락은 수를 줄일 뿐이다. 적다는 대역 파싱에 오류가 없을 때만 믿는다 — 대역이 스칼라 자리에 들어가면 부모가 떨어진다.
function prefixBad(prefix: string): boolean {
  let result: ParseResult;
  try { result = parser.parse(prefix); } catch { return false; }
  if (result.meta.incomplete) return false; // 경계를 파서가 인정하지 않으면(주석 속 괄호 등) 완료 판정에 맡긴다.
  const pending = result.meta.unresolved.length > 0;
  if (result.meta.errors.some((e) => e.severity !== "warning" && e.code !== "no-root" && (!pending || SETTLED_ERRORS.has(e.code)))) return true;
  if (dynamic(result)) return true;
  const root = result.root as Node | null;
  if (!root) return false;
  if (root.typeName !== "Card") return true;
  let forms = 0;
  const bad = someNode(root, (node) =>
    limitIssues(node).some((issue) => !(pending && arrayCount(issue, "too_small")))
    || ((node.typeName === "Choices" || node.typeName === "Form") && ++forms > 1)
    || (node.typeName === "Form" && (pending ? formSettledBad(node.props) : !formReady(node.props))), () => true);
  if (bad || !pending) return bad;
  let counted: ParseResult;
  try { counted = parser.parse(`${prefix}\n${[...new Set(result.meta.unresolved)].map((name) => `${name} = Tag("x")`).join("\n")}`); } catch { return false; }
  const clean = !counted.meta.errors.some((e) => e.severity !== "warning" && e.code !== "no-root");
  return someNode(counted.root, (node) => {
    if (limitIssues(node).some((issue) => arrayCount(issue, "too_big") || (clean && arrayCount(issue, "too_small")))) return true;
    if (node.typeName !== "Form" || typeof node.props.template !== "string") return false;
    // 필드 이름과 쓰인 이름은 일대일이어야 한다 — 원문 필드 수와 서로 다른 자리표시자 수가 다르면 풀리지 않는다.
    const fields = list(node.props.fields).length, used = placeholders(node.props.template).size;
    return fields > used || (clean && fields < used);
  });
}
// 접두는 새 문장이 끝날 때만 바뀐다 — 마지막 접두의 결과 하나만 기억해 델타마다 다시 파싱하지 않는다. 순수 캐시다.
let settled: { prefix: string; bad: boolean } | null = null;
function settledBad(source: string, full: ParseResult): boolean {
  // 마지막 문장도 괄호·문자열이 다 닫혔고 닫는 글자로 끝나면 완결로 본다. 그 순간 파서가 엄격하게 노드를 떨궈 위반이 사라지지 않게 한다.
  const trimmed = source.trimEnd();
  const end = !full.meta.incomplete && /[)\]}"']$/u.test(trimmed) ? trimmed.length : settledEnd(source);
  if (end < 0) return false;
  const prefix = source.slice(0, end);
  if (settled?.prefix !== prefix) settled = { prefix, bad: prefixBad(prefix) };
  return settled.bad;
}
// 열린 문자열도 최종 문자열의 접두다 — 허용값 어느 것의 접두도 아니면 더 와도 풀리지 않는다.
function enumDeadEnd(node: Node, issue: LimitIssue): boolean {
  if (issue.code !== "invalid_value" || !issue.values.every((v) => typeof v === "string")) return false;
  let value: unknown = node.props;
  for (const key of issue.path) value = value && typeof value === "object" ? (value as Record<PropertyKey, unknown>)[key] : undefined;
  return typeof value === "string" && !issue.values.some((v) => (v as string).startsWith(value as string));
}
// 열린 마지막 문장까지 포함한 파싱에서 단조인 것만 — 요소는 남고(탈락에는 오류), 배열 수는 하한이며, 호출 이름은 '(' 앞에서 완결된다.
function openBad(full: ParseResult): boolean {
  let forms = 0;
  return someNode(full.root, (node) =>
    limitIssues(node).some((issue) => arrayCount(issue, "too_big") || (issue.code === "invalid_value" && (issue.path[issue.path.length - 1] === "typeName" || enumDeadEnd(node, issue))))
    || ((node.typeName === "Choices" || node.typeName === "Form") && ++forms > 1));
}

/**
 * 엄격 판정 — 확정이면 하나라도 걸리면 fallback. 흐르는 중에는 더 와도 풀리지 않는 위반이면 fallback,
 * 아직 판단할 수 없으면 hold(지난 그림 유지), 아니면 render. Renderer 에 원문을 넘기기 전에 동기로 한 번.
 */
export function judge(source: string, final: boolean): Verdict {
  const no: Verdict = final ? { kind: "fallback" } : { kind: "hold" };
  if (!source.trim()) return no;
  if (source.length > MAX_SOURCE) return { kind: "fallback" };
  let result: ParseResult;
  try { result = parser.parse(source); } catch { return no; }
  // 정적 그림 밖의 기능은 흐르는 중에도 그리지 않는다(Query 로더·상태 바인딩이 한 번도 서지 않게).
  if (dynamic(result)) return { kind: "fallback" };
  const root = result.root as Node | null;
  if (root && root.typeName !== "Card") return { kind: "fallback" };
  if (!final && (settledBad(source, result) || openBad(result))) return { kind: "fallback" };
  if (!root) return no;
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
    return Object.entries(node.props).every(([key, child]) => node.typeName === "Button" && key === "action" ? buttonAction(child, node.props.label) : visit(child));
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
