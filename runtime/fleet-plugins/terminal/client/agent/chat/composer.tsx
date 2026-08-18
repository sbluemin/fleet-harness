import { React } from "@fleet-console/sdk/plugin/browser";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";
import {
  ComposerAttachControl,
  ComposerBar,
  ComposerField,
  ComposerInput,
  ComposerRestStrip,
  ComposerSubmitButton,
} from "@fleet-console/sdk/composer";

import { getT } from "../../i18n/index.js";
import { discardLaunchAttachment, messageAgentSession, uploadLaunchAttachment } from "../api.js";

/**
 * 채팅 패널에 귀속된 축약 컴포저 — sdk/composer 블록의 두 번째 조립(첫 번째는 Quick Launch).
 *
 * 상시 노출되지 않는다: 쉬는 한 줄(ComposerRestStrip)로 물러나 있다가 인터랙션에만 2-row로
 * 확장되고, 포커스를 잃으면 초안을 보존한 채 다시 물러난다 — 도킹 Quick Launch의 접힘 문법과
 * 같은 어휘다. War Room 카드뷰에서는 스트립조차 서지 않는다: chat.css의 `is-deck-tile` 숨김
 * 목록(부유 크롬과 같은 크로스 번들 클래스 계약)이 이 루트를 함께 걷는다.
 *
 * 행선지 문구는 없다 — 패널 안에 있다는 사실이 곧 행선지이고, placeholder의 세션 이름이
 * 그것을 말한다. 전송은 Quick Launch 멘션 전달과 같은 경로(`messageAgentSession`)라 서버
 * 계약 변경이 없다. 모델·강도의 선택 컨트롤은 세션 기본값 패치 경로가 실증된 뒤에 선다 —
 * 그전까지 이 바의 좌표 칩은 사실 표시이지 컨트롤이 아니다(agent-chat-coord와 같은 계약).
 */

interface ComposerDraftAttachment {
  readonly key: string;
  /** 업로드가 끝나야 도착하는 서버측 불투명 토큰 — 없는 동안은 발사할 수 없다. */
  readonly id: string | null;
  readonly name: string;
  readonly previewUrl: string;
  readonly uploading: boolean;
}

