import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

// ─── constants ───────────────────────────────────────────────────────────────

/** frontmatter는 파일 머리에만 있다 — 전체를 읽으면 큰 SKILL.md 하나가 목록 응답을 인질로 잡는다. */
const HEAD_BYTES = 8192;
/** 카드는 두 줄만 보여 주지만, DTO가 병적으로 긴 값을 그대로 나르지는 않게 상한을 둔다. */
const MAX_DESCRIPTION = 500;

// ─── functions ───────────────────────────────────────────────────────────────

/**
 * SKILL.md YAML frontmatter에서 description 한 줄을 뽑는다.
 *
 * 마크다운 번들(@fleet-console/markdown)은 브라우저 대상이라 서버에서 끌어오지 않는다 —
 * 여기 필요한 건 파서 전체가 아니라 "구분자 사이의 key: value" 하나다. 지원 형태는
 * 단일 라인, 따옴표로 감싼 라인, 그리고 이어지는 들여쓰기 줄(폴드)까지다. 그 밖의 YAML
 * (블록 스칼라 `>`/`|`, 앵커, 배열)은 값이 아니라 undefined로 떨어진다 — 잘못 읽은 설명을
 * 카드에 싣느니 설명 없는 카드가 낫다.
 */
export function parseSkillDescription(head: string): string | undefined {
  const text = head.charCodeAt(0) === 0xfeff ? head.slice(1) : head;
  if (!/^---\r?\n/.test(text)) return undefined;

  const body = text.slice(text.indexOf("\n") + 1);
  const endIndex = body.search(/^---\s*$/m);
  // 닫는 구분자가 head 안에 없으면 frontmatter가 잘렸다는 뜻이다 — 자른 조각을 값으로 믿지 않는다.
  if (endIndex === -1) return undefined;

  const lines = body.slice(0, endIndex).split(/\r?\n/);
  const startLine = lines.findIndex((line) => /^description\s*:/.test(line));
  if (startLine === -1) return undefined;

  const first = (lines[startLine] ?? "").replace(/^description\s*:\s*/, "");
  // 블록 스칼라는 이 파서의 지원 범위 밖이다.
  if (/^[>|]/.test(first.trim())) return undefined;

  const parts = [first.trim()];
  for (let i = startLine + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!/^\s+\S/.test(line)) break;
    parts.push(line.trim());
  }

  let value = parts.filter(Boolean).join(" ").trim();
  if (
    (value.startsWith("\"") && value.endsWith("\"") && value.length > 1)
    || (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  ) {
    value = value.slice(1, -1).trim();
  }
  if (!value) return undefined;

  return value.length > MAX_DESCRIPTION ? value.slice(0, MAX_DESCRIPTION) : value;
}

/**
 * 설치된 스킬 디렉터리에서 SKILL.md 머리만 읽어 description을 얻는다.
 *
 * CLI가 보고한 경로라도 신뢰하지 않는다 — handleInstalledFile과 같은 realpath 봉쇄를 거쳐
 * scope의 정당한 상위 경계(project=Theater 루트, global=홈) 안에 있을 때만 읽는다.
 * 어떤 실패도 던지지 않는다: 설명은 목록의 장식이지 목록의 조건이 아니다.
 */
export async function readSkillDescription(
  skillRoot: string,
  allowedRoot: string,
): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    const [realAllowedRoot, realRoot] = await Promise.all([
      fs.realpath(allowedRoot),
      fs.realpath(skillRoot),
    ]);
    if (realRoot !== realAllowedRoot && !realRoot.startsWith(realAllowedRoot + path.sep)) {
      return undefined;
    }

    const realMd = await fs.realpath(path.join(realRoot, "SKILL.md"));
    if (!realMd.startsWith(realRoot + path.sep)) return undefined;

    handle = await fs.open(realMd, "r");
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return parseSkillDescription(buffer.subarray(0, bytesRead).toString("utf-8"));
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}
