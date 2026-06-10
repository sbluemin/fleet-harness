import { truncateToWidth } from "../../controls/index.js";
import { MISSION_CONTROL_THEME } from "../theme.js";
import { centerText } from "../welcome.js";
import { isEnter, isEscape, isPrintable, type MenuPanel } from "./panel-stack.js";

export type InputModalMode = "text" | "password" | "numeric";

export interface InputModalOptions {
  readonly title: string;
  readonly message: string;
  readonly mode: InputModalMode;
  readonly initialValue?: string;
  readonly onRenderRequest?: () => void;
  readonly placeholder?: string;
  readonly validate?: (value: string) => string | undefined;
  readonly onCancel: () => void;
  readonly onSubmit: (value: string) => void | Promise<void>;
}

export function createInputModal(options: InputModalOptions): MenuPanel {
  let value = options.initialValue ?? "";
  let error: string | undefined;
  let submitting = false;

  return {
    id: `input:${options.title}`,
    title: options.title,
    handleInput(data: string): boolean {
      if (submitting) {
        return true;
      }
      if (isEscape(data)) {
        options.onCancel();
        return true;
      }
      if (isEnter(data)) {
        void submit(value);
        return true;
      }
      if (data === "\x7f" || data === "\b") {
        value = value.slice(0, -1);
        error = undefined;
        return true;
      }
      if (isPrintable(data)) {
        if (options.mode === "numeric" && !/^[0-9]+$/.test(data)) {
          return true;
        }
        value = `${value}${data}`;
        error = undefined;
        return true;
      }
      return true;
    },
    render({ width }): readonly string[] {
      const display = renderValue(options.mode, value, options.placeholder);
      const lines = [
        "",
        centerText(MISSION_CONTROL_THEME.accent(options.title), width),
        "",
        centerText(truncateToWidth(options.message, Math.max(0, width)), width),
        "",
      ];
      lines.push(centerText(display, width));
      if (error !== undefined) {
        lines.push("", centerText(MISSION_CONTROL_THEME.error(error), width));
      }
      lines.push("", centerText(MISSION_CONTROL_THEME.dim("Enter submit  Backspace delete  Esc cancel"), width));
      if (submitting) {
        lines.push("", centerText(MISSION_CONTROL_THEME.dim("Working..."), width));
      }
      return lines;
    },
  };

  async function submit(nextValue: string): Promise<void> {
    const validation = options.validate?.(nextValue);
    if (validation !== undefined) {
      error = validation;
      options.onRenderRequest?.();
      return;
    }
    submitting = true;
    options.onRenderRequest?.();
    try {
      await options.onSubmit(nextValue);
    } catch (submitError: unknown) {
      error = submitError instanceof Error && submitError.message.length > 0 ? submitError.message : "Action failed.";
    } finally {
      submitting = false;
      options.onRenderRequest?.();
    }
  }
}

function renderValue(mode: InputModalMode, value: string, placeholder: string | undefined): string {
  if (mode === "password") {
    return value.length > 0 ? `${"*".repeat(value.length)}|` : `${placeholder ?? "API key"}|`;
  }
  return `${value.length > 0 ? value : placeholder ?? ""}|`;
}
