import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import { createTranslator } from "@fleet-console/sdk/i18n/translate";

// ═══ messages ════════════════════════════════════════════════════════════════

export const repositoryEn = {
  // panel / identity
  "repository.panel.title": "Repository",
  "repository.sync.button": "Sync",
  "repository.sync.title": "Fetch --prune from origin, then refresh",

  // workspace tree sections
  "repository.section.context": "CONTEXT",
  "repository.section.working": "WORKING",
  "repository.section.worktrees": "WORKTREES",
  "repository.section.branches": "BRANCHES",
  "repository.section.tags": "TAGS",
  "repository.section.stashes": "STASHES",

  // working rows / sources
  "repository.source.history": "History",
  "repository.source.changes": "Changes",
  "repository.source.compare": "Compare",

  // ref groups
  "repository.refs.local": "LOCAL",
  "repository.refs.remotes": "REMOTES",
  "repository.refs.tags": "TAGS",

  // discovery
  "repository.discovery.placeholder": "Find repositories…",
  "repository.discovery.aria": "Find repositories",
  "repository.discovery.clearSearch": "Clear search",
  "repository.discovery.depth": "Depth",
  "repository.discovery.scanShallower": "Scan shallower",
  "repository.discovery.scanDeeper": "Scan deeper",
  "repository.discovery.countMatched": "{matched} of {total}",
  "repository.discovery.countFound": "{count} found",
  "repository.discovery.countFoundLimited": "{count} found · limit reached",
  "repository.discovery.noMatching": "No matching repositories",
  "repository.discovery.loadReposFailed": "Unable to load repositories",
  "repository.discovery.loadWorktreesFailed": "Unable to load worktrees",
  "repository.discovery.loadRefsFailed": "Unable to load refs",

  // shared chrome
  "repository.common.retry": "Retry",
  "repository.common.loading": "Loading…",
  "repository.common.filterPlaceholder": "Filter…",
  "repository.common.filterChangedFiles": "Filter changed files",
  "repository.common.clearFilter": "Clear filter",
  "repository.common.listView": "List view",
  "repository.common.treeView": "Tree view",
  "repository.common.resizeSourceTree": "Resize source tree",
  "repository.common.noMatchingItems": "No matching items",

  // changes notices
  "repository.changes.section": "Changes",
  "repository.changes.empty": "No changes",
  "repository.changes.notice.noGitRepoTitle": "Not a Git repository",
  "repository.changes.notice.noGitRepoBody": "This folder isn't a Git repository, so there are no changes to show.",
  "repository.changes.notice.gitUnavailableTitle": "Git isn't available",
  "repository.changes.notice.gitUnavailableBody": "Git was not found on this system. Install Git and make sure it's on your PATH.",

  // file status
  "repository.status.modified": "modified",
  "repository.status.added": "added",
  "repository.status.deleted": "deleted",
  "repository.status.renamed": "renamed",
  "repository.status.typeChanged": "type changed",
  "repository.status.untracked": "untracked",

  // history
  "repository.history.uncommitted": "Uncommitted changes",
  "repository.history.wipStats_one": "{count} files · +{additions} −{deletions}",
  "repository.history.wipStats_other": "{count} files · +{additions} −{deletions}",
  "repository.history.empty": "No history",
  "repository.history.refresh": "Refresh",
  "repository.history.capped": "History capped at 200 commits.",
  "repository.history.loadMore": "Load older commits",
  "repository.history.loadingMore": "Loading…",
  "repository.history.end": "You've reached the first commit.",
  "repository.history.loadingCommit": "Loading commit…",
  "repository.history.noChangedFiles": "No changed files",
  "repository.history.closeInspector": "Close inspector",
  "repository.history.previousFile": "Previous file",
  "repository.history.nextFile": "Next file",
  "repository.history.details": "Details",
  "repository.history.changedFiles": "Changed files",
  "repository.history.copy": "copy",
  "repository.history.copied": "copied",
  "repository.history.parent": "parent {short}",
  "repository.history.detached": "detached",
  "repository.history.resizeDock": "Resize commit detail dock",
  "repository.history.resizeLog": "Resize commit log",

  // time
  "repository.time.today": "Today {time}",
  "repository.time.yesterday": "Yesterday {time}",

  // compare
  "repository.compare.run": "Compare",
  "repository.compare.baseRef": "Base ref",
  "repository.compare.headRef": "Head ref",
  "repository.compare.selectBase": "Select base…",
  "repository.compare.optionLocal": "LOCAL · {label}",
  "repository.compare.optionRemotes": "REMOTES · {label}",
  "repository.compare.optionTags": "TAGS · {label}",
  "repository.compare.idle": "Select base and head refs, then run Compare.",
  "repository.compare.comparing": "Comparing…",
  "repository.compare.noDifferences": "No differences between the selected refs.",
  "repository.compare.noMergeBase": "The selected refs share no common history.",
  "repository.compare.mergeBase": "merge-base",
  "repository.compare.capped": "Comparison capped — file list truncated.",

  // hunk
  "repository.hunk.diffTruncated": "Diff truncated",
} as const;

