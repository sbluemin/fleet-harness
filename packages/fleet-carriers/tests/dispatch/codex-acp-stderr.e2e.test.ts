import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  executorMcpRuntimeProviderRuntime,
  executorPortRuntime,
  type AgentToolCtx,
} from "@dotobokuri/core-agent";
import { getProviderModels } from "@dotobokuri/core-unified-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildCarrierDispatchToolSpec,
  buildCarrierJobsToolSpec,
  createCarrierRegistry,
  initStore,
  registerCarrier,
  resetJobArchivesForTest,
  resetJobCancelRegistryForTest,
  resetJobConcurrencyForTest,
  resetJobSummaryCacheForTest,
  resetStoreForTests,
  type CarrierConfig,
  type CarrierJobsResponse,
} from "../../src/index.js";

interface ToolExecutionResult<T> {
  readonly details: T;
  readonly isError: boolean;
}

const SECRET_VALUE = "sk-e2e-secret-value-00000000000000000000";

let tempDir: string | null = null;
let fakeBinDir: string | null = null;

describe("carrier_jobs Codex ACP stderr diagnostics e2e", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-codex-acp-stderr-"));
    fakeBinDir = path.join(tempDir, "bin");
    fs.mkdirSync(fakeBinDir, { recursive: true });
    initStore(path.join(tempDir, "store"));
    executorPortRuntime.register({
      getScopeExternalMcpServerIds: () => [],
      getExecutorMcpTools: () => [],
    });
    executorMcpRuntimeProviderRuntime.register({
      getExecutorMcpRouterRuntimes: () => [],
    });
    resetJobArchivesForTest();
    resetJobSummaryCacheForTest();
    resetJobConcurrencyForTest();
    resetJobCancelRegistryForTest();
  });

  afterEach(async () => {
    resetJobArchivesForTest();
    resetJobSummaryCacheForTest();
    resetJobConcurrencyForTest();
    resetJobCancelRegistryForTest();
    resetStoreForTests();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    tempDir = null;
    fakeBinDir = null;
  });

  it("carrier_jobs summary에서 redacted codex-acp stderr tail을 확인한다", async () => {
    const cwd = tempDir;
    const binDir = fakeBinDir;
    if (!cwd || !binDir) throw new Error("테스트 디렉토리가 초기화되지 않았습니다.");
    writeFailingFakeNpx(binDir);

    const registry = createCarrierRegistry();
    registerCarrier(registry, createCodexCarrierConfig("stderr_probe", "Stderr Probe"));
    const dispatchTool = buildCarrierDispatchToolSpec(registry, {
      authEnvResolver: async () => ({
        OPENAI_API_KEY: SECRET_VALUE,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      }),
    });
    const dispatchCtx: AgentToolCtx = {
      cwd,
      toolCallId: "codex-acp-stderr",
    };

    const dispatchResult = await dispatchTool.execute({
      carrier_id: "stderr_probe",
      label: "Capture codex-acp stderr",
      request: "Trigger deterministic codex-acp startup failure.",
    }, dispatchCtx) as ToolExecutionResult<{ job_id: string; accepted: boolean; error?: string }>;

    // 연결/초기화 실패는 프롬프트 이전 readiness 단계에서 발생하므로 동기 accepted:false 로 반환된다.
    expect(dispatchResult.isError).toBe(true);
    expect(dispatchResult.details.accepted).toBe(false);
    expect(dispatchResult.details.job_id).toBe("carrier:codex-acp-stderr");

    const errorText = dispatchResult.details.error ?? "";
    expect(errorText).toContain("[REDACTED:generic_secret]");
    expect(errorText).not.toContain(SECRET_VALUE);

    // 거부된 런치는 잔여 job/summary/archive 를 남기지 않는다.
    const jobsTool = buildCarrierJobsToolSpec();
    const jobsResult = await jobsTool.execute({
      action: "result",
      format: "summary",
      job_id: "carrier:codex-acp-stderr",
    }, {
      cwd,
      toolCallId: "carrier-jobs-codex-acp-stderr",
    }) as ToolExecutionResult<CarrierJobsResponse>;
    expect(jobsResult.details.ok).toBe(false);
  });

  it("성공한 carrier_jobs 결과에는 stderr 진단을 싣지 않는다", async () => {
    const cwd = tempDir;
    const binDir = fakeBinDir;
    if (!cwd || !binDir) throw new Error("테스트 디렉토리가 초기화되지 않았습니다.");
    writeSuccessfulFakeNpx(binDir);

    const registry = createCarrierRegistry();
    registerCarrier(registry, createCodexCarrierConfig("stderr_success", "Stderr Success"));
    const dispatchTool = buildCarrierDispatchToolSpec(registry, {
      authEnvResolver: async () => ({
        OPENAI_API_KEY: SECRET_VALUE,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      }),
    });

    const dispatchResult = await dispatchTool.execute({
      carrier_id: "stderr_success",
      label: "Ignore successful stderr",
      request: "Complete successfully after stderr noise.",
    }, {
      cwd,
      toolCallId: "codex-acp-success-stderr",
    }) as ToolExecutionResult<{ job_id: string; accepted: boolean; error?: string }>;

    expect(dispatchResult.isError).toBe(false);
    expect(dispatchResult.details).toEqual({
      job_id: "carrier:codex-acp-success-stderr",
      accepted: true,
    });

    const jobsTool = buildCarrierJobsToolSpec();
    let summaryPayload = "";

    await vi.waitFor(async () => {
      const jobsResult = await jobsTool.execute({
        action: "result",
        format: "summary",
        job_id: "carrier:codex-acp-success-stderr",
      }, {
        cwd,
        toolCallId: "carrier-jobs-codex-acp-success-summary",
      }) as ToolExecutionResult<CarrierJobsResponse>;
      const response = jobsResult.details;
      summaryPayload = JSON.stringify(response);

      expect(response.ok).toBe(true);
      expect(response.status).toBe("done");
      expect(response.summary?.error).toBeUndefined();
      expect(response.summary?.summary).toBe("carrier job completed: 1 done, 0 failed");
    }, { timeout: 5_000 });

    const fullResult = await jobsTool.execute({
      action: "result",
      format: "full",
      job_id: "carrier:codex-acp-success-stderr",
    }, {
      cwd,
      toolCallId: "carrier-jobs-codex-acp-success-full",
    }) as ToolExecutionResult<CarrierJobsResponse>;
    const fullPayload = JSON.stringify(fullResult.details);

    expect(summaryPayload).not.toContain("ACP initialize stderr tail:");
    expect(summaryPayload).not.toContain("codex-acp success stderr noise");
    expect(fullPayload).not.toContain("ACP initialize stderr tail:");
    expect(fullPayload).not.toContain("codex-acp success stderr noise");
  });
});

