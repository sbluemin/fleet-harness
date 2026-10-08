import { z } from "zod";
import { inputIssues, type PluginMcpTool } from "./types.js";

/**
 * Console Use 도구 하나는 Console 화면 하나다. 그 화면에서 하는 동사는 필수 `action` 필드 하나로 고르고,
 * action마다 자기 필드만 받는 strict 스키마를 갖는다. 호스트 코어 도구와 플러그인 기여 도구가 이 헬퍼 한 벌을 쓴다.
 *
 * 광고하는 inputSchema 는 최상위 `type: "object"` 하나다 — 프로바이더 tool schema 는 최상위 anyOf/oneOf 를 받지 않는다.
 * 그래서 `action` enum(필수)과 action들의 필드를 합친 optional properties 로 평탄화하고, 어느 필드가 어느 action 의 것인지는
 * 설명 끝의 시그니처 한 줄(`send{text} · answer{askId, answers?} · stop`)로 싣는다. 같은 이름의 필드는 가장 넓은 타입·한도로
 * 느슨하게 합치고, 정확한 제약은 서버가 action별 strict 검증으로 다시 본다. 다른 action 의 필드를 보내 거절되면 issue 의
 * keys 가 그 이름을, acceptedBy 가 그 필드를 받는 action 을 말한다.
 *
 * 결과 객체는 순수 데이터와 함수뿐이다 — 호스트와 플러그인 번들이 서로 다른 zod 사본을 실어도 `instanceof` 없이 오간다.
 */

/** read 는 화면을 보기만 하고, write 는 사람의 화면이나 제품 상태를 바꾼다. 읽기 전용 연결에는 read 만 실린다. */
export type ConsoleToolActionKind = "read" | "write";
/**
 * 호출자 종류. `operation` 은 Operation 세션, `plugin` 은 플러그인 소유 연결(부관 등), `commodore` 는 Objectives 의
 * 사령관처럼 플러그인이 자기 세션에 직접 싣는 도구 묶음이다.
 */
export type ConsoleToolCaller = "operation" | "plugin" | "commodore";

export interface ConsoleToolAction<S extends z.ZodObject = z.ZodObject> {
  readonly kind: ConsoleToolActionKind;
  /** 이 action 의 필드 — `action` 자체는 넣지 않는다. strict 가 아니어도 헬퍼가 strict 로 검증한다. */
  readonly input: S;
  /** 허용 호출자. 생략하면 모든 호출자. */
  readonly callers?: readonly ConsoleToolCaller[];
  /** `callers` 밖의 호출자가 이 action 을 부를 때의 거부 코드. 기본은 `permission_required`. */
  readonly refusal?: string;
  /**
   * 이 action 에만 해당하는 사실 문장. 이 action 이 남는 연결의 설명에만 실린다 — 읽기 전용 연결이나 다른 호출자에게
   * 없는 action 의 사실이 설명에 남지 않는다. 여러 action 이 같은 문장을 가지면 한 번만 싣는다.
   */
  readonly note?: string | readonly string[];
}

export interface ConsoleToolActionInfo {
  readonly kind: ConsoleToolActionKind;
  readonly callers?: readonly ConsoleToolCaller[];
  readonly refusal?: string;
}

/** 연결이나 호출자에 맞춰 action 과 필드를 거른다. 연결 객체 없이 플러그인 코드가 직접 써도 된다. */
export interface ConsoleToolFilter {
  /** false 면 read action 만 남는다. 기본 true. */
  readonly control?: boolean;
  /** 주면 그 호출자에게 허용된 action 만 남는다. */
  readonly caller?: ConsoleToolCaller;
  /** 모든 action 에서 뺄 필드 — 호출자에 묶여 고정된 값(사령관의 Theater 같은). 빠진 필드를 보내면 invalid_arguments 다. */
  readonly omit?: readonly string[];
}

/** acceptedBy — 받지 않은 키마다, 이 연결에서 그 키를 받는 다른 action 들. 어느 action 도 받지 않는 키는 빠진다. */
export type ConsoleToolIssue = ReturnType<typeof inputIssues>[number] & { readonly acceptedBy?: Readonly<Record<string, readonly string[]>> };

