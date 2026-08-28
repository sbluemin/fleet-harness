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
import type { AgentChatCatalog, AgentChatQueueEntry } from "./chat-events.js";
import { ChatComposerDeck, renderComposerSpans } from "./composer-deck-view.js";
import { applyDeckPick, buildDeckSections, flattenDeckRows, readDeckToken, readResolvedTokenRanges } from "./composer-deck.js";
import { discardLaunchAttachment, messageAgentSession, readAgentChatCatalog, uploadLaunchAttachment } from "../api.js";

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
 * 실행 중에는 두 문이 선다: 현재 턴을 끊는 중지 글리프와 그 뒤에 실행할 지시를 예약하는 원형
 * 전송 control이다. 한 버튼의 뜻을 Stop으로 바꾸면서 Enter는 Queue로 남기면 같은 입력이 포인터와
 * 키보드에서 다른 약속을 하므로, 둘은 화면에서도 분리한다.
 *
 * 중지는 라벨을 벗고 첨부와 같은 글리프가 된다. 도는 동안에만 서는 문 하나가 라벨까지 두르면
 * 바에서 가장 큰 물건이 되어, 정작 읽어야 할 좌표와 계기를 밀어낸다. 대신 같은 일을 키보드에도
 * 배선한다 — 프레임 안에서의 Esc이며, CLI에서 도는 턴을 끊는 그 키와 같은 자리다. 문서 전역이
 * 아니라 프레임인 이유는 한 화면에 채팅 패널이 여럿 살 수 있어서다: 전역에 걸면 Esc 한 번이
 * 보이지 않는 패널의 턴까지 끊는다. 안내는 그 키가 실제로 듣는 구간(포커스)에만 선다.
 *
 * 예약은 수가 아니라 목록이다. "N개 예약됨" 한 줄은 무엇이 밀려 있는지 말하지 못해 사용자가
 * 자기 초안을 잃었는지 예약됐는지 가릴 수 없었다. 문면을 실은 칩을 field 위에 세우고 각 칩이
 * 자기 취소를 진다. 권위는 서버다 — 화면이 자기 카운터를 세면 취소가 무엇을 지웠는지 둘이
 * 따로 말하게 되고, 그 어긋남은 사용자가 취소되지 않은 지시를 취소된 것으로 읽는 자리가 된다.
 *
 * 전송은 Quick Launch 멘션 전달과 같은 경로(`messageAgentSession`)라 서버 계약 변경이 없다.
 * 모델·강도는 컨트롤이 아니라 사실 표시다 — 좌표를 바꾸는 길은 새 세션을 여는 것뿐이라
 * 이 바에 직접 새긴 좌표와 계기는 읽히기만 한다.
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

/**
 * 취소 요청 하나의 결말.
 *
 * 두 실패를 갈라야 한다. `started`는 서버가 판정한 사실이다 — 그 사이 자기 차례가 왔으니 남은 길은
 * 중지다. `unreachable`은 판정이 아니라 **판정이 없었다**는 뜻이다: 소켓이 끊겼거나 ACK가 오지 않아
 * 요청이 서버에 닿았는지조차 모르며, 그 지시는 아직 큐에 남아 있을 수 있다. 둘을 한 문구로 합치면
 * 연결이 끊긴 사용자에게 "이미 시작됐으니 턴을 중지하라"고 말하게 되는데, 그것은 사실이 아닐뿐더러
 * 필요하지 않은 파괴 동작을 권하는 것이다. 도는 턴의 중지(`stopFailed`)가 이미 같은 규율을 쓴다.
 */
export type AgentChatQueueCancelOutcome = "canceled" | "started" | "unreachable";

type QueueRejection = { readonly kind: "started" | "unreachable" };

