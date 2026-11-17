import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { claudeGatewayModelPolicy } from "@fleet-console/ai-gateway";

import { describe, expect, it } from "vitest";

import { createClaudeGatewaySdk } from "../../foundation/agent-runtime/src/claude/sdk.js";

/**
 * 콘솔 e2e·핸드오프가 쓰는 fake CLI가 Fleet의 SDK 실행과 initialize 단계에서 호환되는지만 본다.
 *
 * Fleet은 위임 가드를 위해 PreToolUse 훅을 `onFailure: "block"`으로 싣는다. vendor SDK는 그 훅이
 * 있을 때 initialize 응답의 `hook_on_failure_supported`가 참이 아니면 프롬프트를 보내지 않고
 * 실패한다. fake가 이 능력을 광고하지 않으면 e2e 세션은 모두 첫 턴에서 죽고, 그것이 훅 집행
 * 실패처럼 보인다. 그래서 이 시험은 fake와 실제 SDK의 핸드셰이크만 고정한다.
 *
 * fake는 훅 이벤트를 하나도 내지 않는다 — 통과는 훅 집행 성공이 아니다. 훅이 실제로 막는지는
 * 이 파일이 아니라 실제 CLI로 확인해야 한다.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const FAKE_CLAUDE = path.join(repoRoot, ".claude/skills/console-e2e/scripts/fake-claude.mjs");
const MODEL = "claude-gateway--codex--gpt-6-luna";
const BASE_URL = "http://127.0.0.1:43210/plugins/terminal/ai-gateway";

describe("console-e2e fake Claude", () => {
  // fake는 `#!/usr/bin/env node` 스크립트다. Windows에는 .cmd 대응이 있지만 이 시험은 POSIX 경로만 쓴다.
  it.skipIf(process.platform === "win32")("answers the SDK initialize handshake while a hook is set to block", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fake-claude-init-"));
    const fakeDir = path.join(root, "fake");
    mkdirSync(fakeDir);
    const env = Object.fromEntries(Object.entries({
      PATH: process.env.PATH,
      HOME: path.join(root, "home"),
      TMPDIR: root,
      FAKE_CLAUDE_DIR: fakeDir,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const sdk = await createClaudeGatewaySdk({
      modelPolicy: claudeGatewayModelPolicy,
      baseUrl: BASE_URL,
      models: [MODEL],
      executablePath: FAKE_CLAUDE,
      tempRoot: root,
      env,
      hooks: { preToolUse: async () => undefined },
    });
    try {
      const results = [];
      for await (const message of await sdk.startTurn({ prompt: "initialize compatibility probe", model: MODEL })) {
        if (message.type === "result") results.push(message);
      }
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ subtype: "success", is_error: false });
      // initialize 제어 요청이 fake에 실제로 도착했는지 — 첫 턴이 그 뒤에 열렸다는 사실만으로는
      // 핸드셰이크의 주체를 구분할 수 없다.
      const log = readFileSync(path.join(fakeDir, "log.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(log.some((entry) => entry.event === "control" && entry.subtype === "initialize")).toBe(true);
    } finally {
      await sdk.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
