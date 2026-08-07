import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseConsoleReleaseNotes } from "../core/host/release-notes/release-notes.js";

// CHANGELOG.md는 파일이 아니라 배포된 Console이 네트워크로 읽는 와이어 포맷이다. 컴파일러가 쓰는 문법과
// 이 리더가 읽는 문법이 갈라지면 항목이 오류 없이 사라지므로, 실제 컴파일러 출력을 이 파서에 다시 통과시킨다.
// 픽스처 문자열을 손으로 적으면 둘이 갈라져도 테스트는 계속 통과하기 때문에 컴파일러를 직접 실행한다.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const COMPILER = path.join(REPO_ROOT, "scripts/compile-changelog-fragments.mjs");

const FRAGMENT = `---
branch: feat/roundtrip-check
---

### fleet-cli
#### Breaking Changes
- Launch Claude Code as a native child process.
  ko: Claude Code를 네이티브 자식 프로세스로 실행합니다.

### fleet-console
#### Added
- Add a Wire log toggle to AI Gateway settings.
  ko: AI Gateway 설정에 와이어 로그 토글을 추가합니다.
#### Fixed
- Restore side bar resize in War Room mode.
  ko: War Room 모드의 사이드바 폭 조절을 복구합니다.

### fleet-desktop
#### Fixed
- Trust the OS certificate store in managed Node processes.
  ko: 관리 Node 프로세스가 OS 인증서 저장소를 신뢰합니다.
`;

function compileDryRun(): { english: string; korean: string } {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-changelog-roundtrip-"));
  try {
    fs.mkdirSync(path.join(fixture, ".changelog.d"));
    fs.writeFileSync(path.join(fixture, ".changelog.d", "feat-roundtrip-check.md"), FRAGMENT);
    const stdout = execFileSync(process.execPath, [COMPILER, "--dry-run", "--version", "9.9.9", "--date", "2026-08-10"], {
      cwd: fixture,
      encoding: "utf8",
    });
    const [, english = "", korean = ""] = /^=== CHANGELOG\.md ===\n([\s\S]*?)\n\n=== CHANGELOG\.ko\.md ===\n([\s\S]*)$/.exec(stdout) ?? [];
    return { english, korean };
  } finally {
    fs.rmSync(fixture, { force: true, recursive: true });
  }
}

describe("compiled release notes round-trip through the Console parser", () => {
  it("stamps every compiled bullet with the runtime heading it was written under", () => {
    const notes = parseConsoleReleaseNotes(compileDryRun().english);

    expect(notes).toHaveLength(1);
    expect(notes[0]?.version).toBe("9.9.9");
    expect(notes[0]?.date).toBe("2026-08-10");
    expect(notes[0]?.sections).toEqual([
      {
        heading: "Added",
        items: [{ packageTags: [], text: "Add a Wire log toggle to AI Gateway settings.", product: "fleet-console" }],
      },
      {
        heading: "Fixed",
        items: [
          { packageTags: [], text: "Restore side bar resize in War Room mode.", product: "fleet-console" },
          { packageTags: [], text: "Trust the OS certificate store in managed Node processes.", product: "fleet-desktop" },
        ],
      },
      {
        heading: "Breaking Changes",
        items: [{ packageTags: [], text: "Launch Claude Code as a native child process.", product: "fleet-cli" }],
      },
    ]);
  });

  it("keeps the Korean document structurally identical so the overlay never falls back", () => {
    const { english, korean } = compileDryRun();
    const englishNotes = parseConsoleReleaseNotes(english);
    const koreanNotes = parseConsoleReleaseNotes(korean);

    expect(koreanNotes).toHaveLength(englishNotes.length);
    expect(koreanNotes[0]?.date).toBe(englishNotes[0]?.date);
    expect(koreanNotes[0]?.sections.map((section) => ({
      heading: section.heading,
      items: section.items.map((item) => ({ packageTags: item.packageTags, product: item.product })),
    }))).toEqual(englishNotes[0]?.sections.map((section) => ({
      heading: section.heading,
      items: section.items.map((item) => ({ packageTags: item.packageTags, product: item.product })),
    })));
    expect(koreanNotes[0]?.sections[0]?.items[0]?.text).toBe("AI Gateway 설정에 와이어 로그 토글을 추가합니다.");
  });
});
