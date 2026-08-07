import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 태그 그룹은 선택적이다. 새 릴리스의 불릿에는 패키지 태그가 없고, 이 그룹을 필수로 두면
// 무태그 불릿이 "불릿 아님"으로 분류되어 아래에서 en/ko 원문 동일성을 요구하게 된다.
const BULLET = /^- ((?:\[[^\]]+\]\s*)*)(.+)$/u;
// 복수형 acronym(APIs/CLIs)과 산문 슬래시(open/closed), 문장 마침표가 en/ko 사이에서
// 비대칭 매칭되지 않도록 acronym은 trailing boundary 없이, 경로는 단어 뒤 슬래시를 제외하고 잡는다.
const PROTECTED_TOKEN = /`[^`]+`|https?:\/\/[^\s)]+|--[a-z][\w-]*|\b(?:v?\d+(?:\.\d+)+(?:-[\w.]+)?)\b|\b[A-Z][A-Z0-9_]{2,}|(?<![\w\p{L}])(?:~\/|\/)[\w./:@-]*[\w/]/gu;

test("Korean changelog preserves the English release topology and protected tokens", async () => {
  const [english, korean] = await Promise.all([
    readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8"),
    readFile(new URL("../CHANGELOG.ko.md", import.meta.url), "utf8"),
  ]);
  const englishLines = english.split("\n");
  const koreanLines = korean.split("\n");

  assert.equal(koreanLines.length, englishLines.length, "line topology must match");
  assert.ok(Buffer.byteLength(korean) < 1024 * 1024, "Korean changelog must stay below 1 MiB");

  let bulletCount = 0;
  for (let index = 0; index < englishLines.length; index += 1) {
    const source = englishLines[index];
    const translation = koreanLines[index];
    const sourceBullet = BULLET.exec(source);
    const translationBullet = BULLET.exec(translation);

    if (!sourceBullet) {
      assert.equal(translation, source, `non-bullet line ${index + 1} must be identical`);
      continue;
    }

    bulletCount += 1;
    assert.ok(translationBullet, `line ${index + 1} must remain a bullet`);
    assert.equal(translationBullet[1], sourceBullet[1], `line ${index + 1} package tags must match`);
    assert.match(translationBullet[2], /\p{Script=Hangul}/u, `line ${index + 1} needs Hangul`);
    // 요구사항은 토큰의 "보존"이다. 번역이 같은 토큰을 두 번 쓰거나(ARM, MCP) 영어가 생략한 이전 표기를
    // 덧붙여 더 친절해지는 것은 손실이 아니므로, 정확 일치가 아니라 누락만 잡는다.
    const translated = new Set(protectedTokens(translationBullet[2]));
    assert.deepEqual(
      protectedTokens(sourceBullet[2]).filter((token) => !translated.has(token)),
      [],
      `line ${index + 1} drops protected tokens present in English`,
    );
  }

  assert.ok(bulletCount >= 503, "the historical seed must retain all current bullets");
});

function protectedTokens(summary) {
  return [...summary.matchAll(PROTECTED_TOKEN)].map((match) => match[0]).sort();
}
