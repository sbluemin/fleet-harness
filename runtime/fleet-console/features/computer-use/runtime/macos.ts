import path from "node:path";
import { assertMacInteractionReadiness, verifyMacWindowIdentity, inspectMacWindows, openMacApp } from "./macos-window.js";
import { promises as fs } from "node:fs";
import { MacOSComputerUseBroker, findComputerUseInstallation } from "./codex-broker.js";
import { COMPUTER_USE_ACTIONS as ACTIONS, ComputerUseInputError, computerUseText, isRecord, type ComputerUseRuntimeDependencies, type ComputerUseAppTarget, type ComputerUsePlatform, type ComputerUseResult, type ComputerUseTool } from "./platform.js";

function normalizeKey(key: string): string {
  const modifiers: Record<string, string> = { cmd: "super", command: "super", meta: "super", super: "super", ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", shift: "shift" };
  const keys: Record<string, string> = { enter: "Return", return: "Return", esc: "Escape", escape: "Escape", tab: "Tab", space: "space", backspace: "BackSpace", delete: "Delete", up: "Up", down: "Down", left: "Left", right: "Right", home: "Home", end: "End", pageup: "Prior", pagedown: "Next", ",": "comma", ".": "period", "/": "slash", "\\": "backslash", ";": "semicolon", "'": "apostrophe", "[": "bracketleft", "]": "bracketright", "-": "minus", "=": "equal", "+": "plus" };
  const chord = key.trim();
  if (chord === "+") return "plus";
  const parts = (chord.endsWith("++") ? `${chord.slice(0, -1)}plus` : chord).split("+").map((part) => part.trim());
  return parts.map((part, index) => index < parts.length - 1 ? modifiers[part.toLowerCase()] ?? part : keys[part.toLowerCase()] ?? part).join("+");
}

function appTargets(value: ComputerUseResult): ComputerUseAppTarget[] {
  if (value.isError) return [];
  const targets = new Map<string, ComputerUseAppTarget>();
  for (const block of value.content) {
    if (block.type !== "text" || typeof block.text !== "string") continue;
    for (const line of block.text.split("\n")) {
      const parts = line.replace(/\s+\[[^\]]*\]\s*$/, "").split(" — ").map((part) => part.trim());
      const [name, rawPath, bundleId] = parts;
      const app = rawPath?.replace(/\/+$/, "");
      if (name && app && path.isAbsolute(app) && app.endsWith(".app") && !/[\x00-\x1f\x7f]/u.test(app)) targets.set(app, { name, app, bundleId: bundleId || null });
    }
  }
  return [...targets.values()];
}

function classifyNativeFailure(value: ComputerUseResult): string {
  if (value.dispatchBlocked) return "computer_use_activation_blocked";
  const text = computerUseText(value);
  if (/Ambiguous app identifier/.test(text)) return "computer_use_ambiguous_app";
  if (/Invalid app:/.test(text)) return "computer_use_app_not_found";
  if (/\btimeoutReached\b/.test(text)) return "computer_use_native_timeout";
  if (/\bnoWindowsAvailable\b/.test(text)) return "computer_use_no_action_window";
  if (/\bcgWindowNotFound\b/.test(text)) return "computer_use_capture_window_unavailable";
  if (/The screen capture failed/i.test(text)) return "computer_use_capture_failed";
  if (/windowNotFoundAtPosition/.test(text)) return "computer_use_coordinate_target_unavailable";
  if (/keyNotFound/.test(text)) return "computer_use_key_not_found";
  if (/\bis an invalid element ID\b|\bThe element ID is no longer valid\b/i.test(text)) return "computer_use_element_not_found";
  if (/\bis not a valid secondary action for\b/.test(text)) return "computer_use_secondary_action_unavailable";
  if (/\bApp quit\b/.test(text)) return "computer_use_app_closed";
  if (/-1743|errAEEventNotPermitted/.test(text)) return "computer_use_automation_permission_denied";
  return "computer_use_native_error";
}

