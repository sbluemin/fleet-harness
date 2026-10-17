import { useState } from "react";
import type { HostSurfaceContext } from "../host-context/types.js";
import { ComposerInput } from "./input.js";
import { ComposerBar, ComposerField, ComposerSubmitButton } from "./primitives.js";

/** 대화 renderer가 받는 제어형 입력. 초안은 마운트 해제가 아니라 host 소유 state의 수명을 따른다. */
export function HostMessageComposer({ context, send, label, placeholder, sendLabel, readOnlyLabel, uploadUnsupported }: {
  readonly context: HostSurfaceContext;
  readonly send: (text: string) => Promise<void>;
  readonly label: string;
  readonly placeholder: string;
  readonly sendLabel: string;
  readonly readOnlyLabel: string;
  readonly uploadUnsupported: string;
}) {
  const key = `draft:${context.selection.theaterId}:${context.selection.role}:${context.selection.operationId ?? ""}`;
  const [text, setText] = useState(() => context.state.read(key, ""));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = () => !context.transport.scope.signal.aborted;
  const writable = context.canWrite() && current();
  const change = (value: string) => {
    if (!current()) return;
    context.state.write(key, value);
    setText(value);
  };
  const submit = async () => {
    if (sending || !current() || !context.canWrite() || !text.trim()) return;
    const sent = text;
    setSending(true); setError(null);
    try {
      await send(sent.trim());
      if (!current()) return;
      if (context.state.read(key, "") === sent) change("");
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : "message_failed");
    } finally { if (current()) setSending(false); }
  };
  return <div className="agent-chat-composer">
    <ComposerField>
      <ComposerInput aria-label={label} placeholder={placeholder} value={text} disabled={!writable} onChange={(event) => change(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
      <ComposerBar><ComposerSubmitButton aria-label={sendLabel} disabled={!writable || sending || !text.trim()} onClick={() => { void submit(); }}>{sendLabel}</ComposerSubmitButton></ComposerBar>
    </ComposerField>
    {!writable ? <p role="status">{readOnlyLabel}</p> : null}
    <small>{uploadUnsupported}</small>
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
