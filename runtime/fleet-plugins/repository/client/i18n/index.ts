import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import { createTranslator } from "@fleet-console/sdk/i18n/translate";

// ═══ messages ════════════════════════════════════════════════════════════════

const repositoryEn = {
  // panel / identity
  "repository.panel.title": "Repository",
  "repository.feedback.ready": "Local working tree · Fetch updates remote-tracking branches",
  "repository.context.choose": "Choose repository or worktree",
  "repository.context.empty": "No repositories found. Try scanning deeper.",
  "repository.source.aria": "Repository views",
  "repository.refs.search": "Find branches, tags, stashes",
  "repository.refs.noMatching": "No matching refs",
  "repository.refs.empty": "No refs",
  "repository.staging.cleanTitle": "No changes to commit",
  "repository.staging.cleanHint": "Changes appear here when you edit files. Browse History to review earlier work.",
  "repository.staging.viewHistory": "View History",
  "repository.staging.editLastCommit": "Edit last commit",
  "repository.staging.amendChecking": "Checking the commit for this Amend draft…",
  "repository.staging.amendHeadChanged": "HEAD changed since this Amend draft. Your message is preserved. Turn Amend off, review History, then select Amend again if you want to edit the current commit.",
  "repository.sync.button": "Fetch",
  "repository.sync.title": "Update remote-tracking branches",

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
  "repository.common.reloadState": "Reload repository state",

  // read failures — a code is not a sentence; every one of these names the failure and the next move
  "repository.read.failedGit": "Git couldn't finish this read. Try again.",
  "repository.read.failedNoRepo": "This folder is not a git repository.",
  "repository.read.failedGitMissing": "Git isn't available here. Install git, then try again.",
  "repository.read.failedUnknownRef": "That commit or ref is no longer in this repository.",
  "repository.read.failedFileMissing": "That file is not part of this commit.",
  "repository.read.failedNoTheater": "No project is open in this panel.",
  "repository.read.failedTimeout": "The read timed out. Try again.",
  "repository.read.failedUnknown": "Something went wrong reading this repository. Try again.",

  // disclosed caps
  "repository.status.capped": "Only the first {count} changed files are listed.",
  "repository.commit.capped": "Some of this commit's data was cut off.",
  "repository.scan.limitReached": "scan limit reached",
  "repository.guard.stateUnknown": "Repository state could not be read — reload before writing.",

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
  "repository.history.remoteTracked": "Remote tracked",
  "repository.history.resizeDock": "Resize commit detail dock",
  "repository.history.resizeFileList": "Resize file list",
  "repository.history.resizeLog": "Resize commit log",
  "repository.history.hasBody": "Has a commit message body",
  "repository.history.orderToggle": "Switch commit order",
  "repository.history.orderTopo": "topo",
  "repository.history.orderDate": "date",
  "repository.history.orderTopoHint": "Topological order — branch chains stay contiguous. Click for date order.",
  "repository.history.orderDateHint": "Date order — every ref interleaved newest first. Click for topological order.",

  // time
  "repository.time.today": "Today {time}",
  "repository.time.yesterday": "Yesterday {time}",

  // compare
  "repository.compare.swap": "Swap base and head",
  "repository.compare.resultsAnnounce": "Comparison finished — {count} files",
  "repository.compare.comparing": "Comparing…",
  "repository.compare.noDifferences": "No differences between the selected refs.",
  "repository.compare.noMergeBase": "The selected refs share no common history.",
  "repository.compare.mergeBase": "merge-base",
  "repository.compare.capped": "Comparison capped — file list truncated.",
  "repository.compare.withBase": "Compare with base",
  "repository.compare.withCurrent": "Compare with current branch",

  // in-history compare (anchor grammar)
  "repository.compare.pinAction": "Compare with another commit…",
  "repository.compare.pinRow": "Pin {short} as compare base",
  "repository.compare.completeRow": "Compare {short} with base {base}",
  "repository.compare.unpinRow": "Unpin compare base {short}",
  "repository.compare.pinnedChip": "base {short}",
  "repository.compare.pinnedHint": "Shift-click or ⇆ picks the second commit",
  "repository.compare.closeCompare": "Close comparison",
  "repository.compare.resultTitle": "Changes in {head} since the common ancestor with {base}",
  "repository.compare.announcePinned": "Pinned {short} as compare base. Choose the second commit.",
  "repository.compare.announceUnpinned": "Compare base unpinned.",
  "repository.compare.announceResult": "Comparing {base} with {head}.",

  // checkout containment labeling
  "repository.history.offHead": "Not in current checkout",
  "repository.history.countLegend": "All refs · dimmed = not in current checkout",

  // sync outcome surfacing (manual sync only; auto sync stays silent)
  "repository.sync.failedAuth": "Fetch failed — authentication. Check your credentials for the remote.",
  "repository.sync.failedNetwork": "Fetch failed — network. The remote is unreachable.",
  "repository.sync.failedTimeout": "Fetch failed — timed out.",
  "repository.sync.failedNoRemote": "Fetch failed — no remote is configured.",
  "repository.sync.failedGit": "Fetch failed — git error.",
  "repository.sync.summary": "Fetched — {newRefs} new · {updatedRefs} updated · {pruned} pruned",
  "repository.sync.upToDate": "No new commits on the remote",
  "repository.sync.dismiss": "Dismiss",
  "repository.sync.lastFailed": "Last fetch failed",

  // hunk
  "repository.hunk.diffTruncated": "Diff truncated",
  "repository.hunk.close": "Close this diff",

  // checkout tabs
  "repository.tabs.aria": "Checkouts",
  "repository.tabs.worktreeMark": "worktree",

  // toolbar verbs
  "repository.verb.pull": "Pull",
  "repository.verb.pullTitle": "Fast-forward the current branch from its upstream",
  "repository.verb.push": "Push",
  "repository.verb.pushTitle": "Push the current branch to its upstream",
  "repository.verb.stash": "Stash",
  "repository.verb.stashTitle": "Stash all working changes, untracked files included",
  "repository.verb.behindCount": "{count} behind",
  "repository.verb.aheadCount": "{count} ahead",
  "repository.verb.pulledCount_one": "1 commit in",
  "repository.verb.pulledCount_other": "{count} commits in",
  "repository.verb.pushedCount_one": "1 commit out",
  "repository.verb.pushedCount_other": "{count} commits out",
  "repository.verb.upToDate": "Already up to date",
  "repository.verb.pulledResult": "Pulled",
  "repository.verb.pushedResult": "Pushed",
  "repository.verb.stashedResult": "Stashed",
  "repository.verb.lastFailed": "Last attempt failed",
  "repository.verb.failedAuth": "Authentication failed — check your credentials for the remote.",
  "repository.verb.failedNetwork": "The remote is unreachable — check your network.",
  "repository.verb.failedTimeout": "The remote operation timed out.",
  "repository.verb.failedNoRemote": "No remote is configured for this repository.",
  "repository.verb.failedNonFastForward": "The remote has commits you don't have yet. Pull first, then push.",
  "repository.verb.failedPullDiverged": "The branches have diverged — resolve in a terminal (merge or rebase), then pull again.",
  "repository.verb.failedDirtyWorktree": "Local changes are in the way. Commit or stash them, then pull again.",
  "repository.verb.failedDetachedHead": "Detached HEAD — check out a branch first.",
  "repository.verb.failedNoUpstream": "This branch has no upstream to pull from.",
  "repository.verb.failedNothingToStash": "There are no working changes to stash.",
  "repository.verb.failedStashConflict": "Applying the stash hit conflicts — resolve them in a terminal.",

  // write guards
  "repository.guard.indexLocked": "The index is locked — another process is writing to this repository.",
  "repository.guard.merge": "A merge is in progress — finish or abort it in a terminal before using write actions.",
  "repository.guard.rebase": "A rebase is in progress — finish or abort it in a terminal before using write actions.",
  "repository.guard.cherryPick": "A cherry-pick is in progress — finish or abort it in a terminal before using write actions.",
  "repository.guard.stationed_one": "Operation “{title}” is stationed in this checkout — its own commits can interleave with yours.",
  "repository.guard.stationed_other": "{count} Operations are stationed in this checkout — their commits can interleave with yours.",

  // staging (Local Changes)
  "repository.staging.unstaged": "UNSTAGED",
  "repository.staging.staged": "STAGED",
  "repository.staging.stageAll": "Stage all",
  "repository.staging.unstageAll": "Unstage all",
  "repository.staging.stageFile": "Stage {path}",
  "repository.staging.unstageFile": "Unstage {path}",
  "repository.staging.discardFile": "Discard changes in {path}",
  "repository.staging.deleteUntracked": "Delete {path} — it is not tracked yet",
  "repository.staging.deleteArm": "Delete?",
  "repository.staging.discardArm": "Sure?",
  "repository.staging.emptyUnstaged": "No unstaged changes",
  "repository.staging.emptyStaged": "Nothing staged yet",
  "repository.staging.conflict": "conflict",
  "repository.staging.subjectPlaceholder": "Commit subject",
  "repository.staging.bodyPlaceholder": "Description (optional)",
  "repository.staging.amend": "Amend",
  "repository.staging.commit_one": "Commit {count} file",
  "repository.staging.commit_other": "Commit {count} files",
  "repository.staging.commitAmend": "Amend commit",
  "repository.staging.committed": "Committed {sha}",
  "repository.staging.failedIdentity": "Git doesn't know who you are here. Set user.name and user.email, then commit again.",
  "repository.staging.failedNothingToCommit": "Nothing is staged to commit.",
  "repository.staging.selectFile": "Select a file to see its changes",

  // stash rows
  "repository.stash.apply": "Apply",
  "repository.stash.pop": "Apply and remove",
  "repository.stash.drop": "Delete stash",
  "repository.stash.dropArm": "Delete?",
  "repository.stash.applied": "Stash applied",
  "repository.stash.popped": "Stash popped",
  "repository.stash.dropped": "Stash dropped",
  "repository.stash.moved": "The stash list changed since you opened this menu. Nothing was touched — check the list and try again.",

  // stash inspector card
  "repository.stash.cardTitle": "Stashed changes",
  "repository.stash.cardFiles": "Stashed files",
  "repository.stash.showFailed": "Could not read this stash's files.",
  "repository.stash.savePrompt": "Stash message",
  "repository.stash.savePlaceholder": "Leave empty for the automatic message",
  "repository.stash.saveConfirm": "Stash",
  "repository.stash.saveCancel": "Cancel",

  // workspace dock peek chip
  "repository.dock.peekCommit": "Viewing commit",
  "repository.dock.peekCompare": "Viewing comparison",
  "repository.dock.peekStash": "Viewing stash",
  "repository.dock.peekReturn": "Back to History",
  "repository.dock.peekClose": "Stop viewing",

  // staging row action labels
  "repository.staging.actionStage": "Stage",
  "repository.staging.actionUnstage": "Unstage",
  "repository.staging.actionDiscard": "Discard",
  "repository.staging.actionDelete": "Delete",

  // commit file tree
  "repository.filetree.tab": "File Tree",
  "repository.filetree.loading": "Loading tree…",
  "repository.filetree.empty": "Empty folder",
  "repository.filetree.error": "Unable to load this folder",
  "repository.filetree.hint": "Files changed in this commit are marked; select one to open its diff.",
} as const;

