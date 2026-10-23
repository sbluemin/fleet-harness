import type { FloatingWidgetOperationsCapability } from "@fleet-console/sdk/floating";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";

import {
  createNoticeQueue,
  dismissNotice,
  MAX_NOTICE_ANNOUNCEMENTS,
  selectNotices,
  selectNoticesPruned,
  type NoticeItem,
} from "./notice-queue.js";
import { getT, type ScuttlebuttMessageKey } from "./scuttlebutt-catalog.js";

export type NoticeKind = "arrival" | "departure" | "awaiting";

export interface NoticeSource {
  list(): readonly NoticeItem[];
  subscribe(listener: (items: readonly NoticeItem[]) => void): () => void;
}

const NOTICE_VISIBLE_MS = 6_000;
/** 하나의 부관 위에 여러 소식이 서면 이 순서로 위로 쌓인다. */
const STACK_ORDER: Record<NoticeKind, number> = { arrival: 0, departure: 1, awaiting: 2 };
const LABEL_KEY: Record<NoticeKind, ScuttlebuttMessageKey> = {
  arrival: "arrival.done",
  departure: "departure.started",
  awaiting: "awaiting.label",
};
const OPEN_KEY: Record<NoticeKind, ScuttlebuttMessageKey> = {
  arrival: "arrival.open",
  departure: "departure.open",
  awaiting: "awaiting.open",
};
const MANY_KEY: Record<NoticeKind, ScuttlebuttMessageKey> = {
  arrival: "arrival.manyCount",
  departure: "departure.manyCount",
  awaiting: "awaiting.manyCount",
};

/**
 * Operation 소식 말풍선 하나로 세 채널을 그린다. 봉투·좌표 추적·Escape·자동 소멸은 같고,
 * 색(신호 채널)과 원장 정리 규칙만 종류를 따른다. 완료는 확인 전까지 원장에 남아 있으므로
 * 큐를 걷지 않고, 시작·대기는 원장에서 빠지는 즉시 큐에서도 걷는다.
 */
