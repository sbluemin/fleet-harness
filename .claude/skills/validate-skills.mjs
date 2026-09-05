import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(root, '../..');
const { parseSkillDescription } = await import(
  path.join(repoRoot, 'runtime/fleet-plugins/skills/server/frontmatter.ts')
);
const errors = [];
const names = new Set();
let links = 0;
let references = 0;

// 실제 제품 파서와 파일 링크를 검사한다. 모델의 선택 정확도를 평가하는 테스트는 아니다.
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
    assert.ok(description && description.length <= 500, 'description은 500자 이하 한 줄이어야 한다');
    assert.equal(
      parseSkillDescription(Buffer.from(text).subarray(0, 8192).toString('utf8')),
      description,
      '실제 Console 파서가 description을 잘라내거나 읽지 못한다',
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
      referenceFiles = await fs.readdir(referenceDir);
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
  console.log(`스킬 ${names.size}개: 실제 frontmatter 파서, 상대 링크 ${links}건, reference ${references}개 도달성 통과`);
}
