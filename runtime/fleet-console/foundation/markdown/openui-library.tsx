/**
 * OpenUI 렌더러 — Fleet 소유 컴포넌트와 엄격 판정을 담은 지연 청크.
 * react-lang 라이브러리 등록(이름·위치 시그니처는 현행과 같은 Zod 객체) + Fleet 컴포넌트 + 엄격 판정(judge).
 */
import "./openui-devtools-guard.js";

import { createLibrary, createParser, defineComponent, Renderer, type ParseResult } from "@openuidev/react-lang";
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
interface BlockContext { readonly labels: OpenUIRenderLabels; readonly final: boolean; readonly reply: ((text: string) => void) | null }
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
export function sendableReply(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const reply = value.trim();
  if (!reply || reply.length > 200) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\u2028\u2029]/u.test(reply)) return null;
  return reply.startsWith("/") || reply.startsWith("@") ? null : reply;
}

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
function ChoiceButton({ label, reply }: { label: string; reply: string }) {
  const { final, reply: port } = useBlock();
  // 보낼 문장은 이 클로저에만 있다 — DOM 속성에서 읽지 않는다. 사람의 클릭(isTrusted)·확정·포트가 모두 있을 때만 포트를 부른다.
  const onClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!event.nativeEvent.isTrusted || !final || !port) return;
    port(reply);
  };
  return (
    <button type="button" className="openui-choice" title={reply} disabled={!final} aria-disabled={final && !port ? true : undefined} onClick={onClick}>
      {label}
    </button>
  );
}
const Choice = defineComponent({
  name: "Choice",
  description: "One answer the person can pick; reply is the sentence that becomes their words after they confirm.",
  props: z.object({ label: z.string(), reply: z.string() }),
  component: ({ props }) => <ChoiceButton label={(props.label as string).trim()} reply={sendableReply(props.reply)!} />,
});
const Choices = defineComponent({
  name: "Choices",
  description: "Two to four answers the person can pick.",
  props: z.object({ items: z.array(Choice.ref) }),
  component: ({ props, renderNode }) => {
    const items = list(props.items).filter((item) => isNode(item, "Choice") && choiceReady(item.props));
    return items.length ? <div className="openui-choices" role="group">{renderNode(items)}</div> : null;
  },
});
const CHILDREN = new Set(["Stats", "Steps", "Bars", "Table", "Facts", "Callout", "Progress", "Choices"]);
const Card = defineComponent({
  name: "Card",
  description: "Titled group of components.",
  props: z.object({ title: z.string(), children: z.array(z.union([Stats.ref, Steps.ref, Bars.ref, Table.ref, Facts.ref, Callout.ref, Progress.ref, Choices.ref])) }),
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

export const library = createLibrary({ components: [Card, Stats, Stat, Steps, Step, Bars, Table, Facts, Fact, Callout, Progress, Choices, Choice], root: "Card" });

// ---- 2. 상한 — 등록 스키마와 따로 둔 Zod 판정(lang-core 는 max/refine 을 보지 않는다, 실측). 노드마다 safeParse.
const reply = z.string().refine((value) => sendableReply(value) !== null);
// 자식 자리에는 허용된 컴포넌트만 — lang-core 는 union 소속을 검사하지 않는다(실측: Card 직속 Stat 이 오류 없이 통과).
const element = (...names: [string, ...string[]]) => z.object({ type: z.literal("element"), typeName: z.enum(names) });
const LIMITS: Readonly<Record<string, z.ZodType>> = {
  Card: z.object({ title: z.string(), children: z.array(element("Stats", "Steps", "Bars", "Table", "Facts", "Callout", "Progress", "Choices")).max(8) }),
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
  Choice: z.object({ label: z.string().refine((value) => { const t = value.trim(); return t.length > 0 && t.length <= 40; }), reply }),
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
    if (!value || typeof value !== "object" || (value as Node).type !== "element") return true;
    const node = value as Node & { hasDynamicProps?: boolean };
    const limit = LIMITS[node.typeName];
    // 덜 온 정적 props는 컴포넌트가 거르지만 동적 props는 흐르는 중에도 런타임에 넘기지 않는다.
    if (!limit || node.hasDynamicProps !== false || (final && !limit.safeParse(node.props).success)) return false;
    if (node.typeName === "Choices" && ++choices > 1) return false;
    return Object.values(node.props).every(visit);
  };
  return visit(root) ? { kind: "render" } : no;
}

/** 블록 하나의 React 트리 — Renderer.Root + Content 슬롯만(기본 Query 로더를 쓰지 않는다). onAction·toolProvider 는 주지 않는다. */
export function OpenUIView({ source, final, labels, reply }: { source: string; final: boolean; labels: OpenUIRenderLabels; reply: ((text: string) => void) | null }) {
  const context = React.useMemo(() => ({ labels, final, reply }), [labels, final, reply]);
  return (
    <Block.Provider value={context}>
      <Renderer.Root response={source} library={library} isStreaming={!final} publishObservability={false}>
        <Renderer.Content className="openui-content" />
      </Renderer.Root>
    </Block.Provider>
  );
}