export type ConsoleToolParse<C> =
  | { readonly ok: true; readonly call: C }
  | { readonly ok: false; readonly error: string; readonly issues?: readonly ConsoleToolIssue[] };

/** 호스트가 기여 도구에서 읽는 action 선언. 데이터와 함수만 있다. */
export interface ConsoleActionSchema {
  /** 판별 필드 이름. 단일 동작 도구는 null 이다. */
  readonly discriminator: "action" | null;
  readonly actions: Readonly<Record<string, ConsoleToolActionInfo>>;
  /** 거른 뒤 남는 action 이름들. */
  available(filter?: ConsoleToolFilter): readonly string[];
  /** 거른 설명(시그니처 포함)과 평탄화한 inputSchema. 남는 action 이 없으면 null — 그 연결에는 도구를 싣지 않는다. */
  advertise(filter?: ConsoleToolFilter): { readonly description: string; readonly inputSchema: Readonly<Record<string, unknown>> } | null;
  /** action 판별 → 걸러진 action 은 그 거부 코드 → action별 strict 검증(어긋나면 invalid_arguments + issues). */
  parse(args: unknown, filter?: ConsoleToolFilter): ConsoleToolParse<Readonly<Record<string, unknown>>>;
}

export type ConsoleToolCall<A extends Readonly<Record<string, ConsoleToolAction>>> = {
  [K in keyof A & string]: { readonly action: K } & z.output<A[K]["input"]>;
}[keyof A & string];

export interface ConsoleTool<C extends Readonly<Record<string, unknown>>> extends ConsoleActionSchema {
  readonly name: string;
  /** 거르지 않은 설명과 시그니처. */
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  parse(args: unknown, filter?: ConsoleToolFilter): ConsoleToolParse<C>;
  /**
   * 플러그인 도구 한 벌로 감싼다. `filter` 는 설명·inputSchema 만 거른다(사령관 묶음처럼 플러그인이 직접 싣는 도구용) —
   * Console Use 기여는 거르지 않고 넘기며, 호스트가 연결마다 다시 거른다.
   */
  plugin(implementation: Pick<PluginMcpTool, "execute" | "surface">, filter?: ConsoleToolFilter): PluginMcpTool;
}

const TOOL_NAME = /^console_[a-z]+(_[a-z]+)?$/;
const ACTION_NAME = /^[a-z][a-z_]{0,31}$/;

type JsonSchema = Record<string, unknown>;

