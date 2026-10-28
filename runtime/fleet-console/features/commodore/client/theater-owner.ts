import { readCommodoreList } from "./commodore-list.js";

/**
 * 전역 Theater 등록부 없이 Theater의 주인을 찾는다. 후보 사령관을 알면(보고 있는
 * 사령관·표면의 사령관) 그 목록에 있을 때만 인정하고, 모르면 가용 목록에 든
 * 사령관이 정확히 하나일 때만 돌려준다. 여럿이 나누는 폴더는 고르지 않는다.
 */
export function resolveTheaterOwner(theaterId: string, preferredCommodoreId?: string | null): string | null {
  const commodores = readCommodoreList();
  // 사령관 UUID 자체가 들어오면(Codex 리더 주소 등) 그 사령관이다.
  if (commodores.some((row) => row.commodoreId === theaterId)) return theaterId;
  if (preferredCommodoreId) {
    const preferred = commodores.find((row) => row.commodoreId === preferredCommodoreId);
    if (preferred?.theaters.some((theater) => theater.status === "available" && theater.theaterId === theaterId)) return preferredCommodoreId;
  }
  const owners = commodores.filter((row) => row.theaters.some((theater) => theater.status === "available" && theater.theaterId === theaterId));
  return owners.length === 1 ? owners[0]!.commodoreId : null;
}

/** 폴더 이름 — 경로 문자열에서 마지막 칸만 떼어낸다. 브라우저에는 node:path가 없다. */
export function theaterFolderName(path: string | null | undefined): string | null {
  if (!path) return null;
  const base = path.split(/[\\/]/).filter(Boolean).pop() ?? "";
  return base || null;
}

/**
 * 화면에 보여줄 Theater 이름. 소유 사령관 row의 라벨을 먼저 읽고, 없으면 폴더
 * 이름(cwd 끝칸), 그래도 없으면 id 그대로 둔다.
 */
export function theaterLabelOf(commodoreId: string | null | undefined, theaterId: string | null | undefined, folderName?: string | null): string {
  return theaterLabelOrNull(commodoreId, theaterId) ?? folderName ?? theaterId ?? "Unknown";
}

/** 사령관 목록에서 찾은 라벨. 없으면 null이다. */
export function theaterLabelOrNull(commodoreId: string | null | undefined, theaterId: string | null | undefined): string | null {
  if (!theaterId) return null;
  const rows = readCommodoreList();
  const scopes = commodoreId ? rows.filter((row) => row.commodoreId === commodoreId) : rows;
  return scopes.flatMap((row) => row.theaters).find((theater) => theater.status === "available" && theater.theaterId === theaterId)?.label
    ?? scopes.flatMap((row) => row.theaters).find((theater) => theater.theaterId === theaterId)?.label
    ?? null;
}

/**
 * HTTP 요청에 붙이는 소유자 표식. 호출 문맥이 아는 사령관만 싣는다 — 모르면
 * 생략하고, 목록을 뒤져 추론하지 않는다. 같은 폴더를 여러 사령관이 나누면
 * 주인은 문맥이 정한다.
 */
export function theaterOwnerParam(commodoreId?: string | null): { readonly commodoreId: string } | Record<string, never> {
  return commodoreId ? { commodoreId } : {};
}
