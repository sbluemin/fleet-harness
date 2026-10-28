/** 창을 든 기계의 브라우저 프로필 IO. 이력 정책과 직렬화는 Console이 소유한다. */
export const DESKTOP_BROWSER_HISTORY = "Fleet.browserHistory";
export const DESKTOP_BROWSER_CHROME_HISTORY = "Fleet.chromeHistory";
export const BROWSER_HISTORY_MAX_BYTES = 4 * 1024 * 1024;
export const BROWSER_HISTORY_MAX_ENTRIES = 2000;
/** Chrome의 집계 방문 정보를 전달한다. 시각은 Unix milliseconds. */
export interface BrowserHistoryVisit {
  readonly url: string;
  readonly title: string;
  readonly visits: number;
  readonly lastVisited: number;
}
/** browserHistory: { browserProfile, action: "read" | "write", data?: string, revision?: string }.
 * 결과 { data: string | null, revision: string }. write는 직전 read의 revision을 요구하며 변경된 파일은 덮어쓰지 않는다. */
/** chromeHistory: { profileId }, 결과 { entries: BrowserHistoryVisit[] }. 원본은 수정하지 않는다. */
