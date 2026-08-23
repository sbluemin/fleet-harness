import { React } from "@fleet-console/sdk/plugin/browser";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";
import {
  COMPOSER_ATTACHMENT_MAX_BYTES,
  COMPOSER_MAX_ATTACHMENTS,
  ComposerAttachControl,
  ComposerBar,
  ComposerField,
  ComposerInput,
  ComposerSubmitButton,
  isComposerAttachmentCandidate,
  isUltracodeDisarmCaret,
  nextUltracodeIgnored,
  readUltracodeTokens,
  renderUltracodeHighlight,
  syncComposerHighlight,
} from "@fleet-console/sdk/composer";

import { getT } from "../../i18n/index.js";
import { discardLaunchAttachment, messageAgentSession, uploadLaunchAttachment } from "../api.js";

/**
 * 채팅 패널에 귀속된 축약 컴포저 — sdk/composer 블록의 두 번째 조립(첫 번째는 Quick Launch).
 *
 * 언제나 서 있다: 접힘도, 되돌아오는 한 줄도 없다. 읽던 자리에서 바로 쓰는 것이 이 패널의
 * 기본 동작이고, 매 턴 앞에 붙던 "펼치는 클릭" 하나가 그 기본을 가리고 있었다. 대신 크롬을
 * 줄여 자리값을 치른다 — 안내는 컨트롤 행이 지고(포커스에만 선다), 프레임 밖 셋째 줄은 없다.
 *
 * 면을 두르지 않는다. 밴드(구분선 + 한 단 올라간 배경)를 두면 패널 안에 또 하나의 패널이
 * 생겨, 첫 턴 전 가운데에 선 컴포저와 첫 턴 뒤 아래로 내려앉은 컴포저가 서로 다른 물건으로
 * 읽힌다. 남는 것은 둥근 프레임 하나이고, 자리는 여전히 in-flow다 — 대화의 마지막 줄을
 * 덮는 부유물이 되지 않는다(중앙 배치와 이동은 chat-view의 꼬리가 소유한다).
 *
 * War Room 카드뷰에서는 서지 않는다: chat.css의 `is-deck-tile` 숨김 목록(부유 크롬과 같은
 * 크로스 번들 클래스 계약)이 이 루트를 함께 걷는다.
 *
 * 실행 중에는 두 문이 선다: 현재 턴을 끊는 text control과 그 뒤에 실행할 지시를 예약하는 원형
 * 전송 control이다. 한 버튼의 뜻을 Stop으로 바꾸면서 Enter는 Queue로 남기면 같은 입력이 포인터와
 * 키보드에서 다른 약속을 하므로, 둘을 화면에서도 분리하고 접수된 예약 수를 지운 초안 자리에 남긴다.
 *
 * 전송은 Quick Launch 멘션 전달과 같은 경로(`messageAgentSession`)라 서버 계약 변경이 없다.
 * 모델·강도는 컨트롤이 아니라 사실 표시다 — 좌표를 바꾸는 길은 새 세션을 여는 것뿐이라
 * 이 바에 선 칩과 계기는 읽히기만 한다.
 */

interface ComposerDraftAttachment {
  readonly key: string;
  /** 업로드가 끝나야 도착하는 서버측 불투명 토큰 — 없는 동안은 발사할 수 없다. */
  readonly id: string | null;
  readonly name: string;
  readonly previewUrl: string;
  readonly uploading: boolean;
}

/** 거절 사유는 문구 키와 인자를 함께 들고 다닌다 — 바에 서는 한 줄이 사유를 말해야 한다. */
type AttachmentRejection =
  | { readonly kind: "limit" }
  | { readonly kind: "tooLarge" }
  | { readonly kind: "failed" };