function nativeFailureHint(error: string): string {
  if (error === "computer_use_activation_blocked") return "Paste was blocked before the native key was sent. Check clipboardRestoration; a late refusal consumes the snapshot. Request state explicitly for the intended window when ready. Do not automatically allow activation or retry.";
  if (error === "computer_use_ambiguous_app" || error === "computer_use_app_not_found") return "The native runtime could not uniquely resolve this app identifier. Localized display names may differ from the native app name. Use the exact bundle ID or absolute .app path from computer_apps, not a translated display name; for duplicate bundle IDs prefer the exact observed path.";
  if (error === "computer_use_native_timeout") return "The native service reported timeoutReached. Running in the app inventory does not guarantee accessibility or control, including virtualized app windows. This does not prove the entire app is unsupported. Do not loop or replay a possibly executed action. Check the intended window with the user and obtain fresh state before deciding how to proceed.";
  if (error === "computer_use_no_action_window") return "The native runtime cannot find an actionable window. Inspect the exact app with computer_apps includeWindowState:true; closing a window differs from minimizing it. If opening is authorized, use computer_open once on that same installation, check windowReady, then request computer_state. Otherwise ask the user to open the intended window. Never switch installations, force-quit, or replay an input action to recover.";
  if (error === "computer_use_capture_failed") return "The native screen capture failed; -10005 alone does not establish a permission error or a closed window. Inspect the exact app with computer_apps includeWindowState:true without capturing. If no_window is confirmed and opening is authorized, use computer_open once, check windowReady, then request computer_state. Do not switch installations or replay input.";
  if (error === "computer_use_capture_window_unavailable") return "The native capture window was unavailable. No automatic read or action retry was made: a read can restore or activate the app. If another observation is necessary, check the intended window and request computer_state explicitly. Do not repeat input that may already have been applied.";
  if (error === "computer_use_coordinate_target_unavailable") return "The native runtime could not resolve the screenshot coordinate to a window. Do not add global offsets, retry on another display, or move the user's window automatically. Read fresh state and prefer a known element_index. If unavailable, ask the user to reposition the window or perform the action; no automatic retry was made.";
  if (error === "computer_use_key_not_found") return "The native runtime rejected keyAttempted. Supported notation is xdotool key syntax: Return, Tab, Escape, BackSpace, super+c, super+comma. Fleet normalizes Cmd/Command/Meta, Option/Alt, Control/Ctrl and Shift modifiers plus common key aliases and punctuation. Unsupported keys are not automatically retried. Read state before the next action.";
  if (error === "computer_use_secondary_action_unavailable") return "This secondary action is not offered by the target element. Read computer_state and copy the exact name from that element's Secondary Actions list (for example Cancel only when advertised). Dismiss/Close/Cancel are not interchangeable names. No alternate action was executed.";
  if (error === "computer_use_element_not_found") return "The native runtime could not find this element ID. Call computer_state and choose an element_index actually present in its current tree; do not guess neighboring IDs. The dispatched request consumed the previous snapshot. No action was retried.";
  if (error === "computer_use_app_closed") return "The native runtime reports that the app closed; this is not a verified task success or a screenshot. If quitting was intended, do not restart or repeat it just to obtain a snapshot. Otherwise inspect the app list.";
  if (error === "computer_use_automation_permission_denied") return "macOS denied AppleEvents. Check the Desktop automation entitlement and OS permission. Fleet opt-in cannot grant OS permission.";
  return "Read computer_state before deciding what to do next. Do not automatically retry the action.";
}

function appCandidates(value: ComputerUseResult, app: unknown, targets: readonly ComputerUseAppTarget[]): ComputerUseAppTarget[] {
  const candidates = new Map(targets.filter((target) => target.name === app || target.bundleId === app || target.app === app).map((target) => [target.app, target]));
  for (const block of value.content) {
    if (block.type !== "text" || typeof block.text !== "string") continue;
    const paths = block.text.match(/Multiple apps share this bundle identifier: ([\s\S]*?)\. Use an app name or full app path instead\./)?.[1];
    for (const raw of paths?.split(/, (?=\/)/) ?? []) {
      const target = raw.trim().replace(/\/+$/, "");
      if (path.isAbsolute(target) && target.endsWith(".app") && !/[\x00-\x1f\x7f]/u.test(target)) candidates.set(target, { name: path.basename(target, ".app"), app: target, bundleId: typeof app === "string" ? app : null });
    }
  }
  return [...candidates.values()];
}