function createCodexCarrierConfig(id: string, displayName: string): CarrierConfig {
  return {
    id,
    displayName,
    slot: 1,
    defaultCliType: "codex",
    defaultModel: firstCodexModel(),
  };
}

function firstCodexModel(): string {
  const model = getProviderModels("codex").models[0]?.modelId;
  if (!model) {
    throw new Error("Codex 테스트 모델을 찾지 못했습니다.");
  }
  return model;
}

function writeFailingFakeNpx(binDir: string): void {
  const script = `#!/usr/bin/env node
process.stderr.write("codex-acp deterministic failure: git repository required\\n");
process.stderr.write("OPENAI_API_KEY=${SECRET_VALUE}\\n");

let buffer = "";
let responded = false;

function respond(line) {
  if (responded) return;
  responded = true;
  let id = null;
  try {
    const request = JSON.parse(line);
    id = request.id ?? null;
  } catch {
  }
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message: "deterministic initialize failure",
    },
  }) + "\\n");
  setTimeout(() => process.exit(1), 10);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const newlineIndex = buffer.indexOf("\\n");
  if (newlineIndex >= 0) {
    respond(buffer.slice(0, newlineIndex));
  }
});

setTimeout(() => {
  process.stderr.write("codex-acp timed out waiting for initialize\\n");
  process.exit(1);
}, 2000);
`;
  fs.writeFileSync(path.join(binDir, "npx"), script, { mode: 0o755 });
}

function writeSuccessfulFakeNpx(binDir: string): void {
  const script = `#!/usr/bin/env node
process.stderr.write("codex-acp success stderr noise\\n");

let buffer = "";

function resultFor(method) {
  if (method === "initialize") {
    return { agentCapabilities: {} };
  }
  if (method === "session/new") {
    return { sessionId: "success-session" };
  }
  if (method === "session/prompt") {
    process.stderr.write("codex-acp success stderr noise during prompt\\n");
    return { stopReason: "endTurn" };
  }
  return {};
}

function respond(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: request.id ?? null,
    result: resultFor(request.method),
  }) + "\\n");
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newlineIndex = buffer.indexOf("\\n");
    if (newlineIndex < 0) break;
    const line = buffer.slice(0, newlineIndex);
    buffer = buffer.slice(newlineIndex + 1);
    respond(line);
  }
});
`;
  fs.writeFileSync(path.join(binDir, "npx"), script, { mode: 0o755 });
}