export function AgentChatComposer({
  context,
  coordinate,
  meter,
  tourAnchor,
  turnRunning,
  stopping,
  queuedTurns,
  work,
  onStop,
  onQueued,
  onQueueRejected,
}: {
  readonly context: OperationRenderContext;
  /** 세션 좌표의 사실 표시 — 모델·강도 배지가 컨트롤 행 좌측에 앉는다. */
  readonly coordinate: React.ReactNode;
  /**
   * 문맥 미터 — 읽는 계기이지 컨트롤이 아니다. 발사 버튼 바로 왼쪽에 앉아, 보내기 직전에
   * "이 창에 얼마나 남았는가"가 손이 가는 자리에서 읽힌다.
   */
  readonly meter: React.ReactNode;
  readonly tourAnchor: boolean;
  /** 지금 이 세션의 턴이 도는가 — 중지와 다음 지시 예약을 함께 세우는 축이다. */
  readonly turnRunning: boolean;
  readonly stopping: boolean;
  /** 서버가 접수해 현재 턴 뒤에 실행할 지시 수 — 접수 뒤 초안이 사라져도 예약 사실을 지킨다. */
  readonly queuedTurns: number;
  /**
   * 백그라운드 작업 표시 — attach 왼쪽에 선 글리프의 상태·문이다. 잡이 있는 동안에만 서고
   * (`hasJobs`), 도는 잡이 있으면(`running > 0`) aurora 오브, 정착만 남으면 중립 링이다.
   * 작업 면이 열리면(`open`) 면의 머리가 같은 내용을 지므로 이 글리프는 물러난다.
   */
  readonly work: {
    readonly running: number;
    readonly hasJobs: boolean;
    readonly open: boolean;
    readonly controlsId: string;
    readonly onOpen: () => void;
  };
  readonly onStop: () => Promise<boolean>;
  readonly onQueued: () => void;
  readonly onQueueRejected: () => void;
}) {
  const t = getT(context.language ?? "en");
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = React.useState("");
  const [attachments, setAttachments] = React.useState<readonly ComposerDraftAttachment[]>([]);
  const [sending, setSending] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [rejection, setRejection] = React.useState<AttachmentRejection | null>(null);
  const [dragOver, setDragOver] = React.useState(false);
  const attachmentsRef = React.useRef(attachments);
  attachmentsRef.current = attachments;
  // `ultracode` 무장 — Quick Launch와 같은 부품(sdk/composer)이 인식·미러 문법을 소유하고,
  // 상태(해제)와 표식만 이 조립이 진다. 무장은 초안에서 파생하고, 남는 것은 "이 초안에서 껐다"뿐이다.
  const highlightRef = React.useRef<HTMLDivElement | null>(null);
  const [ultracodeIgnored, setUltracodeIgnored] = React.useState(false);
  const ultracodeTokens = React.useMemo(() => readUltracodeTokens(draft), [draft]);
  const ultracodeArmed = ultracodeTokens.length > 0 && !ultracodeIgnored;
  // 해제는 단어가 문면에서 전부 사라질 때 만료한다 — 프로그램 쓰기(전송 후 초기화)도 같은 경로를
  // 지나야 하므로 입력 핸들러가 아니라 문면 자체에 붙인다.
  React.useEffect(() => {
    setUltracodeIgnored((ignored) => nextUltracodeIgnored(draft, ignored));
  }, [draft]);
  const syncUltracodeHighlight = React.useCallback(() => {
    syncComposerHighlight(inputRef.current, highlightRef.current);
  }, []);
  // 문면·자동 높이가 바뀐 프레임에서 바로 맞춘다(그려진 뒤 맞추면 한 프레임 어긋난 채 보인다).
  React.useLayoutEffect(() => {
    syncUltracodeHighlight();
  }, [draft, syncUltracodeHighlight, ultracodeArmed]);
  // 프레임 폭은 첨부 트레이·패널 리사이즈로도 바뀐다 — textarea 자신을 관찰하는 것이 유일하게
  // 빠짐없는 기준이다.
  React.useEffect(() => {
    const input = inputRef.current;
    if (!ultracodeArmed || !input || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => syncUltracodeHighlight());
    observer.observe(input);
    return () => observer.disconnect();
  }, [syncUltracodeHighlight, ultracodeArmed]);
  // 업로드가 끝나기 전에 칩이 제거된 key — 완료 콜백이 자신을 발견하면 방금 받은 id를 서버에서
  // 도로 거둔다(Quick Launch 첨부와 같은 회수 계약).
  const canceledKeysRef = React.useRef(new Set<string>());

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
    // 큐 receipt는 요청보다 먼저 세운다. 서버는 요청 안에서 턴을 등록하고 WebSocket으로 먼저
    // 알릴 수 있으므로, 응답 뒤에 세우면 이미 시작한 턴이 내린 수를 다시 올려 stale로 남긴다.
    if (turnRunning) onQueued();
    try {
      await messageAgentSession(context.operationId, text, ids.length > 0 ? ids : undefined);
      for (const attachment of attachmentsRef.current) URL.revokeObjectURL(attachment.previewUrl);
      setAttachments([]);
      setDraft("");
      inputRef.current?.focus();
    } catch {
      if (turnRunning) onQueueRejected();
      // 실패는 초안을 지키고 이 바에서 말한다 — 문면이 사라진 채 침묵하면 회복 보장이 깨진다.
      setFailed(true);
    } finally {
      setSending(false);
    }
  }, [context.operationId, draft, onQueued, onQueueRejected, sending, turnRunning]);

  const addFiles = React.useCallback((files: readonly File[]) => {
    const images = files.filter((file) => isComposerAttachmentCandidate(file));
    // 이미지가 하나도 없으면 어떤 사유도 말하지 않는다 — 텍스트 붙여넣기·비이미지 드롭은 조용히 지나간다.
    if (images.length === 0) return;
    setRejection(null);
    // 상태 갱신은 배치되므로 상한은 로컬 카운터로 센다 — ref만 보면 같은 드롭의 앞 장이 안 보인다.
    let count = attachmentsRef.current.length;
    for (const file of images) {
      if (count >= COMPOSER_MAX_ATTACHMENTS) {
        setRejection({ kind: "limit" });
        break;
      }
      if (file.size > COMPOSER_ATTACHMENT_MAX_BYTES) {
        setRejection({ kind: "tooLarge" });
        continue;
      }
      count += 1;
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const previewUrl = URL.createObjectURL(file);
      const name = file.name.length > 0 ? file.name : "pasted image";
      setAttachments((current) => [...current, { key, id: null, name, previewUrl, uploading: true }]);
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
          setRejection({ kind: "failed" });
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
    setRejection(null);
  }, []);

  const stop = React.useCallback(async () => {
    // ACK를 받은 중지만 focus를 돌려준다. 정상 완료는 작업 면이나 separator에서 사용자가 두고
    // 있던 초점을 빼앗지 않고, 실패는 false라 이 줄에서 멈춘다.
    if (await onStop()) inputRef.current?.focus();
  }, [onStop]);

  // 발사 조건은 전송 경로와 같아야 한다 — 첨부만으로는 나가지 않으므로(서버가 받는 것은 문면과
  // 그에 딸린 첨부다) 첨부 하나로 버튼이 켜지면 눌러도 아무 일이 없는 죽은 컨트롤이 된다.
  const uploading = attachments.some((attachment) => attachment.uploading);
  const canSend = draft.trim().length > 0 && !sending && !uploading;
  const placeholder = t("terminal.chat.composerPlaceholder", { name: context.operation.title });
  const notice = failed
    ? t("terminal.chat.composerSendFailed")
    : rejection === null
      ? null
      : rejection.kind === "limit"
        ? t("terminal.chat.composerAttachLimit", { count: String(COMPOSER_MAX_ATTACHMENTS) })
        : rejection.kind === "tooLarge"
          ? t("terminal.chat.composerAttachTooLarge", { mb: String(Math.round(COMPOSER_ATTACHMENT_MAX_BYTES / (1024 * 1024))) })
          : t("terminal.chat.composerAttachFailed");

  return (
    <div className="agent-chat-composer">
      <div
        className={`agent-chat-composer-frame${dragOver ? " is-drag-over" : ""}${ultracodeArmed ? " is-ultracode" : ""}`}
        {...(tourAnchor ? { "data-chat-tour": "composer" } : {})}
        onDragOver={(event) => {
          if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(event) => {
          // 자식 사이를 오가는 이동은 이탈이 아니다 — 프레임 밖으로 나갈 때만 하이라이트를 내린다.
          const next = event.relatedTarget;
          if (next instanceof Node && event.currentTarget.contains(next)) return;
          setDragOver(false);
        }}
        onDrop={(event) => {
          setDragOver(false);
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (files.length === 0) return;
          // 파일이 실린 드롭은 이미지가 아니어도 기본 동작을 막는다 — 막지 않으면 브라우저가
          // 그 파일로 내비게이션해 콘솔째로 떠난다.
          event.preventDefault();
          addFiles(files);
        }}
      >
        {/* 무장 고지 — field 위 자기 줄에 상주한다(바 슬롯은 전송 실패 alert가 쓴다). */}
        {ultracodeArmed ? (
          <p className="agent-chat-composer-ultracode-notice" role="status">
            <span className="agent-chat-composer-ultracode-glyph" aria-hidden="true">✦</span>
            <span>{t("terminal.chat.composerUltracodeNotice")}</span>
            <span className="agent-chat-composer-ultracode-hint">{t("terminal.chat.composerUltracodeHint")}</span>
          </p>
        ) : null}
        <ComposerField className="agent-chat-composer-field">
          {/* textarea와 미러를 한 flex 아이템으로 묶는다 — 미러를 field에 직접 붙이면 첨부 칩이 선
              줄에서 시작점이 어긋난다. 묶으면 정렬 기준이 textarea의 박스 하나로 줄어든다. */}
          <span className="agent-chat-composer-input-wrap">
            {ultracodeArmed ? (
              <div className="agent-chat-composer-highlight" ref={highlightRef} aria-hidden="true">
                {renderUltracodeHighlight(draft, ultracodeTokens, "agent-chat-composer-ultracode-token")}
              </div>
            ) : null}
            <ComposerInput
              ref={inputRef}
              className="agent-chat-composer-input"
              rows={3}
              value={draft}
              placeholder={placeholder}
              aria-label={t("terminal.chat.composerInputAria")}
              spellCheck={false}
              onChange={(event) => {
                setDraft(event.target.value);
                setFailed(false);
              }}
              onScroll={syncUltracodeHighlight}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData?.files ?? []).filter((file) => isComposerAttachmentCandidate(file));
                if (files.length === 0) return;
                // 이미지가 실린 붙여넣기만 가로챈다 — 텍스트 붙여넣기는 브라우저 기본 동작 그대로 흐른다.
                event.preventDefault();
                addFiles(files);
              }}
              onKeyDown={(event) => {
                // caret이 인식된 `ultracode` 바로 뒤일 때의 수식 없는 Backspace 한 번은 글자가 아니라
                // 무장을 지운다 — 다음 Backspace는 평소대로 지운다. 키 반복·수식 붙은 삭제는 손대지 않는다.
                if (event.key === "Backspace" && !event.repeat && ultracodeArmed
                  && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
                  && isUltracodeDisarmCaret(draft, event.currentTarget.selectionStart, event.currentTarget.selectionEnd)) {
                  event.preventDefault();
                  setUltracodeIgnored(true);
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
          </span>
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
          {coordinate}
          {notice !== null ? (
            <span className="agent-chat-composer-error" role="alert">{notice}</span>
          ) : queuedTurns > 0 ? (
            <span className="agent-chat-composer-queued" role="status">
              {t("terminal.chat.queued", { count: queuedTurns })}
            </span>
          ) : (
            /* 키 안내는 이 행의 남는 폭에 세 든다 — 쓰는 동안에만 서고, 좁은 패널에서는
               ⇧Enter 항목부터 접힌다(CSS @container). 읽는 화면에 상주하면 여러 패널이
               같은 문구를 나란히 반복한다. */
            <span className="agent-chat-composer-hint" aria-hidden="true">
              <span>{t(turnRunning ? "terminal.chat.composerHintQueue" : "terminal.chat.composerHintEnter")}</span>
              <span className="is-optional">{t("terminal.chat.composerHintNewline")}</span>
            </span>
          )}
          <span className="agent-chat-composer-actions">
            {/* 백그라운드 작업 글리프 — attach의 왼쪽 또래다. 살아 있는 잡이 있는 동안에만 서고,
                눌러서 Work 면을 연다. 도는 중이면 aurora 오브, 정착만 남으면 중립 링이며, 배지도
                글자도 없이 카운트는 접근성 레이블이 진다. 면이 열려 있으면 서지 않는다. */}
            {work.hasJobs && !work.open ? (
              <button
                type="button"
                className="agent-chat-composer-work"
                onClick={work.onOpen}
                aria-label={work.running > 0
                  ? t("terminal.chat.workGlyphRunningAria", { count: work.running })
                  : t("terminal.chat.stripAria")}
                aria-expanded={false}
                aria-controls={work.controlsId}
                title={work.running > 0
                  ? t("terminal.chat.stripRunning", { count: work.running })
                  : t("terminal.chat.stripAria")}
              >
                <span
                  className={work.running > 0 ? "agent-chat-composer-work-orbit" : "agent-chat-composer-work-rest"}
                  aria-hidden="true"
                />
              </button>
            ) : null}
            <ComposerAttachControl
              className="agent-chat-composer-attach"
              label={t("terminal.chat.composerAttach")}
              onFiles={addFiles}
            />
            {meter}
            {turnRunning ? (
              // 중지와 다음 지시는 서로 배타적이지 않다. 현재 턴을 끊는 문과 그 뒤에 실행할 지시를
              // 예약하는 문을 함께 세워, 포인터와 Enter가 서로 다른 일을 하면서도 그 차이를 숨기지 않는다.
              <>
                <button
                  type="button"
                  className="agent-chat-composer-stop"
                  disabled={stopping}
                  onClick={() => { void stop(); }}
                  aria-label={t("terminal.chat.stopAria")}
                  title={t("terminal.chat.stopTitle")}
                >
                  <span className="agent-chat-composer-stop-mark" aria-hidden="true" />
                  <span>{t("terminal.chat.stopCurrent")}</span>
                </button>
                <ComposerSubmitButton
                  className={`agent-chat-composer-send is-queue${canSend ? " is-armed" : ""}`}
                  disabled={!canSend}
                  onClick={() => { void send(); }}
                  aria-label={t("terminal.chat.composerQueue")}
                  title={t("terminal.chat.composerQueue")}
                />
              </>
            ) : (
              <ComposerSubmitButton
                className={`agent-chat-composer-send${canSend ? " is-armed" : ""}`}
                disabled={!canSend}
                onClick={() => { void send(); }}
                aria-label={t("terminal.chat.composerSend")}
                title={t("terminal.chat.composerSend")}
              />
            )}
          </span>
        </ComposerBar>
      </div>
    </div>
  );
}
