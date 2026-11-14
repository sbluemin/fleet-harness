import { randomUUID } from "node:crypto";
import { MAX_TRANSCRIPT_TEXT } from "../shared/contracts/types.js";
import { MAX_COMMODORE_MESSAGE_IMAGE_BYTES, MAX_COMMODORE_MESSAGE_IMAGES } from "../shared/contracts/attachment-budget.js";
import type { AttachmentHost } from "../../execution/shared/agent.js";
import type { CommodoreStore } from "./store.js";

type SendableImage = ReturnType<AttachmentHost["read"]>[number];

export interface CommodoreMessageInput {
  readonly to: string;
  readonly text: string;
  readonly replyTo?: string;
  readonly attachmentIds?: readonly string[];
}

export interface CommodoreMessageTurn {
  readonly readAttachments: (ids: readonly string[]) => readonly SendableImage[];
  readonly readBriefImages: (ids: readonly string[]) => readonly SendableImage[];
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 사람 메시지 API와 분리된 사령관 연락. 출처는 호출 세션의 귀속으로 정하고, 받는 기록이 깨움의 원천이다. */
export function createCommodoreMessenger(deps: {
  readonly store: CommodoreStore;
  readonly acceptsMessage: (id: string) => boolean;
  readonly assertWritable: (id: string) => void;
}) {
  return (from: string, input: CommodoreMessageInput, turn?: CommodoreMessageTurn) => {
    deps.assertWritable(from);
    const sender = deps.store.read(from);
    if (!sender) throw new Error("unknown_commodore");
    if (!input.text.trim() || input.text.length > MAX_TRANSCRIPT_TEXT) throw new Error("invalid_request");
    const attachmentIds = input.attachmentIds ?? [];
    if (attachmentIds.length > MAX_COMMODORE_MESSAGE_IMAGES) throw new Error("attachment_limit");
    if (new Set(attachmentIds).size !== attachmentIds.length) throw new Error("duplicate_attachment");
    if (attachmentIds.some((id) => !ID.test(id))) throw new Error("attachment_not_available");
    const messageId = randomUUID();
    const recipient = deps.store.read(input.to);
    const to = { id: input.to, alias: recipient?.alias ?? "Commodore" };
    const requestedAttachments = attachmentIds.length ? attachmentIds.map((id) => ({ id })) : undefined;
    const fail = (code: string): never => {
      deps.store.transcriptAppend(from, { kind: "sent", messageId, text: input.text, ...(input.replyTo ? { replyTo: input.replyTo } : {}), ...(requestedAttachments ? { attachments: requestedAttachments } : {}), to, ok: false, error: code });
      throw new Error(code);
    };
    // 자기 목표 이미지·이번 턴 첨부·이 사령관이 사람에게 받은 이전 턴 첨부만 보낼 수 있다. 남의 사령관 첨부·TaskForce·남의 목표·임의 경로는 거부한다.
    let images: readonly SendableImage[] = [];
    if (attachmentIds.length) {
      if (!turn) fail("attachment_not_available");
      try {
        images = resolveSendableImages(turn!, attachmentIds);
      } catch (error) {
        const code = error instanceof Error && /^[a-z_]{1,64}$/.test(error.message) ? error.message : "attachment_not_available";
        fail(code);
      }
      if (images.length !== attachmentIds.length || images.some((image, index) => image.id !== attachmentIds[index])) fail("attachment_not_available");
      if (images.reduce((sum, image) => sum + image.bytes.byteLength, 0) > MAX_COMMODORE_MESSAGE_IMAGE_BYTES) fail("attachment_budget_exceeded");
    }
    const attachments = attachmentIds.length ? attachmentIds.map((id) => ({ id })) : undefined;
    const imageBytes = images.length ? images.reduce((sum, image) => sum + image.bytes.byteLength, 0) : undefined;
    const body = { messageId, text: input.text, ...(input.replyTo ? { replyTo: input.replyTo } : {}), ...(attachments ? { attachments } : {}), ...(imageBytes !== undefined ? { imageBytes } : {}) };
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
    // 수신자별 전달 대기 총량 — 보관 상한을 넘으면 이미지 저장·수신 기록 전에 거절한다(고아·성공 기록 없음).
    if (images.length && imageBytes !== undefined && !deps.store.images.admit(input.to, imageBytes)) {
      deps.store.transcriptAppend(from, { kind: "sent", ...body, to, ok: false, error: "attachment_budget_exceeded" });
      throw new Error("attachment_budget_exceeded");
    }
    // 사본을 먼저 저장한다. 대상 검증 뒤이므로 실패한 송신이 고아를 남기지 않게, 기록 실패 때는 거둔다.
    let saved = false;
    if (images.length) {
      saved = deps.store.images.save(input.to, messageId, images);
      if (!saved) {
        deps.store.transcriptAppend(from, { kind: "sent", ...body, to, ok: false, error: "attachment_not_available" });
        throw new Error("attachment_not_available");
      }
    }
    try {
      // 수신 기록을 먼저 확정한다. 수신 append 실패를 성공 영수증이나 송신 성공 줄로 남기지 않는다.
      deps.store.transcriptAppend(input.to, { kind: "received", ...body, from: { id: from, alias: sender.alias ?? "Commodore" } });
    } catch (error) {
      if (saved) { try { deps.store.images.remove(input.to, messageId); } catch { /* 다음 정리 때 다시 거둔다. */ } }
      throw error;
    }
    deps.store.transcriptAppend(from, { kind: "sent", ...body, to, ok: true });
    return { messageId, to: input.to, delivered: true };
  };
}

/** 이번 턴 첨부를 먼저, 자기 목표 이미지를 다음에 — 한 ID는 한 곳에서만 찾는다. */
function resolveSendableImages(turn: CommodoreMessageTurn, ids: readonly string[]): readonly SendableImage[] {
  const found: SendableImage[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    try {
      const [image] = turn.readAttachments([id]);
      if (image && image.id === id) { found.push(image); continue; }
    } catch { /* 이번 턴 첨부가 아니면 목표로 넘어간다. */ }
    missing.push(id);
  }
  if (!missing.length) return found;
  const brief = turn.readBriefImages(missing);
  const byId = new Map(found.map((image) => [image.id, image]));
  for (const image of brief) byId.set(image.id, image);
  return ids.map((id) => {
    const image = byId.get(id);
    if (!image) throw new Error("attachment_not_available");
    return image;
  });
}
