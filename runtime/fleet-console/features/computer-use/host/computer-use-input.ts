import { z } from "zod";
import { computerUseTools } from "./computer-use-tools.js";
import { FleetHelperError } from "../runtime/fleet-helper.js";

const schemas = new Map(computerUseTools.map(({ name, inputSchema }) => [name, z.fromJSONSchema(inputSchema as Parameters<typeof z.fromJSONSchema>[0])]));
export type DeviceTool = typeof computerUseTools[number]["name"];
export type Action = typeof computerUseTools[3]["inputSchema"]["properties"]["action"]["enum"][number];
export interface Point { x: number; y: number }
export interface ActionArgs {
  window: string; action: Action; reason: string; target?: string; x?: number; y?: number; view?: string;
  to?: string; text?: string; format?: "text" | "md" | "html"; key?: string;
  direction?: "up" | "down" | "left" | "right"; pages?: number; name?: string; foreground?: boolean;
}
export interface Expectation { target?: string; role?: string; label?: string; value?: string; exists?: boolean; enabled?: boolean; selected?: boolean }
export interface StateArgs { window: string; find?: string; expand?: string; image?: boolean; limit?: number }
export interface VerifyArgs { window: string; expect: Expectation[]; timeoutMs?: number }
export interface OpenArgs { app: string; reason: string; activate?: boolean }
interface ToolArgs {
  computer_apps: { query?: string };
  computer_state: StateArgs;
  computer_action: ActionArgs;
  computer_verify: VerifyArgs;
  computer_open: OpenArgs;
  computer_session: { op: "status" | "end" };
}

export class InvalidComputerUseParameters extends FleetHelperError {
  constructor(readonly detail: string) { super("invalid_params"); }
}
const invalid = (detail: string): never => { throw new InvalidComputerUseParameters(detail); };
const POINTER = ["target", "x", "y", "view"] as const;
const ACTION_FIELDS = {
  click: [...POINTER, "foreground"], double_click: [...POINTER, "foreground"], right_click: [...POINTER, "foreground"],
  type: ["target", "text", "foreground"], set_value: ["target", "text"], paste: ["target", "text", "format"],
  key: ["target", "key", "foreground"], scroll: [...POINTER, "direction", "pages", "foreground"], drag: [...POINTER, "to"],
  select: ["target", "text"], ax_action: ["target", "name"],
} satisfies Record<Action, readonly (keyof ActionArgs)[]>;
const NAMED_KEYS = /^(?:return|enter|tab|escape|esc|backspace|delete|forwarddelete|(?:arrow)?(?:up|down|left|right)|home|end|pageup|pagedown|space|f(?:[1-9]|1[0-2]))$/u;
const MODIFIER: ReadonlyMap<string, string> = new Map([
  ["cmd", "cmd"], ["command", "cmd"], ["ctrl", "ctrl"], ["control", "ctrl"], ["alt", "alt"], ["option", "alt"], ["shift", "shift"],
]);

export function isElementId(value: string): boolean { return /^e[0-9]+$/u.test(value); }
export function dragPoint(to: string | undefined): Point | undefined {
  if (to === undefined || !/^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?\s*,\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?\s*$/iu.test(to)) return;
  const [x, y] = to.split(",").map(Number);
  if (x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)) return { x, y };
}

function validateKey(value: string) {
  const parts = value.toLowerCase().split("+").map((part) => part.trim());
  const name = parts.pop() ?? "";
  const modifiers = parts.map((mod) => MODIFIER.get(mod));
  if (modifiers.includes(undefined) || new Set(modifiers).size !== modifiers.length) throw new FleetHelperError("invalid_key");
  if (NAMED_KEYS.test(name)) return;
  if (name && [...new Intl.Segmenter().segment(name)].length === 1 && parts.length === 0) throw new FleetHelperError("text_via_key");
  if (name.length !== 1 || (!/^[a-z0-9]$/u.test(name) && !"-=[]\;',./`".includes(name))) throw new FleetHelperError("invalid_key");
}

function validateAction(input: ActionArgs): void {
  const allowed = new Set<string>(["window", "action", "reason", ...ACTION_FIELDS[input.action]]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) invalid(`${key} is not allowed for ${input.action}.`);
  const need = (...keys: (keyof ActionArgs)[]) => { for (const key of keys) if (input[key] === undefined) invalid(`${key} is required for ${input.action}.`); };
  if (input.action === "scroll") need("direction");
  if (input.action === "drag") need("to");
  if (input.action === "ax_action") need("target", "name");
  if (input.action === "set_value" || input.action === "select") need("target", "text");
  if (input.action === "type" || input.action === "paste") need("text");
  if ((input.action === "type" || input.action === "paste" || input.action === "select") && input.text === "") invalid(`text must not be empty for ${input.action}.`);
  if (input.action === "key") { need("key"); validateKey(input.key!); }
  if (!(ACTION_FIELDS[input.action] as readonly string[]).includes("x")) return;
  const hasCoordinates = input.x !== undefined || input.y !== undefined;
  const end = dragPoint(input.to);
  if (input.to !== undefined && !end && !isElementId(input.to)) invalid("to must be an element id or x,y.");
  if (input.target !== undefined ? hasCoordinates : input.x === undefined || input.y === undefined) invalid("Use target or both x and y, never both forms.");
  if ((hasCoordinates || end) && !input.view) throw new FleetHelperError("coordinates_need_image");
  if (!hasCoordinates && !end && input.view !== undefined) invalid("view requires x and y or a coordinate drag destination.");
}

export function parseDeviceInput<K extends DeviceTool>(tool: K, args: unknown): ToolArgs[K] {
  const parsed = schemas.get(tool)!.safeParse(args);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const fields = issue?.path.filter((part) => typeof part === "number" || /^[a-z][a-zA-Z]*$/u.test(String(part))).join(".");
    invalid(fields ? `Missing or invalid ${fields}.` : "Use only the documented arguments.");
  }
  const data = parsed.data as ToolArgs[K];
  if (tool === "computer_action") validateAction(data as ActionArgs);
  if (tool === "computer_verify") {
    for (const [i, condition] of (data as VerifyArgs).expect.entries()) {
      if (!condition.target && !condition.role && !condition.label) invalid(`expect[${i}] needs target, role, or label.`);
    }
  }
  return data;
}
