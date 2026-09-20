import { BrowserPolicyError, type BrowserService } from "./service.js";

/** 대상은 정확히 한 가지 방식으로 고른다. 범위도 유일해야 하며 첫 일치로 추측하지 않는다. */
export interface BrowserTarget { ref?: string; role?: string; name?: string; exact?: boolean; selector?: string; within?: Omit<BrowserTarget, "within"> }
export interface BrowserCondition { target?: BrowserTarget; state?: "visible" | "hidden" | "enabled" | "disabled" | "checked" | "unchecked"; attribute?: string; equals?: string; value?: string; url?: string }
export interface BrowserElementState { tag: string; type: string | null; editable: boolean; connected: boolean; visible: boolean; enabled: boolean; checked: boolean | null; value: string | null; text: string; attributes: Record<string, string | null> }

/** 조건 대기는 관측만 반복한다. 시간 초과나 후속 관측 실패 때문에 입력을 다시 보내지 않는다. */
export async function waitForBrowser(service: BrowserService, operationId: string, condition: BrowserCondition, tabId: string | null | undefined, signal: AbortSignal, timeoutMs = 5000) {
  if ((condition.attribute !== undefined) !== (condition.equals !== undefined) || condition.attribute === "") throw new BrowserPolicyError("browser_condition_invalid", "attribute and equals must be supplied together, with a non-empty attribute name.");
  const started = Date.now();
  const deadline = started + Math.min(30000, Math.max(0, timeoutMs));
  let last: unknown = null;
  do {
    if (signal.aborted) throw new Error("browser_call_interrupted");
    try {
      if (condition.url !== undefined) {
        if (condition.target || condition.state || condition.attribute || condition.value !== undefined) throw new BrowserPolicyError("browser_condition_invalid", "URL cannot be combined with an element condition.");
        const result = await service.evaluate<string>(operationId, "location.href", tabId);
        last = result.value;
        if (!result.error && result.value === condition.url) return { matched: true, elapsedMs: Date.now() - started, actual: last };
      } else {
        if (!condition.target) throw new BrowserPolicyError("browser_condition_invalid", "An element condition requires target.");
        const ref = await service.targetRef(operationId, condition.target, tabId);
        const state = await service.elementState(operationId, ref, condition.attribute ? [condition.attribute] : [], tabId);
        last = state;
        const expected = condition.state ?? (condition.attribute || condition.value !== undefined ? undefined : "visible");
        const stateMatches = expected === undefined || ({ visible: state.visible, hidden: !state.visible, enabled: state.enabled, disabled: !state.enabled, checked: state.checked === true, unchecked: state.checked === false })[expected];
        if (stateMatches && (condition.attribute === undefined || state.attributes[condition.attribute] === condition.equals) && (condition.value === undefined || state.value === condition.value)) return { matched: true, elapsedMs: Date.now() - started, actual: state };
      }
    } catch (error) {
      if (!(error instanceof BrowserPolicyError) || !["browser_target_missing", "browser_ref_unknown"].includes(error.code)) throw error;
      last = { error: error.code };
      if (condition.state === "hidden" && condition.attribute === undefined && condition.value === undefined) return { matched: true, elapsedMs: Date.now() - started, actual: last };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, Math.min(100, remaining));
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  } while (Date.now() <= deadline);
  if (signal.aborted) throw new Error("browser_call_interrupted");
  return { matched: false, elapsedMs: Date.now() - started, actual: last, reason: "timeout" };
}

export async function actOnBrowser(service: BrowserService, operationId: string, input: { action: string; target: BrowserTarget; value?: string | number | boolean; tabId?: string | null }, signal: AbortSignal) {
  const ref = await service.targetRef(operationId, input.target, input.tabId);
  if (signal.aborted) throw new Error("browser_call_interrupted");
  if (input.action === "click") return service.clickRef(operationId, ref, { signal }, input.tabId);
  const state = await service.elementState(operationId, ref, [], input.tabId);
  if (!state.connected) throw new BrowserPolicyError("browser_ref_unknown", "Element was detached; observe again.");
  if (!state.enabled) throw new BrowserPolicyError("browser_ref_disabled", "Element is disabled.");
  if (!state.visible) throw new BrowserPolicyError("browser_ref_not_visible", "Element is not visible.");
  if (input.action === "check" || input.action === "uncheck") {
    if (state.checked === null) throw new BrowserPolicyError("browser_control_invalid", "check/uncheck requires a checkbox or radio control.");
    const desired = input.action === "check";
    if (!desired && state.type === "radio" && state.checked) throw new BrowserPolicyError("browser_control_invalid", "A radio cannot be unchecked by clicking it; choose another option.");
    if (state.checked === desired) return { dispatched: false, unchanged: true, ref };
    return service.clickRef(operationId, ref, { signal }, input.tabId);
  }
  if (input.action !== "fill" && input.action !== "select") throw new BrowserPolicyError("browser_action_invalid", "Use click, fill, select, check or uncheck.");
  if (input.action === "select" && state.tag !== "select") throw new BrowserPolicyError("browser_control_invalid", "select requires a select element.");
  if (input.action === "fill" && !(state.editable || state.tag === "textarea" || (state.tag === "input" && !["checkbox", "radio", "file", "button", "submit", "reset", "image"].includes(state.type ?? "")))) throw new BrowserPolicyError("browser_control_invalid", "fill requires an editable text control.");
  if (input.value === undefined) throw new BrowserPolicyError("browser_value_required", "value is required.");
  if (signal.aborted) throw new Error("browser_call_interrupted");
  const result = await service.formInput(operationId, ref, input.value, input.tabId);
  if (!/^(set|selected )/.test(result)) throw new BrowserPolicyError("browser_control_invalid", result);
  return { dispatched: true, ref, method: "form_input", result };
}
