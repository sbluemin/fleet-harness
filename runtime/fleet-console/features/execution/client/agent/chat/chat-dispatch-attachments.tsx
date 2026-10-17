import { React } from "@fleet-console/sdk/plugin/browser";
import { createPortal } from "react-dom";
import { agentChatAttachmentPreviewUrl } from "../api.js";
import { getT } from "../i18n/index.js";
import { useChatHost } from "./chat-host-context.js";
import type { AgentChatAttachment } from "./chat-events.js";

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
  const host = useChatHost();
  const resourceUrl = (path: string) => host ? host.resourceUrl(path) : path;
  const [opened, setOpened] = React.useState<string | null>(null);
  // 404는 "없는 첨부"가 아니라 "거둬진 첨부"다 — 같은 자리에 lapsed와 같은 말을 세운다.
  const [lapsed, setLapsed] = React.useState<readonly string[]>([]);
  const live = attachments.filter((attachment): attachment is { readonly id: string } => (
    "id" in attachment && !lapsed.includes(attachment.id)
  ));
  const references = attachments.filter((attachment) => "reference" in attachment);
  const lapsedCount = attachments.length - live.length - references.length;
  return (
    <div className="agent-chat-dispatch-attachments">
      {live.map((attachment, index) => (
        <button
          key={attachment.id}
          type="button"
          className="agent-chat-dispatch-attachment"
          aria-label={t("terminal.chat.attachmentOpen", { index: String(index + 1) })}
          title={t("terminal.chat.attachmentOpen", { index: String(index + 1) })}
          onClick={() => setOpened(attachment.id)}
        >
          <img
            src={resourceUrl(agentChatAttachmentPreviewUrl(attachment.id))}
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
      {opened !== null ? (
        <ChatAttachmentViewer
          id={opened}
          index={live.findIndex((attachment) => attachment.id === opened) + 1}
          language={language}
          onClose={() => setOpened(null)}
          onLapsed={() => {
            setLapsed((current) => (current.includes(opened) ? current : [...current, opened]));
            setOpened(null);
          }}
        />
      ) : null}
    </div>
  );
}

/** 첨부 한 장을 크게 본다. 부유 모달의 공용 문법(스크림·Esc·바깥 클릭)을 그대로 쓴다. */
function ChatAttachmentViewer({
  id,
  index,
  language,
  onClose,
  onLapsed,
}: {
  readonly id: string;
  readonly index: number;
  readonly language: "en" | "ko";
  readonly onClose: () => void;
  readonly onLapsed: () => void;
}) {
  const t = getT(language);
  const host = useChatHost();
  const resourceUrl = (path: string) => host ? host.resourceUrl(path) : path;
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  // 포커스는 열릴 때 닫기로 가고 닫히면 부른 자리로 돌아간다 — 키보드 사용자가 원장의 제자리를
  // 잃지 않게 하는 최소 계약이다.
  React.useEffect(() => {
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => returnTo?.focus();
  }, []);
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 같은 키가 패널의 다른 닫힘(작업 시트)까지 함께 닫지 않게 여기서 멈춘다.
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);
  return createPortal(
    <div className="agent-chat-attachment-scrim" role="dialog" aria-modal="true" aria-label={t("terminal.chat.attachmentAlt", { index: String(index) })} onMouseDown={onClose}>
      <div className="agent-chat-attachment-frame" onMouseDown={(event) => event.stopPropagation()}>
        <button ref={closeRef} type="button" className="agent-chat-attachment-close" onClick={onClose} aria-label={t("terminal.chat.attachmentClose")}>✕</button>
        <img src={resourceUrl(agentChatAttachmentPreviewUrl(id))} alt={t("terminal.chat.attachmentAlt", { index: String(index) })} onError={onLapsed} />
      </div>
    </div>,
    document.body,
  );
}
