import { ComposerAttachmentViewer } from "../../composer-primitives/attachment-surface.js";
import { ComposerQuoteList } from "../../composer-primitives/quote-tray.js";
import { composerT } from "../../composer-primitives/messages.js";
import * as React from "react";
import { agentChatAttachmentPreviewUrl } from "../api.js";
import { getT } from "../i18n/index.js";
import type { AgentChatAttachment } from "./chat-events.js";

/** 미리보기가 열 수 있는 같은 출처 API — 목표와 사령관 feature의 첨부 경로뿐이다. */
const PREVIEW_PREFIXES = ["/api/v1/objectives/attachment/file?", "/api/v1/commodore/attachment?"] as const;

/**
 * 보낸 이미지 — 말풍선 머리에 컴포저 칩과 같은 문법으로 선다.
 *
 * 브라우저가 쥔 것은 미리보기 좌표뿐이고 호스트 경로는 서버에 남는다. 바이트가 이미 회수됐으면
 * (세션이 닫혔거나 지난 프로세스의 재생이면) 자리만 남긴다 — 첨부가 있었다는 사실은 깨진 이미지
 * 아이콘이 아니라 말로 말한다.
 */
export function ChatDispatchAttachments({
  attachments,
  language,
}: {
  readonly attachments: readonly AgentChatAttachment[];
  readonly language: "en" | "ko";
}) {
  const t = getT(language);
  const ct = composerT(language);
  const [opened, setOpened] = React.useState<number | null>(null);
  const originRef = React.useRef<HTMLButtonElement | null>(null);
  // 404는 "없는 첨부"가 아니라 "거둬진 첨부"다 — 같은 자리에 lapsed와 같은 말을 세운다.
  const [lapsed, setLapsed] = React.useState<readonly string[]>([]);
  const live = attachments.flatMap((attachment) => {
    const image = "id" in attachment ? { id: attachment.id, src: agentChatAttachmentPreviewUrl(attachment.id) }
      : "preview" in attachment && PREVIEW_PREFIXES.some((prefix) => attachment.preview.url.startsWith(prefix)) && !attachment.preview.url.includes("\\")
        ? { id: attachment.preview.id, src: attachment.preview.url } : null;
    return image && !lapsed.includes(image.id) ? [image] : [];
  });
  const references = attachments.filter((attachment) => "reference" in attachment);
  // 인용은 바이트가 없는 글 첨부라 거둬질 일이 없다 — 입력창 칩과 같은 칩으로 선다.
  const quotes = attachments.flatMap((attachment) => ("quote" in attachment ? [attachment.quote] : []));
  const lapsedCount = attachments.length - live.length - references.length - quotes.length;
  return (
    <div className="agent-chat-dispatch-attachments">
      <ComposerQuoteList quotes={quotes} t={ct} />
      {live.map((attachment, index) => (
        <button
          key={attachment.id}
          type="button"
          className="agent-chat-dispatch-attachment"
          aria-label={t("terminal.chat.attachmentOpen", { index: String(index + 1) })}
          title={t("terminal.chat.attachmentOpen", { index: String(index + 1) })}
          onClick={(event) => { originRef.current = event.currentTarget; setOpened(index); }}
        >
          <img
            src={attachment.src}
            alt={t("terminal.chat.attachmentAlt", { index: String(index + 1) })}
            onError={() => setLapsed((current) => (current.includes(attachment.id) ? current : [...current, attachment.id]))}
          />
        </button>
      ))}
      {references.length > 0 ? <span className="agent-chat-dispatch-attachment-lapsed" title={t("terminal.chat.attachmentReferenceHint")}>
        <span className="agent-chat-dispatch-attachment-lapsed-box" aria-hidden="true" />
        {t("terminal.chat.attachmentReference", { count: String(references.length) })}
      </span> : null}
      {lapsedCount > 0 ? (
        <span className="agent-chat-dispatch-attachment-lapsed">
          <span className="agent-chat-dispatch-attachment-lapsed-box" aria-hidden="true" />
          {t("terminal.chat.attachmentLapsed", { count: String(lapsedCount) })}
        </span>
      ) : null}
      {opened !== null && live[opened] ? (
        <ComposerAttachmentViewer
          images={live.map((attachment, index) => ({
            key: attachment.id,
            src: attachment.src,
            name: t("terminal.chat.attachmentAlt", { index: String(index + 1) }),
          }))}
          index={opened}
          returnFocusRef={originRef}
          onIndex={setOpened}
          onClose={() => setOpened(null)}
          closeLabel={ct("composer.attach.close")}
          previousLabel={ct("composer.attach.previous")}
          nextLabel={ct("composer.attach.next")}
          onImageError={(key) => {
            setLapsed((current) => (current.includes(key) ? current : [...current, key]));
            setOpened(null);
          }}
        />
      ) : null}
    </div>
  );
}