/** `{ kind, input }` 를 action 마다 선언한 Console Use 도구. */
export function defineConsoleTool<const A extends Readonly<Record<string, ConsoleToolAction>>>(spec: { readonly name: string; readonly description: string; readonly actions: A }): ConsoleTool<ConsoleToolCall<A>>;
/** 동작이 하나뿐인 도구 — `action` 필드 없이 그 입력만 받는다. */
export function defineConsoleTool<S extends z.ZodObject>(spec: { readonly name: string; readonly description: string } & ConsoleToolAction<S>): ConsoleTool<z.output<S>>;
export function defineConsoleTool(spec: { readonly name: string; readonly description: string; readonly actions?: Readonly<Record<string, ConsoleToolAction>> } & Partial<ConsoleToolAction>): ConsoleTool<Readonly<Record<string, unknown>>> {
  if (!TOOL_NAME.test(spec.name)) throw new Error(`Invalid Console Use tool name: ${spec.name}`);
  const discriminated = spec.actions !== undefined;
  const SINGLE = "";
  const actions: Readonly<Record<string, ConsoleToolAction>> = discriminated
    ? spec.actions!
    : { [SINGLE]: { kind: spec.kind!, input: spec.input!, ...(spec.callers ? { callers: spec.callers } : {}), ...(spec.refusal ? { refusal: spec.refusal } : {}), ...(spec.note ? { note: spec.note } : {}) } };
  const names = Object.keys(actions);
  if (!names.length) throw new Error(`Console Use tool needs an action: ${spec.name}`);
  for (const name of names) {
    if (discriminated && !ACTION_NAME.test(name)) throw new Error(`Invalid Console Use action name: ${spec.name}.${name}`);
    if (Object.hasOwn(actions[name]!.input.shape, "action")) throw new Error(`Console Use action input must not declare action: ${spec.name}.${name}`);
  }
  const fields = new Map(names.map((name) => [name, fieldSchemas(actions[name]!.input)]));
  // 정의 단계에서 한 번 합쳐 본다 — 같은 이름에 타입이 다른 필드는 광고 스키마를 거짓으로 만들므로 등록 전에 막는다.
  mergeFields(spec.name, names.map((name) => fields.get(name)!));
  const info: Record<string, ConsoleToolActionInfo> = discriminated ? Object.fromEntries(names.map((name) => {
    const { kind, callers, refusal } = actions[name]!;
    return [name, { kind, ...(callers ? { callers } : {}), ...(refusal ? { refusal } : {}) }];
  })) : {};
  const allowed = (name: string, filter: ConsoleToolFilter | undefined): string | null => {
    const action = actions[name]!;
    if (filter?.control === false && action.kind !== "read") return "permission_required";
    if (filter?.caller && action.callers && !action.callers.includes(filter.caller)) return action.refusal ?? "permission_required";
    return null;
  };
  const available = (filter?: ConsoleToolFilter) => names.filter((name) => allowed(name, filter) === null);
  const omitted = (filter: ConsoleToolFilter | undefined) => new Set(filter?.omit ?? []);
  const advertise = (filter?: ConsoleToolFilter) => {
    const kept = available(filter);
    if (!kept.length) return null;
    const omit = omitted(filter);
    const perAction = kept.map((name) => ({ name, ...stripFields(fields.get(name)!, omit) }));
    const merged = mergeFields(spec.name, perAction);
    const notes = [...new Set(kept.flatMap((name) => { const note = actions[name]!.note; return note === undefined ? [] : typeof note === "string" ? [note] : [...note]; }))];
    const description = notes.length ? `${spec.description} ${notes.join(" ")}` : spec.description;
    if (!discriminated) {
      const only = perAction[0]!;
      return { description, inputSchema: objectSchema(merged, only.required) };
    }
    // 모든 action 이 같은 필수 필드를 받으면(Operation 패널의 operationId) 줄 머리에 한 번만 적는다.
    const shared = perAction.length > 1 ? perAction[0]!.required.filter((key) => perAction.every(({ required }) => required.includes(key))) : [];
    const signature = perAction.map(({ name, properties, required }) => {
      const keys = Object.keys(properties).filter((key) => !shared.includes(key));
      return keys.length ? `${name}{${keys.map((key) => required.includes(key) ? key : `${key}?`).join(", ")}}` : name;
    }).join(" · ");
    return {
      description: `${description}\nActions${shared.length ? ` (each takes ${shared.join(", ")})` : ""}: ${signature}`,
      inputSchema: objectSchema({ action: { type: "string", enum: kept }, ...merged }, ["action", ...shared]),
    };
  };
  const strictInputs = new Map<string, z.ZodObject>();
  const strictInput = (name: string, omit: ReadonlySet<string>) => {
    const key = `${name}\u0000${[...omit].sort().join(",")}`;
    let schema = strictInputs.get(key);
    if (!schema) {
      const base = actions[name]!.input;
      const mask = Object.fromEntries(Object.keys(base.shape).filter((field) => omit.has(field)).map((field) => [field, true as const]));
      schema = (Object.keys(mask).length ? base.omit(mask as never) : base).strict();
      strictInputs.set(key, schema);
    }
    return schema;
  };
  const parse = (args: unknown, filter?: ConsoleToolFilter): ConsoleToolParse<Readonly<Record<string, unknown>>> => {
    const record = args === undefined || args === null ? {} : args;
    if (typeof record !== "object" || Array.isArray(record)) return { ok: false, error: "invalid_arguments", issues: [{ path: [], code: "invalid_type" }] };
    let name = SINGLE;
    let rest = record as Record<string, unknown>;
    if (discriminated) {
      const { action, ...others } = record as Record<string, unknown>;
      if (typeof action !== "string" || !Object.hasOwn(actions, action)) return { ok: false, error: "invalid_arguments", issues: [{ path: ["action"], code: action === undefined ? "invalid_type" : "invalid_value" }] };
      name = action;
      rest = others;
    }
    const refusal = allowed(name, filter);
    if (refusal) return { ok: false, error: refusal };
    const omit = omitted(filter);
    const parsed = strictInput(name, omit).safeParse(rest);
    if (!parsed.success) {
      // 다른 action 의 필드를 보냈다면 그 필드를 받는 action 을 함께 말한다 — 호출자가 스키마를 다시 추측하지 않게.
      const owners = (key: string) => discriminated ? available(filter).filter((other) => other !== name && !omit.has(key) && Object.hasOwn(fields.get(other)!.properties, key)) : [];
      const issues: ConsoleToolIssue[] = inputIssues(parsed.error.issues).map((issue) => {
        const acceptedBy = Object.fromEntries((issue.keys ?? []).map((key) => [key, owners(key)] as const).filter(([, actions]) => actions.length > 0));
        return Object.keys(acceptedBy).length ? { ...issue, acceptedBy } : issue;
      });
      return { ok: false, error: "invalid_arguments", issues };
    }
    return { ok: true, call: discriminated ? { action: name, ...(parsed.data as Record<string, unknown>) } : parsed.data as Record<string, unknown> };
  };
  const unfiltered = advertise()!;
  const tool: ConsoleTool<Readonly<Record<string, unknown>>> = {
    name: spec.name,
    description: unfiltered.description,
    inputSchema: unfiltered.inputSchema,
    discriminator: discriminated ? "action" : null,
    actions: info,
    available: (filter) => discriminated ? available(filter) : [],
    advertise,
    parse,
    plugin: (implementation, filter) => {
      const advertised = filter ? advertise(filter) : unfiltered;
      if (!advertised) throw new Error(`Console Use tool has no action for this caller: ${spec.name}`);
      return { name: spec.name, description: advertised.description, inputSchema: advertised.inputSchema, actionSchema: tool, ...implementation };
    },
  };
  return tool;
}

