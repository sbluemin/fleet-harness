/**
 * 선택한 다른 컴퓨터에 새 목표를 만드는 Quick Launch 포트.
 *
 * Quick Launch는 이 포트가 연 회차 동안만 원격 대상으로 동작한다. 포트 구현이 host·수명·선택 세대를
 * 고정하고 검증한다 — 컴포저는 로컬 store·로컬 API·로컬 파일 첨부로 물러나지 않는다.
 */
export interface QuickLaunchHostTheater {
  readonly id: string;
  readonly label: string;
}

export interface QuickLaunchHostSession {
  /** 열림 회차 식별자. 같은 회차 안의 Theater 목록 갱신에는 바뀌지 않는다. */
  readonly id: number;
  readonly hostKey: string;
  readonly hostLabel: string;
  readonly theaters: readonly QuickLaunchHostTheater[];
  readonly theaterId: string | null;
  /** 같은 컴퓨터에서 닫으며 남긴 미발사 문면. 로컬 초안 슬롯과 섞지 않는다. */
  readonly draft: string;
  /**
   * 이 회차가 이미 만든 목표. 일부 이미지 업로드가 실패하면 회차가 남아 같은 목표에 다시 올린다 —
   * 재시도가 목표를 하나 더 만들지 않는다.
   */
  readonly created: { readonly id: string; readonly title: string } | null;
}

/** 목표 브리핑에 실을 이미지. 생성 전에는 이 컴퓨터의 미리보기로만 있고, 생성 뒤 그 목표에 올린다. */
export interface QuickLaunchHostAttachment {
  readonly name: string;
  readonly file: Blob;
}

export interface QuickLaunchHostCreateInput {
  readonly theaterId: string;
  readonly text: string;
  readonly language: "en" | "ko";
  readonly attachments: readonly QuickLaunchHostAttachment[];
}

/**
 * 이미지 하나를 올리지 못한 이유. "retry"(네트워크·일시 서버 오류)만 같은 키로 다시 보낼 가치가 있다.
 * 나머지는 같은 시도를 다시 보내도 풀리지 않는다 — capacity(목표의 업로드 영수증 256개 소진),
 * full(제품의 목표당 이미지 20장), conflict(같은 키에 다른 내용), rejected(크기·형식 등 거절), control(제어권 없음).
 */
export type QuickLaunchHostUploadFailure = "retry" | "capacity" | "full" | "conflict" | "rejected" | "control";

export type QuickLaunchHostCreateResult =
  | { readonly kind: "created" }
  | { readonly kind: "stale" }
  /** 목표는 생겼고 표시한 순번의 이미지만 올리지 못했다. 회차는 남는다. */
  | { readonly kind: "partial"; readonly failed: readonly { readonly index: number; readonly reason: QuickLaunchHostUploadFailure }[] };

/** 서버가 돌려준 업로드 거절을 재시도 가능 여부와 사람의 다음 행동으로 접는다. 원문 코드는 화면에 싣지 않는다. */
export function quickLaunchHostUploadFailure(status: number | null, code: unknown): QuickLaunchHostUploadFailure {
  if (code === "attachment_upload_capacity") return "capacity";
  if (code === "attachment_upload_conflict") return "conflict";
  if (code === "too_many_attachments") return "full";
  if (code === "not_controller" || code === "read_only" || code === "observer_only" || code === "route_denied" || code === "unauthorized" || status === 401 || status === 403) return "control";
  // 응답을 못 받았거나(네트워크·시간 초과) 서버가 일시적으로 실패했다 — 같은 키 재전송이 안전하다.
  if (status === null || status >= 500 || status === 408 || status === 429) return "retry";
  return "rejected";
}

export interface QuickLaunchHostPort {
  readonly getSnapshot: () => QuickLaunchHostSession | null;
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * 미발사 문면을 이 컴퓨터의 초안으로 남기고 회차를 닫는다. 이미 목표를 만든 회차라면 남은 이미지를 두고
   * 그 목표 선택으로 넘긴다 — 만든 목표를 화면에서 잃지 않는다.
   */
  readonly close: (draft: string) => void;
  /**
   * 고정한 회차에서 목표를 만들고(이미 만들었으면 건너뛴다) 이미지를 그 목표에 올린 뒤 검증된 미기동 목표 선택으로 넘긴다.
   * 회차가 그사이 바뀌었으면 "stale"로 끝나며 선택을 바꾸지 않는다. 생성 거절은 오류 코드로 던진다.
   */
  readonly create: (session: QuickLaunchHostSession, input: QuickLaunchHostCreateInput) => Promise<QuickLaunchHostCreateResult>;
}

/** 목표 제목은 첫 줄이고, 첫 줄로 다 담기지 않는 지시는 브리핑(note)으로 그대로 싣는다. */
export const QUICK_LAUNCH_HOST_TITLE_MAX = 120;

export function objectiveTextFromPrompt(text: string): { readonly title: string; readonly note: string | null } {
  const trimmed = text.trim();
  const firstLine = trimmed.split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim() ?? "";
  const points = Array.from(firstLine);
  const title = points.length > QUICK_LAUNCH_HOST_TITLE_MAX ? `${points.slice(0, QUICK_LAUNCH_HOST_TITLE_MAX - 1).join("")}…` : firstLine;
  return { title, note: trimmed === title ? null : trimmed };
}
