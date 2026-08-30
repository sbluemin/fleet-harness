import fs from "node:fs";

import { beforeEach, describe, expect, it } from "vitest";

import { __resetEntryStatsForTests, knownMtime, knownSize, noteEntryStats } from "../client/entry-stats.js";

import {
  activateDocument,
  activateStoredDocument,
  canNavigateDocumentHistory,
  closeDocument,
  EMPTY_DOC_SESSION,
  getFileExplorerSnapshot,
  markDocStale,
  navigateDocumentHistory,
  setDocViewState,
  setWrapLines,
  type DocSession,
} from "../client/view-store.js";
import { isLoadedDocumentStale, stalePathsAfterRefresh } from "../client/viewer/stale.js";

const doc = (relativePath: string) => ({ relativePath, name: relativePath.split("/").at(-1) ?? relativePath });

function open(paths: readonly string[]): DocSession {
  return paths.reduce((session, path) => activateDocument(session, doc(path)), EMPTY_DOC_SESSION);
}

describe("문서 세션 전이", () => {
  it("활성화는 경로당 칩 하나를 만들고 이력을 쌓는다", () => {
    const session = open(["a.ts", "b.ts", "a.ts"]);
    expect(session.openDocs.map((d) => d.relativePath)).toEqual(["a.ts", "b.ts"]);
    expect(session.activePath).toBe("a.ts");
    expect(session.history).toEqual(["a.ts", "b.ts", "a.ts"]);
    expect(session.historyIndex).toBe(2);
  });

  it("같은 문서 재활성화는 이력을 늘리지 않는다", () => {
    const session = activateDocument(open(["a.ts"]), doc("a.ts"));
    expect(session.history).toEqual(["a.ts"]);
    expect(session.historyIndex).toBe(0);
  });

  it("뒤로 간 뒤 새 문서를 열면 앞쪽 가지를 잘라낸다", () => {
    let session = open(["a.ts", "b.ts", "c.ts"]);
    session = navigateDocumentHistory(session, -1);
    session = navigateDocumentHistory(session, -1);
    expect(session.activePath).toBe("a.ts");
    session = activateDocument(session, doc("d.ts"));
    expect(session.history).toEqual(["a.ts", "d.ts"]);
    expect(canNavigateDocumentHistory(session, 1)).toBe(false);
  });

  it("이력 이동은 경계에서 멈춘다", () => {
    const session = open(["a.ts"]);
    expect(navigateDocumentHistory(session, -1)).toBe(session);
    expect(navigateDocumentHistory(session, 1)).toBe(session);
    expect(canNavigateDocumentHistory(session, -1)).toBe(false);
  });

  it("활성 문서를 닫으면 직전 이력으로 돌아간다", () => {
    let session = open(["a.ts", "b.ts", "c.ts"]);
    session = closeDocument(session, "c.ts");
    expect(session.openDocs.map((d) => d.relativePath)).toEqual(["a.ts", "b.ts"]);
    expect(session.activePath).toBe("b.ts");
    expect(session.history).toEqual(["a.ts", "b.ts"]);
  });

  it("비활성 문서를 닫아도 활성은 유지된다", () => {
    let session = open(["a.ts", "b.ts", "c.ts"]);
    session = closeDocument(session, "a.ts");
    expect(session.activePath).toBe("c.ts");
    expect(session.openDocs.map((d) => d.relativePath)).toEqual(["b.ts", "c.ts"]);
    // a가 빠지며 이력이 접히고, 활성 위치는 여전히 c를 가리킨다.
    expect(session.history[session.historyIndex]).toBe("c.ts");
  });

  it("닫힌 문서를 이력에서 걷어낼 때 연속 중복을 접는다", () => {
    let session = open(["a.ts", "b.ts", "a.ts", "c.ts"]);
    session = closeDocument(session, "b.ts");
    // a,b,a,c 에서 b 제거 → a,a,c → a,c
    expect(session.history).toEqual(["a.ts", "c.ts"]);
    expect(session.activePath).toBe("c.ts");
  });

  it("마지막 문서를 닫으면 세션이 빈 상태로 돌아간다", () => {
    let session = open(["a.ts"]);
    session = closeDocument(session, "a.ts");
    expect(session.openDocs).toHaveLength(0);
    expect(session.activePath).toBeNull();
    expect(session.history).toEqual([]);
    expect(session.historyIndex).toBe(-1);
  });

  it("뒤로 가기는 닫힌 문서를 건너뛴다", () => {
    let session = open(["a.ts", "b.ts", "c.ts"]);
    session = closeDocument(session, "b.ts");
    session = navigateDocumentHistory(session, -1);
    expect(session.activePath).toBe("a.ts");
  });
});

