/**
 * OpenUI 렌더러 — `openui.ts` 하이드레이터가 처음 블록을 만날 때만 불러오는 지연 청크.
 *
 * 파싱은 `@openuidev/lang-core`가, 그리기는 이 파일의 화이트리스트 DOM 빌더가 맡는다. 업스트림 React 렌더러와 기본
 * 컴포넌트 묶음은 들이지 않는다. 빌더는 고정된 태그·클래스만 만들고, 모델이 준 문자열은 `textContent`로만, 숫자는
 * 0–100%로 고정한 폭으로만 들어간다 — innerHTML·href·src·이벤트 핸들러를 만드는 경로가 없다.
 */

import { createLibrary, createParser, defineComponent, type ElementNode, type ParseResult } from "@openuidev/lang-core";
import { z } from "zod";

export type OpenUIState = "todo" | "running" | "waiting" | "done" | "blocked";
export type OpenUITone = "good" | "warn" | "bad";

export interface OpenUIRenderLabels {
  readonly states: Readonly<Record<OpenUIState, string>>;
  readonly tones: Readonly<Record<OpenUITone, string>>;
}

export type OpenUIRenderResult =
  | { readonly kind: "tree"; readonly node: HTMLElement }
  | { readonly kind: "pending" }
  | { readonly kind: "fallback" };

export interface OpenUIRenderer {
  render(document: Document, source: string, final: boolean, labels: OpenUIRenderLabels): OpenUIRenderResult;
}

// 자원 상한 — 넘으면 확정 때 코드 블록으로 돌아간다. 말풍선 안의 작은 UI라는 쓰임새에서 정한 값이다.
const MAX_SOURCE = 16 * 1024;
const MAX_CHILDREN = 8;
const MAX_STATS = 4;
const MAX_STEPS = 50;
const MAX_BARS = 12;
const MAX_COLUMNS = 8;
const MAX_ROWS = 50;
const MAX_TEXT = 200;
const MAX_UNIT = 8;

const STATES: readonly OpenUIState[] = ["todo", "running", "waiting", "done", "blocked"];
const TONES: readonly OpenUITone[] = ["good", "warn", "bad"];
// 지표의 tone은 Fleet 상태 어휘의 점 하나로 말한다 — 양호=완료색, 주의=진행색, 문제=막힘색.
const TONE_DOT: Readonly<Record<OpenUITone, OpenUIState>> = { good: "done", warn: "running", bad: "blocked" };

const text = z.union([z.string(), z.number()]);
const tone = z.enum(TONES as [OpenUITone, ...OpenUITone[]]).optional();

const Stat = defineComponent({
  name: "Stat",
  description: "One metric tile.",
  props: z.object({ label: z.string(), value: text, note: text.optional(), tone }),
  component: null,
});
const Stats = defineComponent({
  name: "Stats",
  description: "Row of up to four metric tiles.",
  props: z.object({ items: z.array(Stat.ref) }),
  component: null,
});
const Step = defineComponent({
  name: "Step",
  description: "One work item and its state.",
  props: z.object({ label: z.string(), state: z.enum(STATES as [OpenUIState, ...OpenUIState[]]), note: text.optional() }),
  component: null,
});
const Steps = defineComponent({
  name: "Steps",
  description: "List of work items with their states.",
  props: z.object({ items: z.array(Step.ref) }),
  component: null,
});
const Bars = defineComponent({
  name: "Bars",
  description: "Horizontal bars for label/value pairs.",
  props: z.object({ labels: z.array(z.string()), values: z.array(z.number()), unit: z.string().optional() }),
  component: null,
});
const Table = defineComponent({
  name: "Table",
  description: "Compact table; rows are arrays of cells.",
  props: z.object({ columns: z.array(z.string()), rows: z.array(z.array(text)) }),
  component: null,
});
const Card = defineComponent({
  name: "Card",
  description: "Titled group of components.",
  props: z.object({ title: z.string(), children: z.array(z.union([Stats.ref, Steps.ref, Bars.ref, Table.ref])) }),
  component: null,
});

const library = createLibrary({ components: [Card, Stats, Stat, Steps, Step, Bars, Table], root: "Card" });

/** 상한을 넘었거나 그릴 수 없는 노드 — 확정이면 폴백, 흐르는 중이면 지난 그림을 지킨다. */
class Unrenderable extends Error {}

