/**
 * OpenUI 정제 — 블록 원문을 Fleet 규칙으로 걸러 그릴 수 있는 정적 트리만 남긴다. React·DOM 에 기대지 않는다.
 * 업스트림 렌더러처럼 틀린 요소만 빼고 나머지를 그린다: lang-core 가 떨군 노드에 더해, Fleet 상한·자식 자리·단추 액션·Form 규칙을
 * 어긴 요소를 그 자리에서 뺀다. 렌더러에는 정제한 트리를 다시 쓴 원문만 넘기므로 Query·상태·식은 렌더러에 닿지 않는다.
 * 같은 판정을 렌더러 청크(openui-library)와 호스트의 다음 턴 되먹임(openui-feedback)이 함께 쓴다.
 */

import { createLibrary, createParser, defineComponent, jsonToOpenUI, steps, type ParseResult } from "@openuidev/lang-core";
import { z } from "zod";

import { parseOpenUIOpenTarget, sendableReply } from "./openui-actions.js";

export const MAX_SOURCE = 16 * 1024;
const MAX_REASON = 280;
export const STATES = ["todo", "running", "waiting", "done", "blocked"] as const;
export const TONES = ["good", "warn", "bad"] as const;

export type Node = { type: "element"; typeName: string; props: Record<string, unknown> };
export const isNode = (value: unknown, name?: string): value is Node =>
  !!value && typeof value === "object" && (value as Node).type === "element" && (name === undefined || (value as Node).typeName === name) && !!(value as Node).props;
export const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

// ---- 1. 등록 스키마 — 모델 계약의 Zod 객체(이름·키 순서 = 위치 인자). 렌더러 라이브러리도 이 객체를 그대로 등록한다. 바꾸지 않는다.
const text = z.union([z.string(), z.number()]);
const tone = z.enum(TONES).optional();
const StatProps = z.object({ label: z.string(), value: text, note: text.optional(), tone });
const StepProps = z.object({ label: z.string(), state: z.enum(STATES), note: text.optional() });
const FactProps = z.object({ label: z.string(), value: text, tone });
const ChoiceProps = z.object({ label: z.string(), reply: z.string(), why: z.string().optional(), effect: z.string().optional() });
const InputProps = z.object({ name: z.string(), label: z.string() });
const SelectProps = z.object({ name: z.string(), label: z.string(), options: z.array(z.string()) });
const MomentProps = z.object({ time: z.string(), label: z.string(), state: z.enum(STATES).optional(), note: text.optional() });
const DeltaProps = z.object({ label: z.string(), before: text, after: text, tone });
const TagProps = z.object({ label: z.string(), tone });
const SparklineProps = z.object({ label: z.string(), values: z.array(z.number()), unit: z.string().optional() });
const StatsProps = z.object({ items: z.array(StatProps) });
const StepsProps = z.object({ items: z.array(StepProps) });
const BarsProps = z.object({ labels: z.array(z.string()), values: z.array(z.number()), unit: z.string().optional() });
const TableProps = z.object({ columns: z.array(z.string()), rows: z.array(z.array(text)) });
const FactsProps = z.object({ items: z.array(FactProps) });
const CalloutProps = z.object({ text: z.string(), tone });
const ProgressProps = z.object({ label: z.string(), done: z.number(), total: z.number(), note: text.optional() });
const ChoicesProps = z.object({ items: z.array(ChoiceProps) });
const TimelineProps = z.object({ items: z.array(MomentProps) });
const CompareProps = z.object({ before: z.string(), after: z.string(), items: z.array(DeltaProps) });
const TagsProps = z.object({ items: z.array(TagProps) });
const SparklinesProps = z.object({ items: z.array(SparklineProps) });
const ButtonProps = z.object({ label: z.string(), action: z.union([steps.OpenUrl.ref, steps.ToAssistant.ref]).optional() });
const FormProps = z.object({ fields: z.array(z.union([InputProps, SelectProps])), template: z.string(), submit: z.string() });
const CardProps = z.object({ title: z.string(), children: z.array(z.union([StatsProps, StepsProps, BarsProps, TableProps, FactsProps, CalloutProps, ProgressProps, ChoicesProps, TimelineProps, CompareProps, TagsProps, SparklinesProps, ButtonProps, FormProps])) });