/** action 한 개의 필드 JSON 스키마와 필수 목록. `$schema` 같은 머리말은 버린다. */
function fieldSchemas(input: z.ZodObject): { readonly properties: Readonly<Record<string, JsonSchema>>; readonly required: readonly string[] } {
  const json = advertisedBounds(z.toJSONSchema(input, { io: "input" })) as JsonSchema;
  const properties = (json.properties ?? {}) as Record<string, JsonSchema>;
  return { properties, required: Array.isArray(json.required) ? json.required as string[] : [] };
}

/**
 * 광고 스키마의 한계는 모델이 평범한 호출에서도 넘길 수 있는 짧은 것만 남긴다 — 넘겨서 invalid_arguments 로 되돌아오는
 * 왕복을 막는 한도(제목·사유·한 줄 입력)다. 긴 본문 한도·최소 길이·최소 개수와 zod `int()` 의 안전 정수 한계는 잡음이라
 * 걷어 낸다. 수의 범위와 enum 은 남긴다. 정확한 제약은 서버가 action별 strict 로 본다.
 */
const SHORT_MAX_LENGTH = 1000;
const SHORT_MAX_ITEMS = 20;
const dropBound = (key: string, entry: unknown) =>
  key === "minLength" || key === "minItems"
  || (key === "maxLength" && typeof entry === "number" && entry >= SHORT_MAX_LENGTH)
  || (key === "maxItems" && typeof entry === "number" && entry > SHORT_MAX_ITEMS)
  || (key === "minimum" && entry === Number.MIN_SAFE_INTEGER) || (key === "maximum" && entry === Number.MAX_SAFE_INTEGER);
function advertisedBounds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(advertisedBounds);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key, entry]) => !dropBound(key, entry))
    .map(([key, entry]) => [key, key === "properties" ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).map(([field, schema]) => [field, advertisedBounds(schema)])) : advertisedBounds(entry)]));
}

function stripFields(schema: { readonly properties: Readonly<Record<string, JsonSchema>>; readonly required: readonly string[] }, omit: ReadonlySet<string>) {
  if (!omit.size) return { properties: schema.properties, required: schema.required };
  return {
    properties: Object.fromEntries(Object.entries(schema.properties).filter(([key]) => !omit.has(key))),
    required: schema.required.filter((key) => !omit.has(key)),
  };
}