export function createOpenUIRenderer(): OpenUIRenderer {
  const parser = createParser(library.toJSONSchema(), "Card");
  return {
    render(document, source, final, labels) {
      if (source.length > MAX_SOURCE) return final ? { kind: "fallback" } : { kind: "pending" };
      let result: ParseResult;
      try { result = parser.parse(source); } catch { return final ? { kind: "fallback" } : { kind: "pending" }; }
      if (final && !acceptable(result)) return { kind: "fallback" };
      const root = result.root;
      if (!root || root.typeName !== "Card") return final ? { kind: "fallback" } : { kind: "pending" };
      try {
        return { kind: "tree", node: new Builder(document, labels, final).card(root) };
      } catch (error) {
        if (!(error instanceof Unrenderable)) throw error;
        return final ? { kind: "fallback" } : { kind: "pending" };
      }
    },
  };
}

/**
 * 확정 판정(엄격) — 문법 오류·미해결 참조·잘림이 하나라도 있거나, 정적 그림 밖의 기능(Query·Mutation·$상태·동적 루트)을
 * 쓰면 그리지 않는다. 빠진 칸이 사실을 바꿔 보이게 하느니 원문을 보여 준다. 경고(severity: warning)는 그림을 막지 않는다.
 */
function acceptable(result: ParseResult): boolean {
  if (result.meta.incomplete) return false;
  if (result.meta.errors.some((error) => error.severity !== "warning")) return false;
  if (result.meta.unresolved.length > 0) return false;
  if (result.queryStatements.length > 0 || result.mutationStatements.length > 0) return false;
  if (Object.keys(result.stateDeclarations).length > 0) return false;
  return result.rootExpression === undefined;
}

class Builder {
  constructor(
    private readonly document: Document,
    private readonly labels: OpenUIRenderLabels,
    private readonly final: boolean,
  ) {}

  card(node: ElementNode): HTMLElement {
    const props = this.props(node);
    const section = this.element("section", "openui");
    const title = plain(props.title);
    if (title) section.append(this.element("p", "openui-title", title));
    const children = list(props.children);
    if (children.length > MAX_CHILDREN) throw new Unrenderable();
    for (const child of children) {
      const element = this.child(child);
      if (element) section.append(element);
    }
    return section;
  }

  private child(value: unknown): HTMLElement | null {
    const node = elementNode(value);
    if (!node) return null;
    switch (node.typeName) {
      case "Stats": return this.stats(node);
      case "Steps": return this.steps(node);
      case "Bars": return this.bars(node);
      case "Table": return this.table(node);
      default: return this.skip();
    }
  }

  private stats(node: ElementNode): HTMLElement | null {
    const items = list(this.props(node).items).map(elementNode).filter((item): item is ElementNode => item?.typeName === "Stat");
    if (items.length > MAX_STATS) throw new Unrenderable();
    const row = this.element("div", "openui-stats openui-face");
    row.setAttribute("role", "group");
    for (const item of items) {
      const props = this.props(item);
      const label = plain(props.label);
      const value = plain(props.value);
      if (label === null || value === null) { this.skip(); continue; }
      const tile = this.element("div", "openui-stat");
      const head = this.element("span", "openui-stat-label");
      const toneName = oneOf(props.tone, TONES);
      if (toneName) head.append(this.dot(TONE_DOT[toneName], this.labels.tones[toneName]));
      head.append(label);
      tile.append(head, this.element("span", "openui-stat-value", value));
      const note = plain(props.note);
      if (note) tile.append(this.element("span", "openui-stat-note", note));
      row.append(tile);
    }
    return row.childElementCount ? row : null;
  }

  private steps(node: ElementNode): HTMLElement | null {
    const items = list(this.props(node).items).map(elementNode).filter((item): item is ElementNode => item?.typeName === "Step");
    if (items.length > MAX_STEPS) throw new Unrenderable();
    const rows = this.element("div", "openui-steps openui-face");
    rows.setAttribute("role", "list");
    for (const item of items) {
      const props = this.props(item);
      const label = plain(props.label);
      const state = oneOf(props.state, STATES);
      if (label === null || state === null) { this.skip(); continue; }
      const row = this.element("div", `openui-step is-${state}`);
      row.setAttribute("role", "listitem");
      row.append(this.dot(state, this.labels.states[state]), this.element("span", "openui-step-label", label));
      const note = plain(props.note);
      if (note) row.append(this.element("span", "openui-step-note", note));
      rows.append(row);
    }
    return rows.childElementCount ? rows : null;
  }