/** 컴포넌트 이름·설명·등록 스키마. 순서가 등록 순서다. 렌더러는 여기에 component 만 붙인다. */
export const SPECS = {
  Card: { name: "Card", description: "Titled group of components.", props: CardProps },
  Stats: { name: "Stats", description: "Row of up to four metric tiles.", props: StatsProps },
  Stat: { name: "Stat", description: "One metric tile.", props: StatProps },
  Steps: { name: "Steps", description: "List of work items with their states.", props: StepsProps },
  Step: { name: "Step", description: "One work item and its state.", props: StepProps },
  Bars: { name: "Bars", description: "Horizontal bars for label/value pairs.", props: BarsProps },
  Table: { name: "Table", description: "Compact table; rows are arrays of cells.", props: TableProps },
  Facts: { name: "Facts", description: "Label/value details such as PR, commit or check result.", props: FactsProps },
  Fact: { name: "Fact", description: "One label/value detail.", props: FactProps },
  Callout: { name: "Callout", description: "One sentence to stand out.", props: CalloutProps },
  Progress: { name: "Progress", description: "Fractional progress such as 3 of 5 missions.", props: ProgressProps },
  Choices: { name: "Choices", description: "Retired; renders nothing.", props: ChoicesProps },
  Choice: { name: "Choice", description: "Retired; renders nothing.", props: ChoiceProps },
  Timeline: { name: "Timeline", description: "Timed events in order.", props: TimelineProps },
  Moment: { name: "Moment", description: "One timed event.", props: MomentProps },
  Compare: { name: "Compare", description: "Two named columns compared by row.", props: CompareProps },
  Delta: { name: "Delta", description: "One before/after comparison.", props: DeltaProps },
  Tags: { name: "Tags", description: "A group of noninteractive labels.", props: TagsProps },
  Tag: { name: "Tag", description: "One noninteractive label.", props: TagProps },
  Sparklines: { name: "Sparklines", description: "Up to four numeric trends.", props: SparklinesProps },
  Sparkline: { name: "Sparkline", description: "One numeric trend, oldest first.", props: SparklineProps },
  Button: { name: "Button", description: "Send a message or ask the host to open a visible target.", props: ButtonProps },
  Form: { name: "Form", description: "A few fields composing one message, sent only when clicked.", props: FormProps },
  Input: { name: "Input", description: "One single-line field.", props: InputProps },
  Select: { name: "Select", description: "Choose one value.", props: SelectProps },
} as const;
const schemaLibrary = createLibrary({ components: Object.values(SPECS).map((spec: { readonly name: string; readonly description: string; readonly props: z.ZodObject }) => defineComponent({ ...spec, component: null })), root: "Card" });
const parser = createParser(schemaLibrary.toJSONSchema(), "Card");