const repositoryKo: Record<keyof typeof repositoryEn, string> = {
  "repository.panel.title": "저장소",
  "repository.feedback.ready": "로컬 작업 트리 · Fetch로 원격 추적 정보를 갱신합니다",
  "repository.context.choose": "저장소·워크트리 선택",
  "repository.context.empty": "발견한 저장소가 없습니다. 탐색 깊이를 늘려 보세요.",
  "repository.source.aria": "저장소 작업 보기",
  "repository.refs.search": "브랜치·태그·스태시 찾기",
  "repository.refs.noMatching": "일치하는 참조가 없습니다",
  "repository.refs.empty": "참조가 없습니다",
  "repository.staging.cleanTitle": "커밋할 변경이 없습니다",
  "repository.staging.cleanHint": "파일을 수정하면 여기에 나타납니다. 이전 작업은 기록에서 확인하세요.",
  "repository.staging.viewHistory": "기록 보기",
  "repository.staging.editLastCommit": "마지막 커밋 수정",
  "repository.staging.amendChecking": "Amend 초안의 대상 커밋을 확인하고 있습니다…",
  "repository.staging.amendHeadChanged": "Amend 초안을 작성한 뒤 HEAD가 바뀌었습니다. 메시지는 보존했습니다. Amend를 끄고 기록을 확인한 뒤, 현재 커밋을 수정하려면 Amend를 다시 선택하세요.",
  "repository.sync.button": "Fetch",
  "repository.sync.title": "원격 추적 브랜치를 갱신합니다",

  "repository.section.context": "컨텍스트",
  "repository.section.working": "작업",
  "repository.section.worktrees": "워크트리",
  "repository.section.branches": "브랜치",
  "repository.section.tags": "태그",
  "repository.section.stashes": "스태시",

  "repository.source.history": "기록",
  "repository.source.changes": "변경",

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
  "repository.common.reloadState": "저장소 상태 새로 읽기",

  "repository.read.failedGit": "Git이 이 읽기를 끝내지 못했습니다. 다시 시도하세요.",
  "repository.read.failedNoRepo": "이 폴더는 git 저장소가 아닙니다.",
  "repository.read.failedGitMissing": "이 컴퓨터에서 git을 찾을 수 없습니다. git을 설치한 뒤 다시 시도하세요.",
  "repository.read.failedUnknownRef": "그 커밋 또는 ref가 이 저장소에 더 이상 없습니다.",
  "repository.read.failedFileMissing": "그 파일은 이 커밋에 없습니다.",
  "repository.read.failedNoTheater": "이 패널에 열린 프로젝트가 없습니다.",
  "repository.read.failedTimeout": "읽기가 시간 초과됐습니다. 다시 시도하세요.",
  "repository.read.failedUnknown": "저장소를 읽는 중 문제가 발생했습니다. 다시 시도하세요.",

  "repository.status.capped": "변경 파일 중 앞의 {count}개만 표시됩니다.",
  "repository.commit.capped": "이 커밋의 데이터 일부가 잘렸습니다.",
  "repository.scan.limitReached": "탐색 한도 도달",
  "repository.guard.stateUnknown": "저장소 상태를 읽지 못했습니다 — 쓰기 전에 새로 읽으세요.",

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
  "repository.history.remoteTracked": "원격 추적됨",
  "repository.history.resizeDock": "커밋 상세 독 크기 조절",
  "repository.history.resizeFileList": "파일 목록 크기 조절",
  "repository.history.resizeLog": "커밋 로그 크기 조절",
  "repository.history.hasBody": "커밋 메시지 본문이 있음",
  "repository.history.orderToggle": "커밋 정렬 전환",
  "repository.history.orderTopo": "계보순",
  "repository.history.orderDate": "시간순",
  "repository.history.orderTopoHint": "계보순 — 브랜치 체인이 끊기지 않고 이어집니다. 누르면 시간순으로 전환합니다.",
  "repository.history.orderDateHint": "시간순 — 모든 ref를 최신 커밋부터 뒤섞어 나열합니다. 누르면 계보순으로 전환합니다.",

  "repository.time.today": "오늘 {time}",
  "repository.time.yesterday": "어제 {time}",

  "repository.compare.swap": "base와 head 교환",
  "repository.compare.resultsAnnounce": "비교 완료 — 파일 {count}개",
  "repository.compare.comparing": "비교 중…",
  "repository.compare.noDifferences": "선택한 refs 사이에 차이가 없습니다.",
  "repository.compare.noMergeBase": "선택한 refs에 공통 이력이 없습니다.",
  "repository.compare.mergeBase": "merge-base",
  "repository.compare.capped": "비교 한도 — 파일 목록이 잘렸습니다.",
  "repository.compare.withBase": "베이스와 비교",
  "repository.compare.withCurrent": "현재 브랜치와 비교",

  "repository.compare.pinAction": "다른 커밋과 비교…",
  "repository.compare.pinRow": "{short}를 비교 기준으로 고정",
  "repository.compare.completeRow": "기준 {base}와(과) {short} 비교",
  "repository.compare.unpinRow": "비교 기준 {short} 고정 해제",
  "repository.compare.pinnedChip": "기준 {short}",
  "repository.compare.pinnedHint": "Shift-클릭 또는 ⇆로 두 번째 커밋을 선택하세요",
  "repository.compare.closeCompare": "비교 닫기",
  "repository.compare.resultTitle": "{base}와(과)의 공통 조상 이후 {head}의 변경",
  "repository.compare.announcePinned": "{short}를 비교 기준으로 고정했습니다. 두 번째 커밋을 선택하세요.",
  "repository.compare.announceUnpinned": "비교 기준 고정을 해제했습니다.",
  "repository.compare.announceResult": "{base}와(과) {head}를 비교합니다.",

  "repository.history.offHead": "현재 체크아웃에 포함되지 않음",
  "repository.history.countLegend": "모든 ref 기록 · 흐림 = 체크아웃 미포함",

  "repository.sync.failedAuth": "가져오기 실패 — 인증. 원격 자격 증명을 확인하세요.",
  "repository.sync.failedNetwork": "가져오기 실패 — 네트워크. 원격에 연결할 수 없습니다.",
  "repository.sync.failedTimeout": "가져오기 실패 — 시간 초과.",
  "repository.sync.failedNoRemote": "가져오기 실패 — 설정된 remote가 없습니다.",
  "repository.sync.failedGit": "가져오기 실패 — git 오류.",
  "repository.sync.summary": "가져오기 완료 — 신규 {newRefs} · 갱신 {updatedRefs} · 정리 {pruned}",
  "repository.sync.upToDate": "원격에 새 커밋 없음",
  "repository.sync.dismiss": "닫기",
  "repository.sync.lastFailed": "마지막 가져오기 실패",

  "repository.hunk.diffTruncated": "Diff가 잘림",
  "repository.hunk.close": "이 diff 닫기",

  "repository.tabs.aria": "체크아웃",
  "repository.tabs.worktreeMark": "워크트리",

  "repository.verb.pull": "Pull",
  "repository.verb.pullTitle": "현재 브랜치를 upstream에서 fast-forward",
  "repository.verb.push": "Push",
  "repository.verb.pushTitle": "현재 브랜치를 upstream으로 push",
  "repository.verb.stash": "Stash",
  "repository.verb.stashTitle": "미추적 파일까지 작업 중 변경 전체를 스태시",
  "repository.verb.behindCount": "{count} 뒤처짐",
  "repository.verb.aheadCount": "{count} 앞섬",
  "repository.verb.pulledCount_one": "커밋 1개 받음",
  "repository.verb.pulledCount_other": "커밋 {count}개 받음",
  "repository.verb.pushedCount_one": "커밋 1개 보냄",
  "repository.verb.pushedCount_other": "커밋 {count}개 보냄",
  "repository.verb.upToDate": "이미 최신 상태",
  "repository.verb.pulledResult": "pull 완료",
  "repository.verb.pushedResult": "push 완료",
  "repository.verb.stashedResult": "스태시함",
  "repository.verb.lastFailed": "마지막 시도 실패",
  "repository.verb.failedAuth": "인증에 실패했습니다 — remote 자격 증명을 확인하세요.",
  "repository.verb.failedNetwork": "remote에 연결할 수 없습니다 — 네트워크를 확인하세요.",
  "repository.verb.failedTimeout": "원격 작업이 시간 초과됐습니다.",
  "repository.verb.failedNoRemote": "이 저장소에 설정된 remote가 없습니다.",
  "repository.verb.failedNonFastForward": "원격에 아직 없는 커밋이 있습니다. 먼저 pull한 뒤 push하세요.",
  "repository.verb.failedPullDiverged": "브랜치가 갈라졌습니다 — 터미널에서 merge 또는 rebase로 정리한 뒤 다시 pull하세요.",
  "repository.verb.failedDirtyWorktree": "로컬 변경이 가로막고 있습니다. 커밋하거나 스태시한 뒤 다시 pull하세요.",
  "repository.verb.failedDetachedHead": "Detached HEAD 상태입니다 — 먼저 브랜치를 체크아웃하세요.",
  "repository.verb.failedNoUpstream": "이 브랜치에는 pull할 upstream이 없습니다.",
  "repository.verb.failedNothingToStash": "스태시할 작업 중 변경이 없습니다.",
  "repository.verb.failedStashConflict": "스태시 적용이 충돌했습니다 — 터미널에서 해결하세요.",

  "repository.guard.indexLocked": "인덱스가 잠겨 있습니다 — 다른 프로세스가 이 저장소에 쓰는 중입니다.",
  "repository.guard.merge": "병합이 진행 중입니다 — 터미널에서 끝내거나 중단한 뒤 쓰기 동작을 사용하세요.",
  "repository.guard.rebase": "리베이스가 진행 중입니다 — 터미널에서 끝내거나 중단한 뒤 쓰기 동작을 사용하세요.",
  "repository.guard.cherryPick": "체리픽이 진행 중입니다 — 터미널에서 끝내거나 중단한 뒤 쓰기 동작을 사용하세요.",
  "repository.guard.stationed_one": "Operation “{title}”이(가) 이 체크아웃에 주둔 중입니다 — 그쪽 커밋이 내 커밋과 섞일 수 있습니다.",
  "repository.guard.stationed_other": "Operation {count}개가 이 체크아웃에 주둔 중입니다 — 그쪽 커밋이 내 커밋과 섞일 수 있습니다.",

  "repository.staging.unstaged": "미스테이지",
  "repository.staging.staged": "스테이지됨",
  "repository.staging.stageAll": "모두 스테이지",
  "repository.staging.unstageAll": "모두 내리기",
  "repository.staging.stageFile": "{path} 스테이지",
  "repository.staging.unstageFile": "{path} 스테이지 해제",
  "repository.staging.discardFile": "{path}의 변경 버리기",
  "repository.staging.deleteUntracked": "{path} 삭제 — 아직 추적되지 않는 파일입니다",
  "repository.staging.deleteArm": "삭제할까요?",
  "repository.staging.discardArm": "정말요?",
  "repository.staging.emptyUnstaged": "미스테이지 변경 없음",
  "repository.staging.emptyStaged": "아직 스테이지된 것이 없습니다",
  "repository.staging.conflict": "충돌",
  "repository.staging.subjectPlaceholder": "커밋 제목",
  "repository.staging.bodyPlaceholder": "설명 (선택)",
  "repository.staging.amend": "Amend",
  "repository.staging.commit_one": "{count}개 파일 커밋",
  "repository.staging.commit_other": "{count}개 파일 커밋",
  "repository.staging.commitAmend": "커밋 수정(amend)",
  "repository.staging.committed": "{sha} 커밋됨",
  "repository.staging.failedIdentity": "이 저장소에 Git 사용자 정보가 없습니다. user.name과 user.email을 설정한 뒤 다시 커밋하세요.",
  "repository.staging.failedNothingToCommit": "커밋할 스테이지된 변경이 없습니다.",
  "repository.staging.selectFile": "파일을 선택하면 변경 내용이 보입니다",

  "repository.stash.apply": "적용",
  "repository.stash.pop": "적용 후 제거",
  "repository.stash.drop": "삭제",
  "repository.stash.dropArm": "삭제할까요?",
  "repository.stash.applied": "스태시 적용됨",
  "repository.stash.popped": "스태시 적용 후 제거됨",
  "repository.stash.dropped": "스태시 삭제됨",
  "repository.stash.moved": "메뉴를 연 뒤 스태시 목록이 바뀌었습니다. 아무것도 건드리지 않았습니다 — 목록을 확인하고 다시 시도하세요.",
  "repository.stash.cardTitle": "치워 둔 변경",
  "repository.stash.cardFiles": "치워 둔 파일",
  "repository.stash.showFailed": "이 스태시의 파일을 읽지 못했습니다.",
  "repository.stash.savePrompt": "스태시 메시지",
  "repository.stash.savePlaceholder": "비워 두면 자동 문구로 저장됩니다",
  "repository.stash.saveConfirm": "스태시",
  "repository.stash.saveCancel": "취소",
  "repository.dock.peekCommit": "보던 커밋",
  "repository.dock.peekCompare": "보던 비교",
  "repository.dock.peekStash": "보던 스태시",
  "repository.dock.peekReturn": "기록으로",
  "repository.dock.peekClose": "그만 보기",
  "repository.staging.actionStage": "스테이지",
  "repository.staging.actionUnstage": "내리기",
  "repository.staging.actionDiscard": "버리기",
  "repository.staging.actionDelete": "삭제",

  "repository.filetree.tab": "파일 트리",
  "repository.filetree.loading": "트리 불러오는 중…",
  "repository.filetree.empty": "빈 폴더",
  "repository.filetree.error": "이 폴더를 불러올 수 없습니다",
  "repository.filetree.hint": "이 커밋에서 바뀐 파일에 표시가 붙습니다. 선택하면 diff가 열립니다.",
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

/**
 * 서버 오류 코드를 사람이 읽을 문장으로 옮긴다. 코드는 화면에 나오지 않는다 — verb 경로가 이미
 * 이 규칙을 지키고 있었고(repository.verb.failed*), 읽기 경로만 raw 코드를 그대로 그리고 있었다.
 */
export function readErrorSentence(t: Translate<RepositoryMessageKey>, code: string): string {
  switch (code) {
    case "no_git_repo": return t("repository.read.failedNoRepo");
    case "git_unavailable": return t("repository.read.failedGitMissing");
    case "unknown_ref":
    case "invalid_ref":
    case "unknown_commit": return t("repository.read.failedUnknownRef");
    case "file_not_found":
    case "unknown_path": return t("repository.read.failedFileMissing");
    case "no_theater": return t("repository.read.failedNoTheater");
    case "timeout":
    case "git_timeout": return t("repository.read.failedTimeout");
    case "git_failed": return t("repository.read.failedGit");
    default: return t("repository.read.failedUnknown");
  }
}

/** toLocaleString / Intl에 넘길 BCP 47 태그 */
export function localeTag(locale: ConsoleLocale | undefined): string {
  return (locale ?? "en") === "ko" ? "ko-KR" : "en-US";
}