export const repositoryKo: Record<keyof typeof repositoryEn, string> = {
  "repository.panel.title": "저장소",
  "repository.sync.button": "동기화",
  "repository.sync.title": "origin에서 fetch --prune 후 새로고침",

  "repository.section.context": "컨텍스트",
  "repository.section.working": "작업",
  "repository.section.worktrees": "워크트리",
  "repository.section.branches": "브랜치",
  "repository.section.tags": "태그",
  "repository.section.stashes": "스태시",

  "repository.source.history": "기록",
  "repository.source.changes": "변경",
  "repository.source.compare": "비교",

  "repository.refs.local": "로컬",
  "repository.refs.remotes": "원격",
  "repository.refs.tags": "태그",

  "repository.discovery.placeholder": "저장소 찾기…",
  "repository.discovery.aria": "저장소 찾기",
  "repository.discovery.clearSearch": "검색 지우기",
  "repository.discovery.depth": "깊이",
  "repository.discovery.scanShallower": "더 얕게 스캔",
  "repository.discovery.scanDeeper": "더 깊게 스캔",
  "repository.discovery.countMatched": "{matched} / {total}",
  "repository.discovery.countFound": "{count}개 발견",
  "repository.discovery.countFoundLimited": "{count}개 발견 · 한도 도달",
  "repository.discovery.noMatching": "일치하는 저장소 없음",
  "repository.discovery.loadReposFailed": "저장소를 불러올 수 없습니다",
  "repository.discovery.loadWorktreesFailed": "워크트리를 불러올 수 없습니다",
  "repository.discovery.loadRefsFailed": "refs를 불러올 수 없습니다",

  "repository.common.retry": "다시 시도",
  "repository.common.loading": "불러오는 중…",
  "repository.common.filterPlaceholder": "필터…",
  "repository.common.filterChangedFiles": "변경된 파일 필터",
  "repository.common.clearFilter": "필터 지우기",
  "repository.common.listView": "목록 보기",
  "repository.common.treeView": "트리 보기",
  "repository.common.resizeSourceTree": "소스 트리 크기 조절",
  "repository.common.noMatchingItems": "일치하는 항목 없음",

  "repository.changes.section": "변경",
  "repository.changes.empty": "변경 없음",
  "repository.changes.notice.noGitRepoTitle": "Git 저장소가 아닙니다",
  "repository.changes.notice.noGitRepoBody": "이 폴더는 Git 저장소가 아니라 표시할 변경이 없습니다.",
  "repository.changes.notice.gitUnavailableTitle": "Git을 사용할 수 없습니다",
  "repository.changes.notice.gitUnavailableBody": "이 시스템에서 Git을 찾지 못했습니다. Git을 설치하고 PATH에 추가하세요.",

  "repository.status.modified": "수정됨",
  "repository.status.added": "추가됨",
  "repository.status.deleted": "삭제됨",
  "repository.status.renamed": "이름 변경됨",
  "repository.status.typeChanged": "형식 변경됨",
  "repository.status.untracked": "추적되지 않음",

  "repository.history.uncommitted": "커밋되지 않은 변경",
  "repository.history.wipStats_one": "{count}개 파일 · +{additions} −{deletions}",
  "repository.history.wipStats_other": "{count}개 파일 · +{additions} −{deletions}",
  "repository.history.empty": "기록 없음",
  "repository.history.refresh": "새로고침",
  "repository.history.capped": "기록은 최대 200개 커밋까지 표시됩니다.",
  "repository.history.loadMore": "이전 커밋 더 보기",
  "repository.history.loadingMore": "불러오는 중…",
  "repository.history.end": "저장소의 첫 커밋까지 왔습니다.",
  "repository.history.loadingCommit": "커밋 불러오는 중…",
  "repository.history.noChangedFiles": "변경된 파일 없음",
  "repository.history.closeInspector": "검사기 닫기",
  "repository.history.previousFile": "이전 파일",
  "repository.history.nextFile": "다음 파일",
  "repository.history.details": "세부 정보",
  "repository.history.changedFiles": "변경된 파일",
  "repository.history.copy": "복사",
  "repository.history.copied": "복사됨",
  "repository.history.parent": "부모 {short}",
  "repository.history.detached": "detached",
  "repository.history.resizeDock": "커밋 상세 독 크기 조절",
  "repository.history.resizeLog": "커밋 로그 크기 조절",

  "repository.time.today": "오늘 {time}",
  "repository.time.yesterday": "어제 {time}",

  "repository.compare.run": "비교",
  "repository.compare.baseRef": "Base ref",
  "repository.compare.headRef": "Head ref",
  "repository.compare.selectBase": "base 선택…",
  "repository.compare.optionLocal": "로컬 · {label}",
  "repository.compare.optionRemotes": "원격 · {label}",
  "repository.compare.optionTags": "태그 · {label}",
  "repository.compare.idle": "base와 head ref를 선택한 뒤 비교를 실행하세요.",
  "repository.compare.comparing": "비교 중…",
  "repository.compare.noDifferences": "선택한 refs 사이에 차이가 없습니다.",
  "repository.compare.noMergeBase": "선택한 refs에 공통 이력이 없습니다.",
  "repository.compare.mergeBase": "merge-base",
  "repository.compare.capped": "비교 한도 — 파일 목록이 잘렸습니다.",

  "repository.hunk.diffTruncated": "Diff가 잘림",
};

export const REPOSITORY_MESSAGES = { en: repositoryEn, ko: repositoryKo } as const;
export type RepositoryMessageKey = keyof typeof repositoryEn;

// ═══ translator ══════════════════════════════════════════════════════════════

const translators: Record<ConsoleLocale, Translate<RepositoryMessageKey>> = {
  en: createTranslator(REPOSITORY_MESSAGES, "en"),
  ko: createTranslator(REPOSITORY_MESSAGES, "ko"),
};

export function getT(locale: ConsoleLocale | undefined): Translate<RepositoryMessageKey> {
  return translators[locale ?? "en"];
}

/** toLocaleString / Intl에 넘길 BCP 47 태그 */
export function localeTag(locale: ConsoleLocale | undefined): string {
  return (locale ?? "en") === "ko" ? "ko-KR" : "en-US";
}