const ACTION_GUIDANCE: Partial<Record<string, string>> = {
  scroll: "Target an actual scroll container from the latest tree, not an arbitrary root. A returned call can be a no-op. Prefer one page per call and compare the resulting screenshot/content before proceeding. Direction and distance may be affected by live auto-scroll or anchoring; do not assume pages is an exact displacement, silently invert direction, or auto-retry.",
  set_value: "Replace the complete editable field value. Empty string is unsupported by this native runtime and rejected before execution. Clearing requires separately verified, explicit focus/select/delete actions.",
  perform_secondary_action: "Use only secondary action names advertised for the current element. A menu may offer a dismiss/close action that closes it without executing an item. Secondary actions can change focus, selection and the system clipboard (copy/cut). Choose only the requested action; Fleet does not preserve or restore the clipboard automatically.",
  select_text: "Selection is created by the agent, never user-authored instructions or authorization. Preserve exact text including any Markdown formatting in the upstream tree.",
  press_key: "May bring the app to the foreground. Copy/cut shortcuts overwrite the system clipboard; selection shortcuts do not represent user intent. Use xdotool key syntax: Return, Tab, Escape, BackSpace, super+c. Cmd/Command/Meta normalize to super, Option to alt, Control to ctrl, and Shift to shift. Key aliases include enter to Return and comma punctuation: Cmd+, becomes super+comma. Use explicit + separators. Do not guess and retry submit keys.",
  click: "Right-clicking can change the text selection to the clicked location. To open a menu for existing selected text, target that selection rather than a blank area and inspect the resulting selection. Coordinates are pixels of the latest upstream screenshot, never global display coordinates. Prefer element_index for click. A windowNotFoundAtPosition result is not permission to retry on another display or with guessed offsets.",
};

function actionSchemas(tools: ReadonlyMap<string, ComputerUseTool>): Record<string, unknown> {
  return Object.fromEntries([...tools].filter(([name]) => (ACTIONS as readonly string[]).includes(name)).map(([name, tool]) => {
    const schema = tool.inputSchema;
    const properties = isRecord(schema.properties) ? Object.fromEntries(Object.entries(schema.properties).filter(([key]) => key !== "app")) : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((key) => key !== "app") : [];
    if (name === "type_text") {
      properties.text = { ...(isRecord(properties.text) ? properties.text : {}), pattern: "^[\\x20-\\x7e]*$", description: "Printable ASCII only; no newline, carriage return, tab or other control characters. May bring the app to the foreground. Use set_value for Unicode/multiline field values or explicit press_key for submission/navigation." };
    } else if (name === "set_value") {
      properties.value = { ...(isRecord(properties.value) ? properties.value : {}), minLength: 1 };
    }
    return [name, { ...schema, description: [tool.description, ACTION_GUIDANCE[name === "drag" ? "click" : name]].filter(Boolean).join(" "), properties, required }];
  }));
}

