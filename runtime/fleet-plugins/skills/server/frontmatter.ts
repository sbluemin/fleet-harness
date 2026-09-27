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
 * 단일 라인, 따옴표로 감싼 라인, 이어지는 들여쓰기 줄(폴드), 그리고 블록 스칼라(`>`·`|`와
 * 그 chomping/들여쓰기 지시자)다. 여러 줄 설명은 공개 스킬에서 흔히 `description: >`로 쓰인다.
 * 그 밖의 YAML(앵커, 배열)은 값이 아니라 undefined로 떨어진다 — 잘못 읽은 설명을
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
  const block = /^([>|])(?:[1-9][+-]?|[+-][1-9]?)?\s*(?:#.*)?$/.exec(first.trim());
  const value = block
    ? readBlockScalar(lines.slice(startLine + 1), block[1] === ">")
    : readPlainScalar(first, lines.slice(startLine + 1));
  if (!value) return undefined;

  return value.length > MAX_DESCRIPTION ? value.slice(0, MAX_DESCRIPTION) : value;
}

function readPlainScalar(first: string, rest: readonly string[]): string {
  const parts = [first.trim()];
  for (const line of rest) {
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
  return value;
}

/**
 * 블록 스칼라 본문. 들여쓴 줄(과 그 사이 빈 줄)이 본문이고, 들여쓰지 않은 첫 줄에서 끝난다.
 * folded(`>`)는 줄을 공백으로 잇고 빈 줄만 줄바꿈으로 남긴다. literal(`|`)은 줄바꿈을 지킨다.
 * chomping은 따로 적용하지 않는다 — 설명은 어차피 앞뒤 공백을 걷어 보여 준다.
 */
function readBlockScalar(rest: readonly string[], folded: boolean): string {
  const content: string[] = [];
  for (const line of rest) {
    if (line.trim() === "") { content.push(""); continue; }
    if (!/^\s/.test(line)) break;
    content.push(line.trim());
  }
  if (!folded) return content.join("\n").trim();

  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of content) {
    if (line === "") {
      if (current.length > 0) paragraphs.push(current.join(" "));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) paragraphs.push(current.join(" "));
  return paragraphs.join("\n").trim();
}

/** 스킬 경로를 scope 경계 안에서 해석한 결과. */
export type ContainedSkillMd =
  | { readonly kind: "ok"; readonly path: string }
  | { readonly kind: "missing" }
  | { readonly kind: "outside" };

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * CLI가 보고한 스킬 경로라도 신뢰하지 않는다. 디렉터리와 그 SKILL.md를 모두 realpath로 풀어,
 * 디렉터리는 허용된 루트 중 하나 **안에**, SKILL.md는 그 디렉터리 안에 있을 때만 경로를 내준다.
 *
 * 허용 루트가 여럿인 것은 전역 범위 때문이다: Claude 설정 디렉터리(`CLAUDE_CONFIG_DIR`)는 홈
 * 밖에 있을 수 있고, 그 아래 전역 Claude 스킬도 정당한 자리다. 루트마다 같은 realpath 봉쇄를
 * 적용하므로 루트를 늘려도 심링크 탈출 차단은 약해지지 않는다. 풀리지 않는 루트는 버린다.
 */
export async function resolveContainedSkillMd(
  skillRoot: string,
  allowedRoots: readonly string[],
): Promise<ContainedSkillMd> {
  const realRoots = (await Promise.all(allowedRoots.map((root) => fs.realpath(root).catch(() => null))))
    .filter((root): root is string => root !== null);
  let realRoot: string;
  try {
    realRoot = await fs.realpath(skillRoot);
  } catch {
    return { kind: "missing" };
  }
  if (!realRoots.some((root) => isWithin(root, realRoot))) return { kind: "outside" };

  let realMd: string;
  try {
    realMd = await fs.realpath(path.join(realRoot, "SKILL.md"));
  } catch {
    return { kind: "missing" };
  }
  if (!realMd.startsWith(realRoot + path.sep)) return { kind: "outside" };
  return { kind: "ok", path: realMd };
}

/**
 * 설치된 스킬 디렉터리에서 SKILL.md 머리만 읽어 description을 얻는다.
 *
 * `resolveContainedSkillMd`와 같은 봉쇄를 거쳐 scope의 정당한 경계(project=Theater 루트,
 * global=홈과 Claude 설정 디렉터리) 안에 있을 때만 읽는다.
 * 어떤 실패도 던지지 않는다: 설명은 목록의 장식이지 목록의 조건이 아니다.
 */
export async function readSkillDescription(
  skillRoot: string,
  allowedRoots: readonly string[],
): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    const contained = await resolveContainedSkillMd(skillRoot, allowedRoots);
    if (contained.kind !== "ok") return undefined;

    handle = await fs.open(contained.path, "r");
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return parseSkillDescription(buffer.subarray(0, bytesRead).toString("utf-8"));
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}