describe("stale document mark", () => {
  it("같은 mtime이면 표시하지 않고 달라지면 표시한다", () => {
    expect(isLoadedDocumentStale(10, 10)).toBe(false);
    expect(isLoadedDocumentStale(10, 11)).toBe(true);
    expect(isLoadedDocumentStale(undefined, 11)).toBe(false);
    expect(isLoadedDocumentStale(10, undefined)).toBe(false);
  });

  it("새로고침된 부모 디렉터리의 열린 문서만 고른다", () => {
    const entries = [
      { name: "a.ts", relativePath: "src/a.ts", kind: "file" as const, mtimeMs: 20 },
      { name: "b.ts", relativePath: "src/b.ts", kind: "file" as const, mtimeMs: 5 },
    ];
    expect(stalePathsAfterRefresh({
      relativeDir: "src",
      entries,
      openPaths: ["src/a.ts", "src/b.ts", "README.md"],
      loadedMtimeByPath: new Map([["src/a.ts", 10], ["src/b.ts", 5], ["README.md", 1]]),
    })).toEqual(["src/a.ts"]);
  });

  it("표시를 세우고 다시 읽으면 지운다", () => {
    const theater = "stale-mark-session";
    activateStoredDocument(theater, { relativePath: "src/a.ts", name: "a.ts" });
    setDocViewState(theater, "src/a.ts", {
      kind: "code",
      relativePath: "src/a.ts",
      content: "old",
      lang: "typescript",
      mtimeMs: 10,
    });
    markDocStale(theater, "src/a.ts", true);
    expect(getFileExplorerSnapshot(theater).docStates.get("src/a.ts")).toMatchObject({ stale: true, content: "old" });
    setDocViewState(theater, "src/a.ts", {
      kind: "code",
      relativePath: "src/a.ts",
      content: "new",
      lang: "typescript",
      mtimeMs: 20,
      stale: false,
    });
    expect(getFileExplorerSnapshot(theater).docStates.get("src/a.ts")).toMatchObject({ stale: false, content: "new", mtimeMs: 20 });
  });
});

describe("wrap toggle persistence", () => {
  it("세션 동안 wrap 선택을 기억한다", () => {
    setWrapLines(false);
    expect(getFileExplorerSnapshot("wrap-session").wrapLines).toBe(false);
    setWrapLines(true);
    expect(getFileExplorerSnapshot("wrap-session").wrapLines).toBe(true);
    expect(getFileExplorerSnapshot("other-theater").wrapLines).toBe(true);
    setWrapLines(false);
    expect(getFileExplorerSnapshot("wrap-session").wrapLines).toBe(false);
  });
});

describe("낡음 표식 도달 범위", () => {
  const entry = (relativePath: string, mtimeMs?: number) => ({
    name: relativePath.split("/").at(-1) ?? relativePath,
    relativePath,
    kind: "file" as const,
    ...(mtimeMs === undefined ? {} : { mtimeMs }),
  });

  it("사라진 파일도 낡음으로 본다", () => {
    // 삭제·이름 변경된 파일을 "최신"이라 말하면 없는 경로의 내용을 표식 없이 계속 보여준다.
    const stale = stalePathsAfterRefresh({
      relativeDir: "docs",
      entries: [entry("docs/other.md", 10)],
      openPaths: ["docs/gone.md"],
      loadedMtimeByPath: new Map([["docs/gone.md", 10]]),
    });
    expect(stale).toEqual(["docs/gone.md"]);
  });

  it("잘린 목록에서는 행이 없다고 사라졌다고 하지 않는다", () => {
    const stale = stalePathsAfterRefresh({
      relativeDir: "docs",
      entries: [entry("docs/other.md", 10)],
      openPaths: ["docs/maybe.md"],
      loadedMtimeByPath: new Map([["docs/maybe.md", 10]]),
      truncated: true,
    });
    expect(stale).toEqual([]);
  });

  it("mtime이 바뀐 파일은 여전히 낡음이다", () => {
    const stale = stalePathsAfterRefresh({
      relativeDir: "docs",
      entries: [entry("docs/a.md", 20)],
      openPaths: ["docs/a.md"],
      loadedMtimeByPath: new Map([["docs/a.md", 10]]),
    });
    expect(stale).toEqual(["docs/a.md"]);
  });
});

describe("검색·복원으로 연 문서의 mtime 심기", () => {
  it("mtime 없이 열린 문서에 목록이 알려 준 mtime을 심는다", () => {
    const source = fs.readFileSync(new URL("../client/rail-panel.tsx", import.meta.url), "utf8");
    expect(source).toContain("seedDocMtime(contextScope, doc.relativePath, known)");
    const store = fs.readFileSync(new URL("../client/view-store.ts", import.meta.url), "utf8");
    // 이미 mtime이 있는 문서를 덮으면 낡음 판정이 리셋된다.
    expect(store).toContain("if (viewState.mtimeMs !== undefined) return;");
  });
});

describe("낡음 기준선의 소유권", () => {
  beforeEach(() => { __resetEntryStatsForTests(); });

  it("한 Theater의 mtime은 다른 Theater의 같은 이름 파일에 실리지 않는다", () => {
    // 트리와 문서 창이 갈라지면서 이 캐시는 컴포넌트 ref에서 모듈 스토어로 나왔다.
    // 경로 공간이 Theater마다 다르므로, 한 통에 담으면 A의 foo.png mtime이 B의 같은 이름
    // 파일에 실려 바뀌지도 않은 문서를 낡음으로 표시한다.
    noteEntryStats("theater-a", [{ relativePath: "foo.png", mtimeMs: 111, sizeBytes: 10 }]);

    expect(knownMtime("theater-a", "foo.png")).toBe(111);
    expect(knownMtime("theater-b", "foo.png")).toBeUndefined();
    expect(knownSize("theater-b", "foo.png")).toBeUndefined();
  });

  it("Theater를 모르면 아무것도 기억하지 않는다", () => {
    noteEntryStats(null, [{ relativePath: "foo.png", mtimeMs: 111 }]);
    expect(knownMtime(null, "foo.png")).toBeUndefined();
  });

  it("기준 mtime 없이 여는 이미지는 여는 시점에 부모 목록으로 기준을 잡는다", () => {
    const source = fs.readFileSync(new URL("../client/doc-loader.ts", import.meta.url), "utf8");
    // 첫 목록이 "이미 바뀐 뒤"의 값이면 그 변경을 영영 놓친다.
    expect(source).toContain("if (knownMtime(theaterId, relativePath) === undefined)");
    expect(source).toContain("listFolder(parentDirOf(relativePath))");
  });
});
