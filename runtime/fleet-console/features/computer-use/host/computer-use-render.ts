import type { HelperAction, HelperElement, HelperHello, HelperVerify, HelperWindow, HelperWindows, SnapshotWindow } from "../runtime/fleet-helper.js";
import { FleetHelperError } from "../runtime/fleet-helper.js";
import type { ClipboardRestoration } from "../runtime/macos-paste.js";
import type { ComputerUseResult } from "../runtime/platform.js";
import { InvalidComputerUseParameters, isElementId, type ActionArgs, type Expectation } from "./computer-use-input.js";

export function quoteApp(value: string): string {
  return JSON.stringify(value).replace(/\\(?:\\|[bf])|[\u007f-\u009f\u2028\u2029]/gu, (token) => {
    if (token === "\\\\") return token;
    if (token === "\\b") return "\\u0008";
    if (token === "\\f") return "\\u000c";
    return `\\u${token.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

const hint: Record<string, string> = {
  stale_element: "That element id is no longer valid for this window. Call computer_state and use a current id.",
  coordinates_need_image: "Call computer_state with image:true. Read the coordinates from that new image and use its view id.",
  text_via_key: "key sends key codes that depend on the user's input source. Use type for text.",
  invalid_key: "Unknown key name. Use names like Return, Tab, Escape, Backspace, Delete, Up, Down, Left, Right, Home, End, PageUp, PageDown, Space, F1–F12, with cmd/ctrl/alt/shift+.",
  no_editable_focus: "Editable focus was not confirmed in the target window. Check the intended field with computer_state.",
  not_settable: "This element does not support AX value replacement.",
  text_not_found: "That text was not found in the element.",
  invalid_name: "Use an action name exactly as listed for this element by computer_state.",
  invalid_params: "Check the documented parameters for this call.",
  self_check_failed: "No input sent to the target. Stop and tell the user; file the code once if not already reported.",
  helper_missing: "The Fleet Computer Use helper is not available in this Console installation.",
  timeout: "The helper did not answer in time.",
  internal: "The Fleet Computer Use helper could not complete the request.",
  clipboard_prepare_failed: "The clipboard could not be prepared.",
};

function errorHint(error: FleetHelperError): string {
  const { code, details } = error;
  if (code === "window_unavailable") {
    const reason = details?.reason;
    if (reason === "closed") return "This window is closed. If it is reopened, get its new id with computer_apps.";
    if (reason === "hidden" || reason === "minimized" || reason === "other_space") {
      return `Window unavailable: ${reason === "other_space" ? "on another Space" : reason}. If needed, ask the user to make the intended window visible on the current Space.`;
    }
    return "Window unavailable.";
  }
  if (code === "drag_unsupported") {
    return "Fleet does not support background drag for this target." + (details?.settableSlider === true
      ? " To change the slider value, use set_value; app change events may not fire."
      : " If the drag itself is required, ask the user to perform it.");
  }
  if (code === "permission_required") {
    const missing = Array.isArray(details?.missing) ? details.missing : [];
    const names = [["accessibility", "Accessibility"], ["screenRecording", "Screen Recording"]].filter(([key]) => missing.includes(key)).map(([, label]) => label).join(" and ");
    return `Fleet Console lacks ${names || "required device permissions"}. If needed, ask the user to grant access in System Settings › Privacy & Security.`;
  }
  return error instanceof InvalidComputerUseParameters ? error.detail : (Object.hasOwn(hint, code) ? hint[code]! : hint.internal!);
}

export function textResult(text: string, isError = false): ComputerUseResult {
  return { content: [{ type: "text", text }], isError };
}
export function gateResult(error: string, hintText?: string): ComputerUseResult {
  return textResult(JSON.stringify({ error, ...(hintText ? { hint: hintText } : {}) }), true);
}
export function renderError(error: FleetHelperError, action?: ActionArgs, clipboard?: ClipboardRestoration): ComputerUseResult {
  const code = /^(?:[a-z][a-z_]{0,63})$/u.test(error.code) ? error.code : "internal";
  const text = action
    ? `${actionTarget(action)}: ${error.uncertain ? "dispatch unknown: timeout — Check with computer_verify or computer_state; do not replay the action." : `not sent: ${code} — ${errorHint(error)}`}`
    : `${code === "invalid_params" ? "not sent: invalid_params —" : `error ${code}:`} ${errorHint(error)}`;
  return textResult(text + clipboardLine(clipboard), true);
}

const ACTION_ALIASES = new Map(Object.entries({ AXShowMenu: "menu", AXIncrement: "incr", AXDecrement: "decr", AXConfirm: "confirm", AXCancel: "cancel" }));
export function offeredAction(name: string): string | undefined {
  return name === "AXPress" || name === "AXRaise" ? undefined : ACTION_ALIASES.get(name) ?? name;
}
const ROLES = new Map(Object.entries({ AXStaticText: "text", AXTextField: "textfield", AXTextArea: "textarea", AXButton: "button", AXCheckBox: "checkbox", AXRadioButton: "radio", AXRadioGroup: "radiogroup", AXSlider: "slider", AXScrollArea: "scrollarea", AXGroup: "group", AXSplitter: "splitter", AXSplitGroup: "splitgroup", AXLink: "link", AXImage: "image", AXList: "list", AXRow: "row", AXCell: "cell", AXTable: "table", AXColumn: "column", AXOutline: "outline", AXComboBox: "combobox", AXSearchField: "searchfield", AXMenu: "menu", AXMenuBar: "menubar", AXMenuItem: "menuitem", AXPopUpButton: "popupbutton", AXTabGroup: "tabgroup", AXHeading: "heading", AXWebArea: "webarea", AXToolbar: "toolbar", AXDisclosureTriangle: "disclosure", AXProgressIndicator: "progress", AXLayoutArea: "layoutarea", AXScrollBar: "scrollbar" }));
export function nativeRole(role: string): string {
  for (const [key, alias] of ROLES) if (alias === role.toLowerCase()) return key;
  return role;
}
function renderValue(value: unknown): string {
  if (typeof value === "string") return quoteApp(value);
  return typeof value === "boolean" || typeof value === "number" ? String(value) : "unavailable";
}
function moreValue(n: number | undefined) { return n ? ` (+${n.toLocaleString("en-US")} chars)` : ""; }
function elementLine(item: HelperElement, expand = false): string {
  const id = isElementId(item.ref) ? item.ref : "element";
  const value = item.value === undefined ? "" : ` value=${renderValue(item.value)}${moreValue(item.valueMore)}`;
  if (expand) return id + (value || " value=unavailable");
  const role = ROLES.get(item.role) ?? "element";
  const actions = (item.actions ?? []).flatMap((raw) => {
    const action = offeredAction(raw);
    return action === undefined ? [] : [ACTION_ALIASES.has(raw) ? action : quoteApp(action)];
  });
  return `${id} ${role}${item.label === undefined ? "" : ` ${quoteApp(item.label)}`}${value}${item.focused ? " focused" : ""}${item.enabled === false ? " disabled" : ""}${item.selected ? " selected" : ""}${actions.length ? ` [${actions.join(",")}]` : ""}`;
}
const size = ({ w, h }: { w: number; h: number }) => `${Math.round(w)}×${Math.round(h)}`;
export function windowLine(id: string, window: HelperWindow): string {
  const flags = [window.front && "front", window.hidden && "hidden", window.minimized && "minimized", !window.onCurrentSpace && !window.hidden && !window.minimized && "other-space"].filter(Boolean);
  return `${id} ${quoteApp(window.title)} — ${quoteApp(window.app)} ${size(window.frame)}${flags.length ? ` ${flags.join(" ")}` : ""}`;
}
export function renderApps(lines: readonly string[], installed: HelperWindows["installed"]): ComputerUseResult {
  return textResult([...lines, ...(installed ?? []).map((app) => `installed: ${quoteApp(app.name)} ${quoteApp(app.path)}${app.bundleId ? ` ${quoteApp(app.bundleId)}` : ""}`)].join("\n") || "No matching apps or windows.");
}
export function renderState(id: string, window: SnapshotWindow, elements: HelperElement[], more: number, expand?: string, view?: string) {
  const lines = [`${id} ${quoteApp(window.title)} ${size(window.frame)}`];
  if (view) lines.push(`view ${view} ${size(window.frame)}`);
  if (expand) {
    const element = elements.find((item) => item.ref === expand);
    if (element) lines.push(elementLine(element, true));
  } else {
    const outside: { depth: number; count: number }[] = [];
    const flushOutside = (depth: number) => {
      while (outside.length && outside.at(-1)!.depth >= depth) {
        const item = outside.pop()!;
        lines.push(`${" ".repeat(item.depth + 1)}… ${item.count} more`);
      }
    };
    for (const item of elements) {
      const depth = Math.min(100, Math.max(0, item.depth));
      flushOutside(depth);
      lines.push(`${" ".repeat(depth)}${elementLine(item)}`);
      if (item.moreOutside) outside.push({ depth, count: item.moreOutside });
    }
    flushOutside(0);
    if (more > 0) lines.push(`truncated: ${more} more elements (use find or a larger limit)`);
  }
  return textResult(lines.join("\n"));
}
function actionTarget(args: ActionArgs): string {
  return `${args.action} ${args.target ?? (args.x !== undefined && args.y !== undefined ? `(${args.x},${args.y}) ${args.view ?? ""}`.trimEnd() : args.window)}`;
}
const clipboardLine = (result?: ClipboardRestoration) => result ? `\nclipboard: ${result === "restored" ? "restored" : result === "preserved_newer_contents" ? "kept newer contents" : "restore failed"}` : "";
export function renderAction(args: ActionArgs, reply: HelperAction, windowChanges: string[], clipboard?: ClipboardRestoration) {
  const verified = reply.verified === "value_contains_text" ? `${args.target ?? "editable field"} value contains the ${args.action === "paste" ? "pasted" : "typed"} text`
    : reply.verified === "value_equals" ? `${args.target ?? "editable field"} value equals the new value`
      : reply.verified === "selection_matches" && args.text !== undefined ? `selection matches ${quoteApp(args.text)}` : null;
  const code = verified ? "verified" : reply.observation === "changes" ? "changes" : reply.observation === "none" ? "no_visible_change" : "effect_unknown";
  const verdict = verified ? `verified: ${verified}` : code === "changes" ? "sent; changes:" : code === "no_visible_change" ? "sent; no visible change" : "sent; effect unknown";
  const lines = [`${actionTarget(args)}${reply.via ? ` via ${reply.via}` : ""}: ${verdict}`];
  const changes = [...reply.changes.filter(({ op }) => op === "+" || op === "-" || op === "~").map(({ op, element }) => `${op} ${elementLine(element)}`), ...windowChanges];
  lines.push(...changes.slice(0, 30));
  const more = Math.max(0, changes.length - 30) + (reply.changesMore ?? 0);
  if (more) lines.push(`… ${more} more changes; call computer_state`);
  if (args.action === "set_value" || reply.notes.includes("ax_value_set")) lines.push("note: Setting an AX value may not fire app change events.");
  if (reply.via === "event+focus" || reply.notes.includes("focus_record_used")) lines.push("note: Focus signal sent only to the target; the app may treat its window as active. No foreground switch requested.");
  return { result: textResult(lines.join("\n") + clipboardLine(clipboard)), code };
}

const verifyReasons: Record<string, string> = { ambiguous: "matches multiple elements", incomplete: "cannot be determined from an incomplete tree", window_unavailable: "window is unavailable", unobservable: "cannot be observed" };
export function renderVerify(reply: HelperVerify, expect: Expectation[]): ComputerUseResult {
  if (reply.status === "satisfied") return textResult(`satisfied (${expect.length}/${expect.length})`);
  const i = reply.index ?? 0;
  const condition = expect[i] ?? {};
  const label = `#${i + 1}${condition.target ? ` ${condition.target}` : ""}`;
  if (reply.status !== "unsatisfied") return textResult(`unknown: ${label} ${reply.reason === "stale_element" ? "is stale" : (reply.reason && Object.hasOwn(verifyReasons, reply.reason) ? verifyReasons[reply.reason] : "cannot be observed")}`);
  const actual = reply.actual;
  const field = typeof actual === "object" && actual !== null && "field" in actual ? actual.field : undefined;
  const value = typeof actual === "object" && actual !== null && "value" in actual ? actual.value : actual;
  if (field === "value" || field === "exists" || field === "enabled" || field === "selected") return textResult(`unsatisfied: ${label} ${field} ${renderValue(value)} ≠ ${renderValue(condition[field] ?? (field === "exists" ? true : undefined))} after ${reply.waitedMs}ms`);
  return textResult(`unsatisfied: ${label} after ${reply.waitedMs}ms`);
}
export function renderOpen(dispatched: boolean, error: boolean, app: string): ComputerUseResult {
  if (error || !dispatched) return textResult(dispatched ? "open: dispatch unknown; check computer_apps; do not replay" : "open: not sent", true);
  return textResult(`open ${quoteApp(app)}: request sent; check computer_apps`);
}
export function renderSessionStatus(enabled: boolean, hello: HelperHello | null, activity: string): ComputerUseResult {
  const permissions = !hello ? "permissions unchecked" : hello.permissions.accessibility && hello.permissions.screenRecording ? "permissions ok" : "permissions missing";
  return textResult(`status: ${enabled ? "enabled" : "disabled"} · ${!hello ? "helper not started" : hello.selfCheck.ok ? "helper ready" : "helper self-check failed"} · ${permissions} · ${activity}`);
}
export function renderSessionEnd(deviceReleased: boolean): ComputerUseResult {
  return textResult(deviceReleased ? "end: left; device released" : "end: left; others still use the device");
}
