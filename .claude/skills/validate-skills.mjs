import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const MAX_DESCRIPTION = 500;
const errors = [];
const names = new Set();
let links = 0;
let references = 0;

// frontmatter 파서와 파일 링크를 검사한다. 모델의 선택 정확도를 평가하는 테스트는 아니다.
for (const entry of await fs.readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const skillRoot = path.join(root, entry.name);
  try {
    const file = path.join(skillRoot, 'SKILL.md');
    const text = await fs.readFile(file, 'utf8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
    assert.ok(frontmatter, 'frontmatter가 없다');
    const name = /^name: (.+)$/m.exec(frontmatter)?.[1];
    const description = /^description: (.+)$/m.exec(frontmatter)?.[1];
    assert.equal(name, entry.name, 'name과 디렉터리명이 다르다');
    assert.match(name, /^[a-z0-9][a-z0-9._-]*$/);
    assert.ok(!names.has(name), '중복 name');
    names.add(name);
    assert.ok(description && description.length <= MAX_DESCRIPTION, 'description은 500자 이하 한 줄이어야 한다');
    assert.equal(
      parseSkillDescription(Buffer.from(text).subarray(0, 8192).toString('utf8')),
      description,
      'YAML 파서가 읽는 description이 한 줄 값과 다르다(따옴표·이어지는 줄·블록 스칼라)',
    );

    const visited = new Set();
    const pending = [file];
    while (pending.length) {
      const current = pending.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      const body = await fs.readFile(current, 'utf8');
      for (const match of body.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)) {
        const href = match[1];
        if (/^(?:[a-z]+:|#)/i.test(href)) continue;
        const target = path.resolve(path.dirname(current), decodeURIComponent(href.split('#')[0]));
        assert.ok(target.startsWith(root + path.sep), `스킬 트리 밖 상대 링크: ${href}`);
        assert.ok((await fs.stat(target)).isFile(), `파일이 아닌 링크: ${href}`);
        links += 1;
        if (target.endsWith('.md')) pending.push(target);
      }
    }
    const referenceDir = path.join(skillRoot, 'references');
    let referenceFiles = [];
    try {
      // 하위 폴더(예: references/desktop/)의 reference도 진입점에서 닿아야 한다.
      referenceFiles = await fs.readdir(referenceDir, { recursive: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const reference of referenceFiles.filter((name) => name.endsWith('.md'))) {
      assert.ok(visited.has(path.join(referenceDir, reference)), `진입점에서 도달하지 못하는 reference: ${reference}`);
      references += 1;
    }
  } catch (error) {
    errors.push(`${entry.name}: ${error.message}`);
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`스킬 ${names.size}개: frontmatter 파서, 상대 링크 ${links}건, reference ${references}개 도달성 통과`);
}

/**
 * SKILL.md YAML frontmatter에서 description 값을 YAML 규칙대로 읽는다.
 *
 * 위의 정규식은 `description: ` 뒤 한 줄만 본다. 따옴표로 감싼 값, 들여쓴 이어지는 줄(폴드),
 * 블록 스칼라(`>`·`|`)는 YAML 파서가 다르게 읽으므로, 이 결과가 그 한 줄과 같아야 통과한다.
 * 그 밖의 YAML(앵커, 배열)은 undefined로 떨어진다.
 */
function parseSkillDescription(head) {
  const text = head.charCodeAt(0) === 0xfeff ? head.slice(1) : head;
  if (!/^---\r?\n/.test(text)) return undefined;
  const body = text.slice(text.indexOf('\n') + 1);
  const endIndex = body.search(/^---\s*$/m);
  if (endIndex === -1) return undefined;
  const lines = body.slice(0, endIndex).split(/\r?\n/);
  const startLine = lines.findIndex((line) => /^description\s*:/.test(line));
  if (startLine === -1) return undefined;
  const first = (lines[startLine] ?? '').replace(/^description\s*:\s*/, '');
  const block = /^([>|])(?:[1-9][+-]?|[+-][1-9]?)?\s*(?:#.*)?$/.exec(first.trim());
  const value = block
    ? readBlockScalar(lines.slice(startLine + 1), block[1] === '>')
    : readPlainScalar(first, lines.slice(startLine + 1));
  if (!value) return undefined;
  return value.length > MAX_DESCRIPTION ? value.slice(0, MAX_DESCRIPTION) : value;
}

function readPlainScalar(first, rest) {
  const parts = [first.trim()];
  for (const line of rest) {
    if (!/^\s+\S/.test(line)) break;
    parts.push(line.trim());
  }
  let value = parts.filter(Boolean).join(' ').trim();
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1)
    || (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

function readBlockScalar(rest, folded) {
  const content = [];
  for (const line of rest) {
    if (line.trim() === '') { content.push(''); continue; }
    if (!/^\s/.test(line)) break;
    content.push(line.trim());
  }
  if (!folded) return content.join('\n').trim();
  const paragraphs = [];
  let current = [];
  for (const line of content) {
    if (line === '') {
      if (current.length > 0) paragraphs.push(current.join(' '));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) paragraphs.push(current.join(' '));
  return paragraphs.join('\n').trim();
}