// ---- 2. 상한 — 등록 스키마와 따로 둔 Zod 판정(lang-core 는 max/refine 을 보지 않는다, 실측). 노드마다 safeParse.
// 자식 자리에는 허용된 컴포넌트만 — lang-core 는 union 소속을 검사하지 않는다(실측: Card 직속 Stat 이 오류 없이 통과).
const element = (...names: [string, ...string[]]) => z.object({ type: z.literal("element"), typeName: z.enum(names) });
const short = (max: number) => z.string().refine((value) => { const t = value.trim(); return t.length > 0 && t.length <= max; });
const fieldName = z.string().regex(/^[a-z][a-z0-9_]{0,15}$/);
// 한 줄 판정은 표시용 문장에도 적용한다. 명령 접두 규칙은 전송 문장에만 적용한다.
export const line = (max: number) => z.string().refine((v) => {
  const t = v.trim();
  // eslint-disable-next-line no-control-regex
  return !!t && t.length <= max && !/[\u0000-\u001f\u007f\p{Zl}\p{Zp}]/u.test(v);
});
const inputLimit = z.object({ name: fieldName, label: line(40) });
const selectLimit = inputLimit.extend({ options: z.array(line(40)).min(2).max(6).refine((values) => new Set(values).size === values.length) });
export function formReady(p: Record<string, unknown>): boolean {
  const fields = list(p.fields);
  if (!fields.length || fields.length > 4 || typeof p.template !== "string" || !line(160).safeParse(p.template).success) return false;
  const names = fields.flatMap((f) => isNode(f, "Input") && inputLimit.safeParse(f.props).success || isNode(f, "Select") && selectLimit.safeParse(f.props).success ? [(f as Node).props.name as string] : []);
  // 첫 필드가 만든 명령 접두는 composeDraft의 완성 문장 판정과 전송 직전 검사에서 거절한다.
  if (names.length !== fields.length || new Set(names).size !== names.length || /^[/@]/u.test(p.template.trim())) return false;
  const used = new Set<string>();
  const rest = p.template.replace(/\{([a-z][a-z0-9_]{0,15})\}/g, (_, name: string) => { used.add(name); return ""; });
  return !/[{}]/u.test(rest) && names.every((name) => used.has(name)) && [...used].every((name) => names.includes(name));
}

// 등록 때는 액션 문법을 알리지만, 판정은 단일 리터럴 단계만 허용한다. Action·Run·상태 변경은 실행기에 닿지 않는다.
export type SafeAction = { readonly type: "send"; readonly message: string; readonly max: 200 | 480 } | { readonly type: "open"; readonly url: string };
const literalAction = z.object({ k: z.literal("Comp"), name: z.enum(["OpenUrl", "ToAssistant"]), args: z.tuple([z.object({ k: z.literal("Str"), v: z.string() }).strict()]), mappedProps: z.record(z.string(), z.unknown()).optional() }).strict();
// 형태는 단일 @OpenUrl 리터럴인데 대상만 거부된 단추 — 누를 수 없는 라벨로 남긴다. 대상 판정은 그대로라 권한은 넓어지지 않는다.
function refusedSourceOpen(value: unknown): string | null {
  const action = literalAction.safeParse(value);
  return action.success && action.data.name === "OpenUrl" && !parseOpenUIOpenTarget(action.data.args[0].v) ? action.data.args[0].v : null;
}
export function sourceAction(value: unknown, label: unknown): SafeAction | null {
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
const buttonAction = (value: unknown, label: unknown) => sourceAction(value, label) !== null || refusedSourceOpen(value) !== null;

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
  // 은퇴한 선택지는 그리지 않으므로 상한도 보지 않는다 — 옛 카드의 형제를 지키는 것이 목적이다.
  Choices: z.object({ items: z.array(element("Choice")) }),
  Choice: z.object({}),
  Button: z.object({ label: line(40), action: z.unknown().optional() }).refine((p) => buttonAction(p.action, p.label)),
  Form: z.object({ fields: z.array(element("Input", "Select")).min(1).max(4), template: z.string(), submit: line(24) }),
  Input: inputLimit,
  Select: selectLimit,
};

// ---- 3. 정제 — 요소 단위로 빼고, 뺀 것과 이유를 모은다. 이유는 다음 턴에 모델이 읽는 영어 한 문장이다.
export interface PrunedPart {
  /** 빠진 요소의 컴포넌트 이름. 블록 전체나 요소에 묶이지 않는 문장이면 null. */
  readonly element: string | null;
  readonly reason: string;
}
export type Verdict = { kind: "render"; source: string } | { kind: "hold" } | { kind: "hide" };
export interface Pruned { readonly verdict: Verdict; readonly dropped: readonly PrunedPart[] }

