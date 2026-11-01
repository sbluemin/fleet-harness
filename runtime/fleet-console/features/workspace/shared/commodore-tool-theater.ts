/**
 * 사령관 전용 도구(파일·저장소·Shell)가 함께 쓰는 Theater 계약 — 순수 타입과 판정만 둔다.
 *
 * 상태의 저장은 클라이언트(`../client/theater-tools/store.js`)가 맡고, 이 파일은
 * 등록 목록·저장 선택만으로 답이 정해지는 판정을 모아 둔다. DOM·React를 읽지 않으므로
 * 영속 스위트에서 그대로 검사한다.
 */

/** 사령관 대화에서만 서는 세 도구의 진입점 id. 레일·단축키·팔레트·타일 판정이 함께 읽는다. */
export const COMMODORE_TOOL_IDS = ["file-explorer", "repository", "global-shell"] as const;

export type CommodoreToolId = (typeof COMMODORE_TOOL_IDS)[number];

export function isCommodoreToolId(id: string): id is CommodoreToolId {
  return (COMMODORE_TOOL_IDS as readonly string[]).includes(id);
}

/** 판정에 쓰는 Theater 한 줄 — 사령관 목록 행에서 가려낸 최소 모양이다. */
export interface CommodoreToolTheaterOption {
  readonly theaterId: string;
  readonly status: "available" | "missing";
}

/**
 * (사령관, 도구)의 Theater 판정.
 * - `resolved`: 그 Theater로 연다. 처음이면 등록 첫 Theater, 해제됐으면 남은 첫 Theater다.
 * - `choose`: 저장한 Theater가 등록에는 있으나 폴더가 사라졌다. 본문은 그 Theater로
 *   불러오기를 시도하고(불러오기 실패는 남길 메시지다), 선택기만 "Theater 고르기"로 선다.
 * - `none`: 등록 Theater가 하나도 없다. 본문 대신 빈 상태를 세운다.
 */
export type CommodoreToolTheaterResolution =
  | { readonly kind: "resolved"; readonly theaterId: string }
  | { readonly kind: "choose"; readonly theaterId: string }
  | { readonly kind: "none" };

/**
 * 저장 선택과 등록 목록으로 그 패널의 Theater를 정한다. 등록에 없는 값은 절대 돌려주지 않는다 —
 * 다른 Theater의 파일·Shell을 건드리는 일은 이 판정에서 막는다.
 */
export function resolveCommodoreToolTheater(
  stored: string | null,
  theaters: readonly CommodoreToolTheaterOption[],
): CommodoreToolTheaterResolution {
  const available = theaters.filter((theater) => theater.status === "available");
  if (available.length === 0) return { kind: "none" };
  if (stored !== null && stored !== "") {
    const match = theaters.find((theater) => theater.theaterId === stored);
    if (match !== undefined) {
      return match.status === "available"
        ? { kind: "resolved", theaterId: match.theaterId }
        : { kind: "choose", theaterId: match.theaterId };
    }
    // 설정에서 해제한 Theater는 목록에 없다 — 남은 첫 Theater로 넘어간다.
  }
  return { kind: "resolved", theaterId: available[0]!.theaterId };
}

/** 도구 패널로 파일 열기를 보내는 요청의 최소 모양 — 출처와 목표 문맥만 본다. */
export interface CommodoreToolFileOpenRequest {
  readonly objectiveId?: string;
  readonly source: string;
}

/**
 * 사령관이 아닌 대화의 채팅 파일 링크는 도구 패널을 열지 않는다(읽기 전용 미리보기는 미션 6).
 * 지휘관·구성원·일반 Objective 채팅이 파일 링크를 여는 길(`agent-chat` + 목표 문맥)만 가린다.
 * 탐색기·팔레트·문서·터미널의 열기는 그대로 둔다.
 */
export function shouldSuppressCommodoreToolFileOpen(request: CommodoreToolFileOpenRequest): boolean {
  return request.source === "agent-chat" && request.objectiveId !== undefined;
}