function objectSchema(properties: Readonly<Record<string, JsonSchema>>, required: readonly string[]): JsonSchema {
  return { type: "object", properties, ...(required.length ? { required: [...required] } : {}), additionalProperties: false };
}

/** 같은 이름의 필드를 하나로 — 같은 스키마면 그대로, 다르면 가장 넓은 타입·한도로. 바탕 타입이 다르면 정의 오류다. */
function mergeFields(tool: string, actions: readonly { readonly properties: Readonly<Record<string, JsonSchema>> }[]): Record<string, JsonSchema> {
  const byField = new Map<string, JsonSchema[]>();
  for (const { properties } of actions) for (const [key, value] of Object.entries(properties)) byField.set(key, [...(byField.get(key) ?? []), value]);
  const merged: Record<string, JsonSchema> = {};
  for (const [key, variants] of byField) merged[key] = mergeField(tool, key, variants);
  return merged;
}

function mergeField(tool: string, key: string, variants: readonly JsonSchema[]): JsonSchema {
  const distinct = [...new Map(variants.map((variant) => [JSON.stringify(variant), variant])).values()];
  if (distinct.length === 1) return distinct[0]!;
  const kinds = distinct.map(baseTypes);
  const signature = (types: ReadonlySet<string>) => [...types].filter((type) => type !== "null").map((type) => type === "integer" ? "number" : type).sort().join("|");
  if (new Set(kinds.map(signature)).size !== 1) throw new Error(`Console Use field ${tool}.${key} has conflicting types across actions`);
  const nullable = kinds.some((types) => types.has("null"));
  const description = distinct.map((variant) => variant.description).find((value): value is string => typeof value === "string");
  const branches = distinct.map((variant) => nonNull(variant));
  const types = [...new Set(kinds.flatMap((types) => [...types]).filter((type) => type !== "null"))];
  let loose: JsonSchema;
  if (types.length === 1 && ["string", "boolean"].includes(types[0]!) || types.every((type) => type === "number" || type === "integer")) {
    const type = types.length === 1 ? types[0]! : "number";
    loose = { type };
    const widest = (field: string, pick: (values: number[]) => number) => {
      const values = branches.map((branch) => branch[field]);
      if (values.every((value): value is number => typeof value === "number")) loose[field] = pick(values);
    };
    widest("minimum", (values) => Math.min(...values));
    widest("maximum", (values) => Math.max(...values));
    // 남은 maxLength 는 가장 넓은 값으로 — 어느 action 이든 한도 없이 광고된 필드면 합친 필드에도 한도가 없다.
    widest("maxLength", (values) => Math.max(...values));
    if (branches.every((branch) => Array.isArray(branch.enum))) loose.enum = [...new Set(branches.flatMap((branch) => branch.enum as unknown[]))];
  } else {
    loose = types.length === 1 ? { type: types[0] } : { anyOf: types.map((type) => ({ type })) };
  }
  if (description) loose.description = description;
  return nullable ? { anyOf: [loose, { type: "null" }], ...(description ? { description } : {}) } : loose;
}

function nonNull(schema: JsonSchema): JsonSchema {
  if (Array.isArray(schema.anyOf)) {
    const rest = (schema.anyOf as JsonSchema[]).filter((branch) => branch.type !== "null");
    if (rest.length === 1) return rest[0]!;
  }
  return schema;
}

function baseTypes(schema: JsonSchema): Set<string> {
  if (typeof schema.type === "string") return new Set([schema.type]);
  if (Array.isArray(schema.type)) return new Set(schema.type as string[]);
  if (Array.isArray(schema.anyOf)) return new Set((schema.anyOf as JsonSchema[]).flatMap((branch) => [...baseTypes(branch)]));
  if ("const" in schema) return new Set([schema.const === null ? "null" : typeof schema.const]);
  if (Array.isArray(schema.enum)) return new Set((schema.enum as unknown[]).map((value) => value === null ? "null" : typeof value));
  return new Set(["unknown"]);
}