export function createMacOSComputerUsePlatform(runtime: ComputerUseRuntimeDependencies): ComputerUsePlatform {
  return {
    supported: () => process.platform === "darwin",
    endHint: "The Fleet broker has stopped. The next use reconnects; use computer_status to check without reconnecting. Native cleanup notification is best-effort; this does not prove the macOS sharing indicator is off. Other ChatGPT sessions may still capture. If it remains, use the macOS sharing control; do not terminate shared services.",
    unavailableError: "computer_use_macos_only",
    appTargetSchema: { type: "string", minLength: 1, maxLength: 4096, description: "Unambiguous bundle ID, exact app name, or absolute .app bundle path. For duplicate bundle IDs use the exact observed .app path; never guess a different installation." },
    inspectInstallation: async () => Boolean(await findComputerUseInstallation(runtime)),
    createBroker: async (options) => {
      const installation = await findComputerUseInstallation(runtime);
      return installation ? new MacOSComputerUseBroker({ ...options, installation, runtime }) : null;
    },
    resolveTarget: async (target) => {
      let app = target;
      if (app.includes("/")) {
        if (!path.isAbsolute(app) || !app.endsWith(".app")) throw new ComputerUseInputError("computer_use_absolute_app_path_required", "Use an absolute .app bundle path.");
        try { app = await fs.realpath(app); if (!(await fs.stat(app as string)).isDirectory() || !(app as string).endsWith(".app")) throw new Error(); }
        catch { throw new ComputerUseInputError("computer_use_invalid_app_path", "Use an existing .app bundle directory."); }
      }
      return app;
    },
    preflight: assertMacInteractionReadiness,
    inspectWindows: inspectMacWindows,
    openApp: openMacApp,
    displayTarget: (app) => path.isAbsolute(app) ? path.basename(app, ".app") : app,
    captureTarget: (value) => value.captureWindow ?? null,
    verifyCaptureTarget: verifyMacWindowIdentity,
    appTargets,
    appCandidates,
    prepareAction: (action, input) => {
      if (action === "set_value" && input.value === "") throw new ComputerUseInputError("computer_use_empty_value_unsupported", "No action was sent. The native runtime rejects an empty set_value value. To clear, first verify and focus the intended editable field, then explicitly select its contents and delete; those are separate actions with fresh observations. Do not run select-all/delete on an unverified focus, and do not substitute spaces or the clipboard.");
      if (action === "type_text" && typeof input.text === "string" && /[\x00-\x1f\x7f-\x9f]/u.test(input.text)) {
        throw new ComputerUseInputError("computer_use_control_characters_require_explicit_action", "No input was sent. Native type_text can execute newline, carriage return or tab as keys, causing submission or focus changes. Use set_value for a complete multiline field value, computer_paste for authorized insertion at verified editable focus, or explicit press_key for an intended Return/Tab. Do not silently remove control characters or split and partially execute the input.");
      }
      if (action === "type_text" && typeof input.text === "string" && /[^\x20-\x7e]/u.test(input.text)) {
        throw new ComputerUseInputError("computer_use_unicode_input_requires_set_value", "The native type_text tool can silently drop Unicode (including Hangul). No input was sent. Use set_value with the editable element_index and the COMPLETE desired value for replacement, or explicitly use computer_paste for insertion at verified editable focus. Preserve existing text and verify the returned observation before sending/submitting. Do not retry Unicode with type_text.");
      }
      const args = { ...input };
      if (action === "press_key" && typeof args.key === "string") args.key = normalizeKey(args.key);
      return args;
    },
    actionSchemas,
    hasFullObservation: (value) => !value.isError && value.content.some((block) => {
      if (block.type !== "text" || typeof block.text !== "string") return false;
      const text = block.text.match(/<app_state>([\s\S]*?)<\/app_state>/)?.[1] ?? block.text;
      return /^App=[^\r\n]+\bpid \d+\)\r?\nWindow:[^\r\n]*\r?\n[\t ]*0\s+\S/.test(text.trim());
    }),
    // A mere success acknowledgement or screenshot is not an AX observation.
    // get_app_state wraps its tree; native actions return App/Window + indexed AX rows
    // without that envelope. Preserve either form without inventing element IDs.
    hasActionObservation: (value) => !value.isError && value.content.some((block) => {
      if (block.type !== "text" || typeof block.text !== "string") return false;
      return /<app_state>\s*\S[\s\S]*?<\/app_state>/.test(block.text)
        || /^App=[^\r\n]+\(pid \d+\)\r?\nWindow:[^\r\n]*\r?\n\s*\d+\s+\S/.test(block.text.trim());
    }),
    interactionHints: (value) => {
      const observationText = computerUseText(value);
      return /HTML 콘텐츠|AXWebArea|web area|HTML content/i.test(observationText) ? [
        ...(/증감자|spinbutton|stepper/i.test(observationText) ? ["For numeric text inputs (spinbutton/증감자), native set_value can clear the field without inserting the number. Prefer click to focus, select existing digits with super+a, then type_text with the desired ASCII number. Verify the value before saving; do not select-all until the intended field has focus."] : []),
        ...(/팝업 버튼|pop.?up button|combobox/i.test(observationText) ? ["Web select/dropdown behavior varies by popup state. Choose a current option by element_index when available. If its ID expires, read fresh state and use keyboard navigation on the focused control instead. Inspect selection after each Up/Down; at an endpoint the same key may do nothing. If keyboard selection does not change, use a freshly observed option rather than repeating keys. Confirm the chosen value in the closed control; neither click nor keyboard is universally reliable."] : []),
      ] : [];
    },
    classifyFailure: classifyNativeFailure,
    failureHint: nativeFailureHint,
  };
}