const BUTTON_REASON = "its action must be one @ToAssistant(\"reply\") or @OpenUrl(\"target\") literal with no extra arguments; the reply is one line of at most 200 characters, not starting with / or @ and not ending in an @mention";
const FORM_REASON = "it needs 1-4 Input/Select fields with unique names matching [a-z][a-z0-9_]{0,15}, Select with 2-6 distinct options, and a one-line template of at most 160 characters that uses every field once as {name} and does not start with / or @";
const DYNAMIC = Symbol("dynamic");
// 자식 요소를 담는 자리. 비면 그 요소를 뺀다.
const ELEMENT_SLOTS: Readonly<Record<string, string>> = { Card: "children", Stats: "items", Steps: "items", Facts: "items", Choices: "items", Timeline: "items", Compare: "items", Tags: "items", Sparklines: "items", Form: "fields" };
const where = (path: readonly PropertyKey[]) => path.length ? path.map(String).join(".") : "the call";
function issueReason(issue: z.core.$ZodIssue): string {
  if (issue.code === "too_big" && issue.origin === "array") return `${where(issue.path)} holds at most ${String(issue.maximum)} items`;
  if (issue.code === "too_small" && issue.origin === "array") return `${where(issue.path)} needs at least ${String(issue.minimum)} items`;
  if (issue.code === "too_big" || issue.code === "too_small") return `${where(issue.path)} is out of range`;
  if (issue.code === "invalid_value") return `${where(issue.path)} must be one of ${issue.values.map((v) => JSON.stringify(v)).join(", ")}`;
  if (issue.code === "custom") return `${where(issue.path)} breaks a limit (empty, too long, multi-line or out of range)`;
  return `${where(issue.path)}: ${issue.message}`;
}

/** 요소 배열의 소속 위반은 그 자식만, 개수 초과는 넘친 뒤쪽만 뺀다. 고친 것이 있으면 true. */
function fixArrays(node: Node, props: Record<string, unknown>, issues: readonly z.core.$ZodIssue[], drop: (element: string | null, reason: string) => void): boolean {
  const removals = new Map<string, Set<number>>();
  let fixed = false;
  for (const issue of issues) {
    const [key, index, field] = issue.path;
    if (typeof key !== "string" || !Array.isArray(props[key])) continue;
    const items = props[key] as unknown[];
    if (issue.path.length === 3 && typeof index === "number" && field === "typeName" && isNode(items[index])) {
      drop(items[index].typeName, `${items[index].typeName} cannot be a child of ${node.typeName}`);
      (removals.get(key) ?? removals.set(key, new Set()).get(key)!).add(index);
    } else if (issue.path.length === 1 && issue.code === "too_big" && issue.origin === "array" && items.every((item) => isNode(item))) {
      const max = Number(issue.maximum);
      for (const extra of items.slice(max)) drop((extra as Node).typeName, `${node.typeName} ${issueReason(issue)}; the rest were left out`);
      props[key] = items.slice(0, max);
      fixed = true;
    }
  }
  for (const [key, indices] of removals) {
    props[key] = (props[key] as unknown[]).filter((_, i) => !indices.has(i));
    fixed = true;
  }
  return fixed;
}