  private bars(node: ElementNode): HTMLElement | null {
    const props = this.props(node);
    const labels = list(props.labels);
    const values = list(props.values);
    const count = Math.min(labels.length, values.length);
    if (count > MAX_BARS) throw new Unrenderable();
    const pairs: { label: string; value: number }[] = [];
    for (let index = 0; index < count; index++) {
      const label = plain(labels[index]);
      const value = values[index];
      if (label === null || typeof value !== "number" || !Number.isFinite(value)) { this.skip(); continue; }
      pairs.push({ label, value });
    }
    if (pairs.length === 0) return null;
    const unit = typeof props.unit === "string" ? props.unit.slice(0, MAX_UNIT) : "";
    // 백분율은 100을 기준으로 잰다 — 가장 큰 값이 꽉 찬 막대가 되면 62%가 100%처럼 보인다.
    const max = Math.max(...pairs.map((pair) => pair.value), unit === "%" ? 100 : 0);
    const format = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
    const chart = this.element("div", "openui-bars openui-face");
    for (const pair of pairs) {
      const track = this.element("span", "openui-bar-track");
      const fill = this.element("span", "openui-bar-fill");
      // 폭은 계산한 숫자만 CSSOM으로 넣는다 — 모델의 문자열이 style에 닿지 않는다.
      fill.style.width = `${max > 0 ? Math.min(100, Math.max(0, (pair.value / max) * 100)) : 0}%`;
      track.append(fill);
      chart.append(this.element("span", "openui-bar-label", pair.label), track, this.element("span", "openui-bar-value", `${format.format(pair.value)}${unit}`));
    }
    return chart;
  }

  private table(node: ElementNode): HTMLElement | null {
    const props = this.props(node);
    const columns = list(props.columns);
    const rows = list(props.rows);
    if (columns.length === 0 || columns.length > MAX_COLUMNS || rows.length > MAX_ROWS) {
      if (columns.length === 0) return null;
      throw new Unrenderable();
    }
    // 칸 문법(여백·헤어라인·머리칸)은 채팅 마크다운 표 규칙을 그대로 입는다. 면과 가로 스크롤은 감싼 칸이 지고, 표는 카드 폭을 채운다.
    const frame = this.element("div", "openui-table-frame openui-face");
    const table = this.element("table", "openui-table");
    const head = this.element("thead");
    const headRow = this.element("tr");
    for (const column of columns) headRow.append(this.element("th", undefined, plain(column) ?? ""));
    head.append(headRow);
    const body = this.element("tbody");
    for (const row of rows) {
      const cells = list(row);
      if (cells.length > MAX_COLUMNS) throw new Unrenderable();
      const tr = this.element("tr");
      for (let index = 0; index < columns.length; index++) tr.append(this.element("td", undefined, plain(cells[index]) ?? ""));
      body.append(tr);
    }
    table.append(head, body);
    frame.append(table);
    return frame;
  }

  private dot(state: OpenUIState, label: string): HTMLElement {
    const dot = this.element("span", `openui-dot is-${state}`);
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", label);
    return dot;
  }

  /** 정적 그림만 그린다 — 동적 prop(식·$상태)을 가진 노드는 값을 읽지 않는다. */
  private props(node: ElementNode): Record<string, unknown> {
    if (node.hasDynamicProps !== false) throw new Unrenderable();
    return node.props;
  }

  /** 흐르는 중에는 아직 덜 온 노드를 건너뛰고, 확정 때 남은 결함은 판정이 이미 걸렀으므로 여기 오면 그리지 않는다. */
  private skip(): null {
    if (this.final) throw new Unrenderable();
    return null;
  }

  private element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, content?: string): HTMLElementTagNameMap[K] {
    const element = this.document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = content;
    return element;
  }
}

function elementNode(value: unknown): ElementNode | null {
  if (!value || typeof value !== "object") return null;
  const node = value as Partial<ElementNode>;
  return node.type === "element" && typeof node.typeName === "string" && node.props && typeof node.props === "object" ? node as ElementNode : null;
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 글자 칸 — 문자열과 유한한 숫자만 받고 길이를 자른다. 그 밖의 값(식 AST 등)은 글자가 되지 않는다. */
function plain(value: unknown): string | null {
  const raw = typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
  if (raw === null) return null;
  return raw.length > MAX_TEXT ? `${raw.slice(0, MAX_TEXT - 1)}…` : raw;
}

function oneOf<T extends string>(value: unknown, options: readonly T[]): T | null {
  return typeof value === "string" && (options as readonly string[]).includes(value) ? value as T : null;
}