export function AgentChatComposer({
  context,
  coordinate,
  meter,
  tourAnchor,
  turnRunning,
  stopping,
  queue,
  work,
  onStop,
  onCancelQueued,
}: {
  readonly context: OperationRenderContext;
  /** 세션 좌표의 사실 표시 — 모델·강도가 별도 배지 없이 컨트롤 행 좌측에 직접 앉는다. */
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
  /**
   * 서버가 접수해 현재 턴 뒤에 실행할 지시들 — 접수 뒤 초안이 사라져도 예약 사실과 그 문면을
   * 지킨다. 서버가 소유하는 목록이라 화면은 세지 않고 그대로 그린다.
   */
  readonly queue: readonly AgentChatQueueEntry[];
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
  /** 아직 시작하지 않은 예약 하나를 거둔다. 실패는 사유를 갈라 돌려준다(위 타입 참조). */
  readonly onCancelQueued: (queueId: string) => Promise<AgentChatQueueCancelOutcome>;
}) {
  const language = context.language ?? "en";
  const t = getT(language);
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = React.useState("");
  const [attachments, setAttachments] = React.useState<readonly ComposerDraftAttachment[]>([]);
  const [sending, setSending] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [rejection, setRejection] = React.useState<AttachmentRejection | null>(null);
  const [queueRejection, setQueueRejection] = React.useState<QueueRejection | null>(null);
  /** 응답을 기다리는 취소 좌표들 — 같은 칩의 두 번째 활성화를 삼킨다. */
  const cancelsInFlight = React.useRef(new Set<string>());
  const [dragOver, setDragOver] = React.useState(false);
  // 카탈로그는 덱과 미러가 함께 읽는다 — 미러가 좌표를 칠하려면 이름이 실재하는지
  // 대조해야 하므로 덱 블록보다 앞에 선다.
  const [catalog, setCatalog] = React.useState<AgentChatCatalog | null>(null);
  const [catalogTried, setCatalogTried] = React.useState(false);
  const attachmentsRef = React.useRef(attachments);
  attachmentsRef.current = attachments;
  // `ultracode` 무장 — Quick Launch와 같은 부품(sdk/composer)이 인식·미러 문법을 소유하고,
  // 상태(해제)와 표식만 이 조립이 진다. 무장은 초안에서 파생하고, 남는 것은 "이 초안에서 껐다"뿐이다.
  const highlightRef = React.useRef<HTMLDivElement | null>(null);
  const [ultracodeIgnored, setUltracodeIgnored] = React.useState(false);
  const ultracodeTokens = React.useMemo(() => readUltracodeTokens(draft), [draft]);
  const ultracodeArmed = ultracodeTokens.length > 0 && !ultracodeIgnored;
  /**
   * 미러 층이 칠할 구간들 — `ultracode` 무장과 **해석된 좌표**(`/이름`·`@이름`)가 한 층을 나눠 쓴다.
   *
   * 층을 둘로 두지 않는 이유는 정렬이다: 미러는 textarea 위에 글자 단위로 겹치는 그림이라,
   * 두 겹을 따로 띄우면 스크롤·자동 높이에서 서로 어긋난다. 한 목록으로 합쳐 한 번만 그린다.
   */
  const highlightSpans = React.useMemo(() => {
    const spans: { start: number; end: number; className: string }[] = [];
    if (ultracodeArmed) {
      for (const token of ultracodeTokens) {
        spans.push({ ...token, className: "agent-chat-composer-ultracode-token" });
      }
    }
    for (const range of readResolvedTokenRanges(draft, catalog)) {
      spans.push({ ...range, className: "agent-chat-composer-resolved-token" });
    }
    return spans.sort((a, b) => a.start - b.start);
  }, [draft, ultracodeArmed, ultracodeTokens, catalog]);

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
  }, [draft, syncUltracodeHighlight, highlightSpans.length]);
  // 프레임 폭은 첨부 트레이·패널 리사이즈로도 바뀐다 — textarea 자신을 관찰하는 것이 유일하게
  // 빠짐없는 기준이다.
  React.useEffect(() => {
    const input = inputRef.current;
    if (highlightSpans.length === 0 || !input || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => syncUltracodeHighlight());
    observer.observe(input);
    return () => observer.disconnect();
  }, [syncUltracodeHighlight, highlightSpans.length]);
  // 업로드가 끝나기 전에 칩이 제거된 key — 완료 콜백이 자신을 발견하면 방금 받은 id를 서버에서
  // 도로 거둔다(Quick Launch 첨부와 같은 회수 계약).
  const canceledKeysRef = React.useRef(new Set<string>());

  // ── 능력 덱 ────────────────────────────────────────────────────────────────
  // `/`는 세션의 능력(명령·스킬), `@`는 행위자(서브에이전트). 두 글자가 한 덱을 공유한다 —
  // 목록의 출처가 한 요청이고, 동시에 둘이 열릴 일이 없기 때문이다.
  const [deckDismissed, setDeckDismissed] = React.useState(false);
  const [focused, setFocused] = React.useState(false);
  const [deckIndex, setDeckIndex] = React.useState(0);
  const [caret, setCaret] = React.useState(0);
  const catalogFlight = React.useRef(false);

  // 덱은 캐럿이 이 입력에 있을 때만 선다. 포커스를 해제 상태로 대신하면(blur → dismissed)
  // 그 표시가 그대로 눌어붙어, 패널 최대화처럼 잠깐 포커스를 가져가는 조작 뒤에 `/`를 다시
  // 쳐도 덱이 영영 서지 않는다(실측에서 이 경로로 잡혔다).
  const deckToken = React.useMemo(
    () => (deckDismissed || !focused ? null : readDeckToken(draft, caret)),
    [draft, caret, deckDismissed, focused],
  );
  const deckSections = React.useMemo(
    () => (deckToken ? buildDeckSections(catalog, deckToken) : []),
    [catalog, deckToken],
  );
  const deckRows = React.useMemo(() => flattenDeckRows(deckSections), [deckSections]);
  const deckOpen = deckToken !== null;
  const deckPending = deckOpen && catalog === null;
  // 질의가 바뀌면 활성 행을 맨 위로 되돌린다 — 좁혀진 목록에서 옛 인덱스를 붙들면 사용자가
  // 보고 있지 않은 행이 선택돼 있다.
  const deckQuery = deckToken?.query ?? null;
  React.useEffect(() => { setDeckIndex(0); }, [deckQuery, deckToken?.kind]);
  // Esc 해제는 **그때 그 질의**에만 걸린다. 문면이 바뀌면 만료한다 — 만료시키지 않으면 한 번
  // 닫은 뒤 계속 타이핑해도 덱이 서지 않아, 사용자는 기능이 죽었다고 읽는다.
  const rawToken = React.useMemo(() => readDeckToken(draft, caret), [draft, caret]);
  const rawQuery = rawToken === null ? null : `${rawToken.kind}:${rawToken.query}`;
  React.useEffect(() => { setDeckDismissed(false); }, [rawQuery]);

  // 덱이 처음 열릴 때 한 번만 읽는다. 이 요청이 자식을 여는 쪽이므로(결정: 첫 `/`에 세션을 연다)
  // 사용자가 묻지 않았는데 미리 부르지 않는다.
  React.useEffect(() => {
    if (!deckOpen || catalog !== null || catalogFlight.current) return;
    catalogFlight.current = true;
    void readAgentChatCatalog(context.operationId)
      .then((value) => { if (value) setCatalog(value); })
      .catch(() => {})
      .finally(() => {
        catalogFlight.current = false;
        setCatalogTried(true);
      });
  }, [context.operationId, deckOpen, catalog]);

  const deckId = `agent-chat-deck-${context.operationId}`;
  const deckOptionId = React.useCallback((index: number) => `${deckId}-opt-${index}`, [deckId]);

  // `override`는 덱이 확정한 문면이다. 상태 갱신은 배치되므로 방금 고른 항목을 `setDraft` 뒤에
  // 그냥 보내면 이 클로저가 **직전** 초안을 읽는다 — 보낼 문면을 인자로 받아야 그 한 틱이 안전하다.
  const send = React.useCallback(async (override?: string) => {
    const text = (override ?? draft).trim();
    if (text.length === 0 || sending) return;
    // id 없는 칩은 아직 서버에 없다 — 텍스트만 먼저 나가면 첨부가 조용히 빠진다.
    if (attachmentsRef.current.some((attachment) => attachment.uploading)) return;
    const ids = attachmentsRef.current
      .map((attachment) => attachment.id)
      .filter((id): id is string => id !== null);
    setSending(true);
    setFailed(false);
    try {
      // 예약 receipt는 여기서 세우지 않는다. 서버가 접수와 동시에 큐 전량을 흘려 보내고 그
      // 알림은 HTTP 응답보다 먼저 닿을 수 있다 — 화면이 자기 셈을 겹쳐 세우면 이미 시작한 턴이
      // 내린 수를 다시 올려 stale로 남고, 취소와도 어긋난다.
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

  /**
   * 덱의 행 하나를 확정한다.
   *
   * 인자를 받지 않는 명령만 즉시 나간다. `argumentHint`가 있으면 `/이름 ` 까지만 넣고 캐럿을
   * 뒤에 두며, 에이전트 지목은 그 자체로 할 일이 아니므로 언제나 초안에 남는다.
   */
  const pickDeckRow = React.useCallback((index: number) => {
    if (!deckToken) return;
    const entry = deckRows[index];
    if (!entry) return;
    const { draft: next, caret: nextCaret } = applyDeckPick(draft, deckToken, entry);
    setDraft(next);
    setDeckDismissed(true);
    // 보내지 않는다 — 완성일 뿐이다. 캐럿은 넣은 토큰 바로 뒤에 앉아 인자를 이어 치게 한다.
    const input = inputRef.current;
    window.requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
    });
  }, [deckToken, deckRows, draft]);

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

  const cancelQueued = React.useCallback(async (queueId: string) => {
    // 같은 좌표로 두 번 보내지 않는다. 두 번째 요청은 첫 번째가 이미 거둔 좌표를 찾지 못해
    // `queue_not_found`를 받고, 그 거절은 "이미 시작했다"로 읽혀 **취소에 성공한** 사용자에게
    // 턴을 중지하라고 말한다 — 더블클릭 한 번이면 닿는 자리다.
    if (cancelsInFlight.current.has(queueId)) return;
    cancelsInFlight.current.add(queueId);
    setQueueRejection(null);
    // 칩은 낙관적으로 지우지 않는다. 목록의 권위는 서버이고, 거절은 사실이라 지웠다 되돌리면
    // 사용자가 취소를 두 번 읽는다 — 서버가 보낸 다음 목록이 칩을 내린다.
    try {
      const outcome = await onCancelQueued(queueId);
      if (outcome !== "canceled") setQueueRejection({ kind: outcome });
    } finally {
      // 좌표는 성공하면 서버가 보내는 다음 목록과 함께 사라진다. 실패했을 때만 다시 누를 수 있어야
      // 하므로 여기서 푼다 — 붙들어 두면 연결이 돌아와도 그 칩은 영영 취소되지 않는다.
      cancelsInFlight.current.delete(queueId);
    }
  }, [onCancelQueued]);

  // 발사 조건은 전송 경로와 같아야 한다 — 첨부만으로는 나가지 않으므로(서버가 받는 것은 문면과
  // 그에 딸린 첨부다) 첨부 하나로 버튼이 켜지면 눌러도 아무 일이 없는 죽은 컨트롤이 된다.
  const uploading = attachments.some((attachment) => attachment.uploading);
  const canSend = draft.trim().length > 0 && !sending && !uploading;
  const placeholder = t("terminal.chat.composerPlaceholder", { name: context.operation.title });
  const notice = failed
    ? t("terminal.chat.composerSendFailed")
    : queueRejection !== null
      ? t(queueRejection.kind === "started"
        ? "terminal.chat.queueCancelFailed"
        : "terminal.chat.queueCancelUnreachable")
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
        className={`agent-chat-composer-frame${dragOver ? " is-drag-over" : ""}${ultracodeArmed ? " is-ultracode" : ""}${highlightSpans.length > 0 ? " is-mirrored" : ""}`}
        {...(tourAnchor ? { "data-chat-tour": "composer" } : {})}
        onKeyDown={(event) => {
          // 도는 턴을 끊는 키. 프레임 안에서만 듣는다 — 문서 전역에 걸면 한 화면에 열린 다른
          // 채팅 패널의 턴까지 함께 끊는다. 안내(`Esc 중지`)가 서는 구간과 정확히 같은 구간이다.
          //
          // 조합 중의 Esc는 IME가 후보를 물리는 키라 여기서 가로채지 않는다. 문맥 계기의 팝오버가
          // 열려 있으면 그쪽이 capture 단계에서 전파를 끊으므로 이 자리에 닿지 않는다 — 열린
          // 표면을 먼저 닫는 것이 Esc의 통상 위계이고, 그 위계가 저절로 지켜진다.
          if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
          if (!turnRunning || stopping) return;
          event.preventDefault();
          void stop();
        }}
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
        {/* 예약 목록 — field 위 자기 자리에 선다. 바에 두면 좌표·계기와 폭을 다투다 한 줄로
            잘리고, 그 한 줄은 무엇이 밀려 있는지 말하지 못한다. 서버가 보내는 전량을 그대로 그린다. */}
        {queue.length > 0 ? (
          <div className="agent-chat-composer-queue" role="group" aria-label={t("terminal.chat.queueTitle")}>
            <p className="agent-chat-composer-queue-title">{t("terminal.chat.queueTitle")}</p>
            <ul className="agent-chat-composer-queue-list">
              {queue.map((entry, index) => (
                <li key={entry.id} className="agent-chat-composer-queue-item">
                  <span className="agent-chat-composer-queue-ord" aria-hidden="true">{index + 1}</span>
                  <span className="agent-chat-composer-queue-text">{entry.text}</span>
                  <button
                    type="button"
                    className="agent-chat-composer-queue-cancel"
                    onClick={() => { void cancelQueued(entry.id); }}
                    aria-label={t("terminal.chat.queueCancel", { index: String(index + 1) })}
                    title={t("terminal.chat.queueCancel", { index: String(index + 1) })}
                  >
                    {t("terminal.chat.queueCancelLabel")}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <ComposerField className="agent-chat-composer-field">
          {/* textarea와 미러를 한 flex 아이템으로 묶는다 — 미러를 field에 직접 붙이면 첨부 칩이 선
              줄에서 시작점이 어긋난다. 묶으면 정렬 기준이 textarea의 박스 하나로 줄어든다. */}
          <span className="agent-chat-composer-input-wrap">
            {/* 덱은 input-wrap에 걸린다 — 이 요소가 컴포저 안에서 유일하게 position:relative다.
                패널이 짧으면 `.canvas-operation-terminal`의 overflow:hidden에 잘리는데, 그것은
                Quick Launch가 fixed 오버레이로 피하는 대가를 이 표면은 치른다는 뜻이다. */}
            {deckOpen ? (
              <ChatComposerDeck
                deckId={deckId}
                token={deckToken}
                sections={deckSections}
                rows={deckRows}
                activeIndex={deckIndex}
                pending={deckPending && !catalogTried}
                language={language}
                optionId={deckOptionId}
                onPick={pickDeckRow}
                onHover={setDeckIndex}
              />
            ) : null}
            {highlightSpans.length > 0 ? (
              <div className="agent-chat-composer-highlight" ref={highlightRef} aria-hidden="true">
                {renderComposerSpans(draft, highlightSpans)}
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
              // 덱은 listbox이고 이 입력이 그 소유자다 — 활성 행을 aria로 잇지 않으면
              // 스크린리더에서 방향키 이동이 아무 말도 하지 않는다(QL 덱과 같은 계약).
              {...(deckOpen ? { "aria-controls": deckId, "aria-expanded": true } : {})}
              {...(deckOpen && deckRows.length > 0 ? { "aria-activedescendant": deckOptionId(deckIndex) } : {})}
              onChange={(event) => {
                setDraft(event.target.value);
                setCaret(event.target.selectionStart ?? event.target.value.length);
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
                // 덱이 열려 있는 동안만 이동·확정 키를 가져간다. 매치가 0이면 Enter를 잡지
                // 않는다 — "일치 없으면 쓴 문장이 그대로 나간다"가 두 컴포저 공통 계약이다.
                if (deckOpen && deckRows.length > 0 && !event.nativeEvent.isComposing) {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setDeckIndex((current) => (current + 1 >= deckRows.length ? 0 : current + 1));
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setDeckIndex((current) => (current - 1 < 0 ? deckRows.length - 1 : current - 1));
                    return;
                  }
                  if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
                    event.preventDefault();
                    pickDeckRow(deckIndex);
                    return;
                  }
                }
                // 열린 덱을 먼저 닫는다. 프레임의 Esc(도는 턴 중지)까지 올라가지 않도록 전파를
                // 끊는다 — 열린 표면을 닫는 것이 Esc의 통상 위계이고, 여기서 멈추지 않으면 한
                // 번의 Esc가 덱을 닫으면서 턴까지 끊는다.
                if (event.key === "Escape" && deckOpen && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.stopPropagation();
                  setDeckDismissed(true);
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
              // 캐럿이 움직이면 `@` 토큰의 유효 구간도 움직인다 — 클릭·방향키 이동까지
              // 따라잡으려면 입력 이벤트만으로는 부족하다.
              onKeyUp={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
              onClick={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
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
          ) : (
            /* 키 안내는 이 행의 남는 폭에 세 든다 — 쓰는 동안에만 서고, 좁은 패널에서는
               ⇧Enter 항목부터 접힌다(CSS @container). 읽는 화면에 상주하면 여러 패널이
               같은 문구를 나란히 반복한다.

               예약 수는 여기서 말하지 않는다 — 목록이 field 위에 문면째로 서 있고, 같은 사실을
               두 자리에서 말하면 한쪽이 반드시 먼저 낡는다. 대신 도는 동안에만 중지 키를 밝힌다:
               그 키가 실제로 듣는 구간이 이 안내가 서는 구간(포커스)과 같다. */
            <span className="agent-chat-composer-hint" aria-hidden="true">
              <span>{t(turnRunning ? "terminal.chat.composerHintQueue" : "terminal.chat.composerHintEnter")}</span>
              {turnRunning ? <span>{t("terminal.chat.composerHintStop")}</span> : null}
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