function cleanTree(root: Node, drop: (element: string | null, reason: string) => void): Node | null {
  let forms = 0;
  const value = (raw: unknown): unknown => {
    if (Array.isArray(raw)) {
      const out: unknown[] = [];
      for (const item of raw) {
        const cleaned = value(item);
        if (cleaned === DYNAMIC) return DYNAMIC;
        if (cleaned !== null || !isNode(item)) out.push(cleaned);
      }
      return out;
    }
    if (isNode(raw)) return node(raw);
    if (raw && typeof raw === "object") return DYNAMIC;
    return raw;
  };
  const node = (input: Node): Node | null => {
    const limit = LIMITS[input.typeName];
    if (!limit) { drop(input.typeName, `${input.typeName} is not a component that can be drawn`); return null; }
    const props: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(input.props)) {
      if (input.typeName === "Button" && key === "action") { props[key] = raw; continue; }
      const cleaned = value(raw);
      if (cleaned === DYNAMIC) { drop(input.typeName, `${key} uses a reference, variable or expression; only literal values are drawn`); return null; }
      props[key] = cleaned;
    }
    let check = limit.safeParse(props);
    if (!check.success && fixArrays(input, props, check.error.issues, drop)) check = limit.safeParse(props);
    // 요소 자리가 비면(파서가 떨궜거나 여기서 뺐거나 처음부터 비었거나) 그 요소는 그릴 것이 없다 — 컴포넌트도 빈 자리는 그리지 않는다.
    const slot = ELEMENT_SLOTS[input.typeName];
    if (slot && !list(props[slot]).length) { drop(input.typeName, `${slot} has nothing left to draw`); return null; }
    if (!check.success) {
      const issue = check.error.issues[0]!;
      drop(input.typeName, input.typeName === "Button" && issue.code === "custom" && !issue.path.length ? BUTTON_REASON : issueReason(issue));
      return null;
    }
    if (input.typeName === "Form") {
      if (++forms > 1) { drop("Form", "a card holds only one Form"); return null; }
      if (!formReady(props)) { drop("Form", FORM_REASON); return null; }
    }
    return { ...input, props };
  };
  return node(root);
}

/**
 * 블록 원문 하나의 정제. 확정이면 render(정제한 원문) 또는 hide, 흐르는 중이면 render 또는 hold(지난 그림 유지).
 * 흐르는 중에 빠진 것은 원문이 더 와서 풀릴 수 있으므로 dropped 는 확정 판정에서만 믿는다. 경고는 빼낸 것이 아니라 싣지 않는다.
 */
export function prune(source: string, final: boolean): Pruned {
  const dropped: PrunedPart[] = [];
  // 업스트림 오류 문장은 카탈로그 전체를 늘어놓기도 한다 — 다음 턴 입력이 커지지 않게 한 문장 길이로 자른다.
  const drop = (element: string | null, reason: string) => { dropped.push({ element, reason: reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON - 1)}…` : reason }); };
  const none = (): Pruned => ({ verdict: final ? { kind: "hide" } : { kind: "hold" }, dropped });
  if (!source.trim()) { drop(null, "the block is empty"); return none(); }
  if (source.length > MAX_SOURCE) { drop(null, `the block is longer than ${MAX_SOURCE} characters`); return { verdict: { kind: "hide" }, dropped }; }
  let result: ParseResult;
  try { result = parser.parse(source); } catch { drop(null, "the block could not be parsed"); return none(); }
  if (final) {
    for (const error of result.meta.errors) if (error.severity !== "warning" && error.code !== "no-root") drop(error.component ?? null, error.message);
    for (const name of new Set(result.meta.unresolved)) drop(null, `${name} is referenced but never defined`);
  }
  if (result.queryStatements.length || result.mutationStatements.length) drop(null, "Query and Mutation statements are not supported; only static components are drawn");
  if (Object.keys(result.stateDeclarations).length) drop(null, "$variables are not supported; write literal values");
  const root = result.root as Node | null;
  if (!isNode(root)) { drop(null, "there is no root = Card(...) statement"); return none(); }
  if (root.typeName !== "Card") { drop(root.typeName, "the root must be Card(title, children)"); return none(); }
  const cleaned = cleanTree(root, drop);
  if (!cleaned) return none();
  let rewritten: string;
  try { rewritten = jsonToOpenUI(cleaned as Parameters<typeof jsonToOpenUI>[0], schemaLibrary); } catch { drop(null, "the block could not be drawn"); return none(); }
  return { verdict: { kind: "render", source: rewritten }, dropped };
}