export function AgentChatComposer({
  context,
  coordinateChip,
  inviting,
  tourAnchor,
}: {
  readonly context: OperationRenderContext;
  /** 세션 좌표의 사실 표시 — 캡션에서 이 바로 옮겨 앉았다(사실이지 컨트롤이 아니다). */
  readonly coordinateChip: React.ReactNode;
  /** 첫 턴 전 초대 상태 — 쉬는 줄이 이 세션의 유일한 다음 행동임을 말한다. */
  readonly inviting: boolean;
  readonly tourAnchor: boolean;
}) {
  const t = getT(context.language ?? "en");
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);
  const stripRef = React.useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [attachments, setAttachments] = React.useState<readonly ComposerDraftAttachment[]>([]);
  const [sending, setSending] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const attachmentsRef = React.useRef(attachments);
  attachmentsRef.current = attachments;
  // 업로드가 끝나기 전에 칩이 제거된 key — 완료 콜백이 자신을 발견하면 방금 받은 id를 서버에서
  // 도로 거둔다(Quick Launch 첨부와 같은 회수 계약).
  const canceledKeysRef = React.useRef(new Set<string>());

  const expand = React.useCallback(() => {
    setOpen(true);
    // 접힌 동안 입력은 그려지지 않는다 — 펼침 커밋 뒤에 포커스를 넣는다.
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const collapse = React.useCallback(() => {
    // 초안·첨부는 패널 로컬로 산다 — 물러남은 버림이 아니다.
    setOpen(false);
  }, []);

  const send = React.useCallback(async () => {
    const text = draft.trim();
    if (text.length === 0 || sending) return;
    // id 없는 칩은 아직 서버에 없다 — 텍스트만 먼저 나가면 첨부가 조용히 빠진다.
    if (attachmentsRef.current.some((attachment) => attachment.uploading)) return;
    const ids = attachmentsRef.current
      .map((attachment) => attachment.id)
      .filter((id): id is string => id !== null);
    setSending(true);
    setFailed(false);
    try {
      await messageAgentSession(context.operationId, text, ids.length > 0 ? ids : undefined);
      for (const attachment of attachmentsRef.current) URL.revokeObjectURL(attachment.previewUrl);
      setAttachments([]);
      setDraft("");
      inputRef.current?.focus();
    } catch {
      // 실패는 초안을 지키고 이 바에서 말한다 — 문면이 사라진 채 침묵하면 회복 보장이 깨진다.
      setFailed(true);
    } finally {
      setSending(false);
    }
  }, [context.operationId, draft, sending]);

  const addFiles = React.useCallback((files: readonly File[]) => {
    for (const file of files) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const previewUrl = URL.createObjectURL(file);
      setAttachments((current) => [...current, { key, id: null, name: file.name, previewUrl, uploading: true }]);
      void uploadLaunchAttachment(file)
        .then(({ id }) => {
          if (canceledKeysRef.current.delete(key)) {
            // 업로드 중 제거된 칩 — 보이지 않는 파일이 미발사 슬롯을 차지하지 않게 거둔다.
            void discardLaunchAttachment(id).catch(() => {});
            return;
          }
          setAttachments((current) => current.map((attachment) => (
            attachment.key === key ? { ...attachment, id, uploading: false } : attachment
          )));
        })
        .catch(() => {
          canceledKeysRef.current.delete(key);
          URL.revokeObjectURL(previewUrl);
          setAttachments((current) => current.filter((attachment) => attachment.key !== key));
        });
    }
  }, []);

  const removeAttachment = React.useCallback((key: string) => {
    const target = attachmentsRef.current.find((attachment) => attachment.key === key);
    if (!target) return;
    if (target.id !== null) void discardLaunchAttachment(target.id).catch(() => {});
    else canceledKeysRef.current.add(key);
    URL.revokeObjectURL(target.previewUrl);
    setAttachments((current) => current.filter((attachment) => attachment.key !== key));
  }, []);

  const hasDraft = draft.trim().length > 0 || attachments.length > 0;
  const placeholder = t("terminal.chat.composerPlaceholder", { name: context.operation.title });
  const ghost = hasDraft && draft.trim().length > 0
    ? draft
    : inviting
      ? t("terminal.chat.emptyInvite")
      : placeholder;

  return (
    <div
      ref={rootRef}
      className={`agent-chat-composer${open ? " is-open" : ""}${inviting ? " is-inviting" : ""}`}
      // 시선이 떠나면 한 줄로 물러난다 — 팝오버 없는 축약 조립이라 포커스 이탈 판정이 곧 접힘이다.
      onBlur={(event) => {
        if (open && rootRef.current && !rootRef.current.contains(event.relatedTarget as Node | null)) collapse();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          collapse();
          // Esc는 키보드 후퇴다 — 포커스를 쉬는 줄로 되돌려 Tab 없이 다시 펼칠 수 있게 한다.
          // 포커스 이탈로 물러난 경우는 사용자가 이미 다른 곳을 골랐으므로 훔치지 않는다.
          window.setTimeout(() => stripRef.current?.focus(), 0);
        }
      }}
    >
      {open ? (
        <div className="agent-chat-composer-body">
          <div className="agent-chat-composer-frame">
            <ComposerField className="agent-chat-composer-field">
              <ComposerInput
                ref={inputRef}
                className="agent-chat-composer-input"
                rows={1}
                value={draft}
                placeholder={placeholder}
                aria-label={t("terminal.chat.composerInputAria")}
                spellCheck={false}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setFailed(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              {attachments.length > 0 ? (
                <div className="agent-chat-composer-attachments" role="group" aria-label={t("terminal.chat.composerAttach")}>
                  {attachments.map((attachment) => (
                    <span key={attachment.key} className={`agent-chat-composer-attachment${attachment.uploading ? " is-uploading" : ""}`}>
                      <img src={attachment.previewUrl} alt={attachment.name} />
                      <button
                        type="button"
                        className="agent-chat-composer-attachment-remove"
                        onClick={() => removeAttachment(attachment.key)}
                        aria-label={t("terminal.chat.composerAttachRemove", { name: attachment.name })}
                        title={t("terminal.chat.composerAttachRemove", { name: attachment.name })}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
            </ComposerField>
            <ComposerBar className="agent-chat-composer-bar">
              {coordinateChip}
              {failed ? (
                <span className="agent-chat-composer-error" role="alert">{t("terminal.chat.composerSendFailed")}</span>
              ) : null}
              <span className="agent-chat-composer-actions">
                <ComposerAttachControl
                  className="agent-chat-composer-attach"
                  label={t("terminal.chat.composerAttach")}
                  onFiles={addFiles}
                />
                <ComposerSubmitButton
                  className={`agent-chat-composer-send${hasDraft && !sending ? " is-armed" : ""}`}
                  disabled={!hasDraft || sending || attachments.some((attachment) => attachment.uploading)}
                  onClick={() => { void send(); }}
                  aria-label={t("terminal.chat.composerSend")}
                  title={t("terminal.chat.composerSend")}
                />
              </span>
            </ComposerBar>
          </div>
          <p className="agent-chat-composer-hint" aria-hidden="true">
            <span>{t("terminal.chat.composerHintEnter")}</span>
            <span>{t("terminal.chat.composerHintNewline")}</span>
            <span>{t("terminal.chat.composerHintEsc")}</span>
          </p>
        </div>
      ) : (
        <ComposerRestStrip
          ref={stripRef}
          className="agent-chat-composer-rest"
          {...(tourAnchor ? { "data-chat-tour": "composer" } : {})}
          aria-expanded={false}
          aria-label={t("terminal.chat.composerRestAria")}
          onClick={expand}
        >
          {hasDraft ? <span className="agent-chat-composer-draft-dot" aria-hidden="true" /> : null}
          <span className={`agent-chat-composer-ghost${hasDraft && draft.trim().length > 0 ? " has-draft" : ""}`}>{ghost}</span>
          <kbd className="agent-chat-composer-key" aria-hidden="true">Enter</kbd>
        </ComposerRestStrip>
      )}
    </div>
  );
}
