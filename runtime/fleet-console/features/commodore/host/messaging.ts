import { randomUUID } from "node:crypto";
import { MAX_TRANSCRIPT_TEXT } from "../shared/contracts/types.js";
import type { CommodoreStore } from "./store.js";

export interface CommodoreMessageInput {
  readonly to: string;
  readonly text: string;
  readonly replyTo?: string;
}

/** 사람 메시지 API와 분리된 사령관 연락. 출처는 호출 세션의 귀속으로 정하고, 받는 기록이 깨움의 원천이다. */
export function createCommodoreMessenger(deps: {
  readonly store: CommodoreStore;
  readonly acceptsMessage: (id: string) => boolean;
  readonly assertWritable: (id: string) => void;
}) {
  return (from: string, input: CommodoreMessageInput) => {
    deps.assertWritable(from);
    const sender = deps.store.read(from);
    if (!sender) throw new Error("unknown_commodore");
    if (!input.text.trim() || input.text.length > MAX_TRANSCRIPT_TEXT) throw new Error("invalid_request");
    const messageId = randomUUID();
    const recipient = deps.store.read(input.to);
    const to = { id: input.to, alias: recipient?.alias ?? "Commodore" };
    const body = { messageId, text: input.text, ...(input.replyTo ? { replyTo: input.replyTo } : {}) };
    let error: string | undefined;
    if (from === input.to) error = "self_target";
    else if (!recipient) error = "unknown_commodore";
    else {
      try { deps.assertWritable(input.to); }
      catch { error = "commodore_stopping"; }
      if (!error && !deps.acceptsMessage(input.to)) error = "commodore_unavailable";
    }
    if (error) {
      deps.store.transcriptAppend(from, { kind: "sent", ...body, to, ok: false, error });
      throw new Error(error);
    }
    // 수신 기록을 먼저 확정한다. 수신 append 실패를 성공 영수증이나 송신 성공 줄로 남기지 않는다.
    deps.store.transcriptAppend(input.to, { kind: "received", ...body, from: { id: from, alias: sender.alias ?? "Commodore" } });
    deps.store.transcriptAppend(from, { kind: "sent", ...body, to, ok: true });
    return { messageId, to: input.to, delivered: true };
  };
}
