import type { HelperAction, HelperElement, HelperHello, HelperVerify, HelperWindow, HelperWindows, SnapshotWindow } from "../runtime/fleet-helper.js";
import { FleetHelperError } from "../runtime/fleet-helper.js";
import type { ClipboardRestoration } from "../runtime/macos-paste.js";
import { permissionHolderName, type ComputerUseResult } from "../runtime/platform.js";
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

// 권한 안내 문구(프롬프트 자문 확정, 결정 "permission_required 문구 v2"). 렌더러가 앞에 permission_required를 붙이므로 부족하다는 말은
// 반복하지 않는다. Fleet이 아는 것은 요청을 보냈는지뿐이라, 이력을 모르면 첫 문장을 뺀다. 앱 이름은 TCC 판정 대상이다.
const PERMISSION_REQUEST_LINE = {
  requested: "Fleet requested access from macOS.",
  recent: "Fleet recently requested access; no new request was sent.",
} as const;
const PERMISSION_HOLDER_FALLBACK = "the app that started Fleet";
const PERMISSION_LABELS = [["accessibility", "Accessibility"], ["screenRecording", "Screen Recording"]] as const;
// 화면 기록이 빠졌을 때만 붙인다. 갈림은 서명 종류가 아니라 사람이 목록에서 보는 상태(없음·이미 켜짐)다.
// 요청 창이 뜨지 않는 빌드는 목록에 없고, 옛 빌드의 허용은 켜짐으로 남아도 거부된다.
const SCREEN_RECORDING_LIST = "Under Screen Recording, have them add the app with + if it isn’t listed, or turn its switch off and back on if it was already on.";
// 화면 기록을 켜면 macOS가 종료 및 다시 열기를 권하는데, 실측에서 앱이 다시 열리지 않았다. 그 앱이 이 Console을 띄워 지금 세션을
// 호스팅한다고 헬퍼가 확인했을 때만 세션이 끊길 수 있다고 먼저 알리게 한다. 자동 복귀·재시도는 약속하지 않는다.
const SCREEN_RECORDING_REOPEN = "If they choose Quit & Reopen and the app stays closed, have them reopen it manually.";
const SCREEN_RECORDING_REOPEN_HOSTING = "If they choose Quit & Reopen, warn them first that this session may be interrupted and that they may need to reopen the app manually.";
// 허용 뒤 첫 캡처에서 macOS(ScreenCaptureKit)가 따로 확인 창을 띄운다. 예고일 뿐 시험 캡처나 재승인 지시가 아니다.
const SCREEN_RECORDING_NEXT_CAPTURE = "On the next capture, macOS may ask the user to confirm Screen Recording for that app.";

function permissionHint(details: Record<string, unknown> | undefined): string {
  const missing = Array.isArray(details?.missing) ? details.missing : [];
  const names = PERMISSION_LABELS.filter(([key]) => missing.includes(key)).map(([, label]) => label).join(" and ") || "the required permissions";
  const holder = permissionHolderName(details?.holder);
  const request = details?.request === "requested" || details?.request === "recent" ? `${PERMISSION_REQUEST_LINE[details.request]} ` : "";
  const ask = `${request}Ask the user to enable ${names} for ${holder ?? PERMISSION_HOLDER_FALLBACK} in System Settings › Privacy & Security.`;
  if (!missing.includes("screenRecording")) return `${ask} Retry after the user confirms the change.`;
  const reopen = holder && details?.holderHostsSession === true ? SCREEN_RECORDING_REOPEN_HOSTING : SCREEN_RECORDING_REOPEN;
  return `${ask} ${SCREEN_RECORDING_LIST} ${reopen} Retry after the user confirms the change. ${SCREEN_RECORDING_NEXT_CAPTURE}`;
}

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
  if (code === "permission_required") return permissionHint(details);
  return error instanceof InvalidComputerUseParameters ? error.detail : (Object.hasOwn(hint, code) ? hint[code]! : hint.internal!);
}

export function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}
export function gateResult(error: string, hintText?: string) {
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
      : reply.verified === "selection_matches" && args.text !== undefined ? `selection matches ${quoteApp(args.text)}`
        : reply.verified === "selection_covers_all" ? `${args.target ?? "editable field"} selection covers all text` : null;
  const code = verified ? "verified" : reply.observation === "changes" ? "changes" : reply.observation === "none" ? "no_visible_change" : "effect_unknown";
  const verdict = verified ? `verified: ${verified}` : code === "changes" ? "sent; changes:" : code === "no_visible_change" ? "sent; no visible change" : "sent; effect unknown";
  const lines = [`${actionTarget(args)}${reply.via ? ` via ${reply.via}` : ""}: ${verdict}`];
  const elementChanges = reply.changes.filter(({ op }) => op === "+" || op === "-" || op === "~");
  const changes = [...elementChanges.map(({ op, element }) => `${op} ${elementLine(element)}`), ...windowChanges];
  const shown = changes.slice(0, 30);
  lines.push(...shown);
  const exposed = elementChanges.slice(0, shown.length).filter(({ op }) => op !== "-").map(({ element }) => element);
  const more = Math.max(0, changes.length - 30) + (reply.changesMore ?? 0);
  if (more) lines.push(`… ${more} more changes; call computer_state`);
  if (args.action === "set_value" || reply.notes.includes("ax_value_set")) lines.push("note: Setting an AX value may not fire app change events.");
  if (reply.via === "event+focus" || reply.notes.includes("focus_record_used")) lines.push("note: Focus signal sent only to the target; the app may treat its window as active. No foreground switch requested.");
  if (reply.notes.includes("key_window_click")) lines.push("note: Sent a click to the target field before the shortcut; page handlers may run.");
  return { result: textResult(lines.join("\n") + clipboardLine(clipboard)), code, exposed };
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