export function NoticeBubble({
  kind,
  source,
  operations,
  locale,
  mascot,
  quiet,
  positionRevision,
  onShow,
}: {
  readonly kind: NoticeKind;
  readonly source: NoticeSource;
  readonly operations: FloatingWidgetOperationsCapability;
  readonly locale?: ConsoleLocale;
  readonly mascot: React.RefObject<HTMLButtonElement | null>;
  readonly quiet: boolean;
  readonly positionRevision: number;
  readonly onShow: () => void;
}) {
  const bubbleRef = React.useRef<HTMLDivElement>(null);
  const shownRef = React.useRef(new Set<string>());
  const onShowRef = React.useRef(onShow);
  React.useEffect(() => {
    onShowRef.current = onShow;
  }, [onShow]);
  const [selection, setSelection] = React.useState(() => createNoticeQueue(source.list()));
  const active = selection.queue[0];
  const select = kind === "arrival" ? selectNotices : selectNoticesPruned;

  React.useEffect(() => source.subscribe((current) => {
    setSelection((state) => select(state, current));
  }), [select, source]);

  const updatePlacement = React.useCallback(() => {
    const mascotElement = mascot.current;
    const bubble = bubbleRef.current;
    if (!mascotElement || !bubble) return;
    placeNoticeBubble({
      bubble,
      mascot: mascotElement,
      order: STACK_ORDER[kind],
      siblings: Array.from(document.querySelectorAll<HTMLElement>(".scuttlebutt-notice-bubble")),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
  }, [kind, mascot]);

  // 새는 매 프레임 스스로 좌표를 쓰므로 리액트 갱신이 없다 — 말풍선이 붙어 있으려면 같이 따라가야 한다.
  React.useLayoutEffect(() => {
    if (!quiet || !active) return;
    let frame = window.requestAnimationFrame(function follow() {
      updatePlacement();
      frame = window.requestAnimationFrame(follow);
    });
    updatePlacement();
    return () => window.cancelAnimationFrame(frame);
  }, [active, positionRevision, quiet, updatePlacement]);

  React.useEffect(() => {
    if (!quiet || !active) return;
    if (!shownRef.current.has(active.id)) {
      shownRef.current.add(active.id);
      onShowRef.current();
    }
    // onShow 를 의존성에 두면 부모가 리렌더할 때마다 타이머가 리셋되어 말풍선이 영영 안 사라진다.
    const timeout = window.setTimeout(() => {
      setSelection((state) => dismissNotice(state));
    }, NOTICE_VISIBLE_MS);
    return () => window.clearTimeout(timeout);
  }, [active, quiet]);

  // 포커스는 pointerdown 기본 동작을 막아 터미널 쪽에 남겨 두므로 Escape는 창 단위로 받는다.
  React.useEffect(() => {
    if (!quiet || !active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // 전면 표면이 처리한 Escape(기본 동작 취소됨)나 모달 입력 독점 중에는 버블이 받지 않는다 —
      // 모달 아래 위젯의 포인터 입력을 막는 layout.css 계약과 같은 경계다.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      // 같은 window에 나중에 등록된 전면 핸들러(컨텍스트 메뉴·팝오버)는 이 시점에 아직
      // preventDefault를 부르지 않았을 수 있다 — 디스패치 완료 후 다시 확인해 한 번의
      // Escape가 전면 표면과 버블을 함께 닫지 않게 한다.
      window.setTimeout(() => {
        if (event.defaultPrevented) return;
        setSelection((state) => dismissNotice(state));
      }, 0);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, quiet]);

  if (!quiet || !active) return null;
  const t = getT(locale);
  const dismissActive = () => {
    setSelection((state) => dismissNotice(state));
  };
  // 연 Operation으로 시선이 옮겨갔으니 알림은 그 자리에서 닫는다 — 남겨 두면 이미 본 소식이 계속 떠 있다.
  const openOperation = (operationId: string) => {
    operations.focus(operationId);
    dismissActive();
  };
  // 한 번에 몰린 소식은 행으로 전개하되 카드가 길어지지 않게 큐 상한과 같은 수에서 자른다.
  const visible = active.items.slice(0, MAX_NOTICE_ANNOUNCEMENTS);
  const remainder = active.items.length - visible.length;
  return (
    <div
      ref={bubbleRef}
      className={`scuttlebutt-notice-bubble is-${kind}`}
      data-order={STACK_ORDER[kind]}
      aria-live="polite"
      onPointerDown={(event) => event.preventDefault()}
    >
      <div className="scuttlebutt-notice-body">
        <span className="scuttlebutt-notice-label">{t(LABEL_KEY[kind])}</span>
        {visible.map((item) => (
          <button
            key={item.operationId}
            type="button"
            className="scuttlebutt-notice-open"
            title={t(OPEN_KEY[kind])}
            onClick={() => openOperation(item.operationId)}
          >
            <span className="scuttlebutt-notice-detail">{item.title}</span>
          </button>
        ))}
        {remainder > 0 ? (
          <span className="scuttlebutt-notice-more">{t(MANY_KEY[kind], { count: remainder })}</span>
        ) : null}
      </div>
      <button
        type="button"
        className="scuttlebutt-notice-dismiss"
        aria-label={t("bubble.dismiss")}
        onClick={dismissActive}
      >
        ✕
      </button>
    </div>
  );
}

/**
 * 부관 옆에 세우되, 같은 부관 위에 이미 선 낮은 순서의 소식 위로 쌓는다. 순서가 낮은 형제만
 * 센다 — 서로를 세면 둘 다 한 칸씩 올라가 빈 줄이 남는다.
 */
export function placeNoticeBubble({
  bubble,
  mascot,
  order,
  siblings,
  viewportWidth,
  viewportHeight,
}: {
  readonly bubble: HTMLElement;
  readonly mascot: HTMLButtonElement;
  readonly order: number;
  readonly siblings: readonly HTMLElement[];
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}): void {
  const mascotRect = mascot.getBoundingClientRect();
  const bubbleRect = bubble.getBoundingClientRect();
  const margin = 8;
  const gap = 8;
  const alignRight = mascotRect.left + mascotRect.width / 2 > viewportWidth / 2;
  const placeAbove = mascotRect.top + mascotRect.height / 2 > viewportHeight / 2;
  const preferredLeft = alignRight ? mascotRect.right - bubbleRect.width : mascotRect.left;
  const left = clamp(preferredLeft, margin, viewportWidth - bubbleRect.width - margin);
  let stack = 0;
  for (const sibling of siblings) {
    if (sibling === bubble || sibling.style.visibility !== "visible") continue;
    if (Number(sibling.dataset.order ?? "0") >= order) continue;
    stack += sibling.getBoundingClientRect().height + gap;
  }
  bubble.style.left = `${left}px`;
  if (placeAbove) {
    bubble.style.top = "";
    bubble.style.bottom = `${viewportHeight - mascotRect.top + gap + stack}px`;
  } else {
    bubble.style.bottom = "";
    bubble.style.top = `${mascotRect.bottom + gap + stack}px`;
  }
  bubble.style.visibility = "visible";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
