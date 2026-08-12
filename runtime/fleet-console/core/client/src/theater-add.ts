import { addTheater, fetchTheaters, issueTheaterFolderGrant } from "./api.js";
import { beginAddTheater, completeAddTheater, failAddTheater, hydrateTheaters } from "./store.js";

// Theater 등록의 단일 경로: 폴더 grant 발급 → host POST → 서버 순서로 재수화.
// Operations 사이드바와 모바일 Theater 페이지가 공유한다.
export async function registerTheaterFromPath(path: string): Promise<void> {
  beginAddTheater();
  try {
    const folderGrantId = await issueTheaterFolderGrant(path);
    const result = await addTheater(folderGrantId);
    completeAddTheater(result);
    // 서버 register()는 기존 order를 보존하므로, 이미 수동 정렬된 Theater를 재-오픈하면
    // completeAddTheater의 낙관적 prepend가 저장된 위치와 어긋난다(Codex P2). 서버 순서로 재수화해
    // "열어도 위치 고정" 계약을 지킨다. hydrate는 방금 활성화한 result.id 선택을 유지한다.
    void fetchTheaters(null).then(hydrateTheaters).catch(() => {});
  } catch (error) {
    failAddTheater(error instanceof Error ? error.message : String(error));
  }
}
