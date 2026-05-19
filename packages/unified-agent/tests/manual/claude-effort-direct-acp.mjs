import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import process from 'node:process';

import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

const BRIDGE_ARGS = [
  '--yes',
  '--package=@agentclientprotocol/claude-agent-acp@0.33.1',
  'claude-agent-acp',
];
const PROMPT = '다음 문제를 단계별로 추론하여 답하시오: 어떤 수에 7을 더하고 3을 곱한 뒤 5를 빼면 31이 된다. 이 수는 무엇인가?';
const RUNS_PER_EFFORT = 3;
const RUN_TIMEOUT_MS = 120_000;
const MODELS = ['haiku', 'sonnet', 'opus', 'opus[1m]'];
const EFFORTS = ['low', 'max'];

async function main() {
  const results = [];
  const resumeResults = [];

  for (const model of MODELS) {
    for (const effort of EFFORTS) {
      for (let index = 0; index < RUNS_PER_EFFORT; index += 1) {
        const result = await runSingleMeasurement(effort, index + 1, model);
        results.push(result);
        printRunResult(result);
      }
    }

    const resumeResult = await runResumeMeasurement('max', model);
    resumeResults.push(resumeResult);
    printResumeSummary(resumeResult);
  }

  printSummary(results);
  printResumeCollectionSummary(resumeResults);
}

async function runSingleMeasurement(effort, attempt, model) {
  const child = spawn('npx', BRIDGE_ARGS, {
    cwd: process.cwd(),
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stderrChunks = [];
  child.stderr.on('data', (chunk) => {
    stderrChunks.push(chunk.toString());
  });

  const webWritable = Writable.toWeb(child.stdin);
  const webReadable = Readable.toWeb(child.stdout);
  const stream = ndJsonStream(webWritable, webReadable);

  const metrics = {
    messageLen: 0,
    thoughtLen: 0,
    combinedLen: 0,
    latencyMs: 0,
    promptResponse: null,
  };

  let sessionId = null;
  let agentProxy = null;

  const connection = new ClientSideConnection((agent) => {
    agentProxy = agent;
    return {
      requestPermission: async (params) => {
        const optionId = params?.options?.[0]?.optionId;
        if (!optionId) {
          return { outcome: { outcome: 'cancelled' } };
        }
        return {
          outcome: {
            outcome: 'selected',
            optionId,
          },
        };
      },
      sessionUpdate: async (notification) => {
        const update = notification?.update;
        if (!update || !update.content || update.content.type !== 'text') {
          return;
        }

        const text = typeof update.content.text === 'string' ? update.content.text : '';
        if (update.sessionUpdate === 'agent_message_chunk') {
          metrics.messageLen += text.length;
        } else if (update.sessionUpdate === 'agent_thought_chunk') {
          metrics.thoughtLen += text.length;
        }
      },
      readTextFile: async () => {
        throw new Error('readTextFile는 manual 측정 스크립트에서 지원하지 않습니다');
      },
      writeTextFile: async () => {
        throw new Error('writeTextFile는 manual 측정 스크립트에서 지원하지 않습니다');
      },
      createTerminal: async () => {
        throw new Error('createTerminal는 manual 측정 스크립트에서 지원하지 않습니다');
      },
      terminalOutput: async () => {
        throw new Error('terminalOutput는 manual 측정 스크립트에서 지원하지 않습니다');
      },
      releaseTerminal: async () => {
        throw new Error('releaseTerminal는 manual 측정 스크립트에서 지원하지 않습니다');
      },
      waitForTerminalExit: async () => {
        throw new Error('waitForTerminalExit는 manual 측정 스크립트에서 지원하지 않습니다');
      },
      killTerminal: async () => {
        throw new Error('killTerminal는 manual 측정 스크립트에서 지원하지 않습니다');
      },
    };
  }, stream);

  try {
    await withTimeout(
      waitForAgentProxy(() => agentProxy),
      RUN_TIMEOUT_MS,
      `agent proxy 생성 (${effort} #${attempt})`,
    );

    await withTimeout(
      agentProxy.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
          permissions: true,
          terminal: false,
        },
        clientInfo: {
          name: 'Fleet-Manual-Effort-Probe',
          version: '1.0.0',
        },
      }),
      RUN_TIMEOUT_MS,
      `initialize (${effort} #${attempt})`,
    );

    const session = await withTimeout(
      agentProxy.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        _meta: {
          claudeCode: {
            options: {
              effort,
              model,
            },
          },
        },
      }),
      RUN_TIMEOUT_MS,
      `newSession (${effort} #${attempt})`,
    );
    sessionId = session.sessionId;

    const startedAt = Date.now();
    const promptResponse = await withTimeout(
      agentProxy.prompt({
        sessionId,
        prompt: [{ type: 'text', text: PROMPT }],
      }),
      RUN_TIMEOUT_MS,
      `prompt (${model} ${effort} #${attempt})`,
    );
    metrics.latencyMs = Date.now() - startedAt;
    metrics.promptResponse = promptResponse;
    metrics.combinedLen = metrics.messageLen + metrics.thoughtLen;

    return {
      ok: true,
      model,
      effort,
      attempt,
      sessionId,
      messageLen: metrics.messageLen,
      thoughtLen: metrics.thoughtLen,
      combinedLen: metrics.combinedLen,
      latencyMs: metrics.latencyMs,
      stopReason: promptResponse?.stopReason ?? null,
      stderrTail: stderrChunks.join('').trim().split('\n').slice(-5),
    };
  } catch (error) {
    return {
      ok: false,
      model,
      effort,
      attempt,
      sessionId,
      messageLen: null,
      thoughtLen: null,
      combinedLen: null,
      latencyMs: null,
      stopReason: null,
      stderrTail: stderrChunks.join('').trim().split('\n').slice(-5),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await closeSessionIfPossible(agentProxy, sessionId);
    await terminateChild(child);
    await closeConnection(connection);
  }
}

async function runResumeMeasurement(effort, model) {
  try {
    const seedClient = await createManualClient();
    let sessionId = null;

    try {
      const seedSession = await withTimeout(
        seedClient.agentProxy.newSession({
          cwd: process.cwd(),
          mcpServers: [],
          _meta: {
            claudeCode: {
              options: {
                effort,
                model,
              },
            },
          },
        }),
        RUN_TIMEOUT_MS,
        'resume seed newSession',
      );
      sessionId = seedSession.sessionId;

      await withTimeout(
        seedClient.agentProxy.prompt({
          sessionId,
          prompt: [{ type: 'text', text: '이 세션을 재개 테스트용으로 저장해 둬. 답은 짧게 ok만 해.' }],
        }),
        RUN_TIMEOUT_MS,
        `resume seed prompt (${model})`,
      );
    } finally {
      await terminateChild(seedClient.child);
      await closeConnection(seedClient.connection);
    }

    const resumedClient = await createManualClient();

    try {
      const resumed = await withTimeout(
        resumedClient.agentProxy.loadSession({
          sessionId,
          cwd: process.cwd(),
          mcpServers: [],
          _meta: {
            claudeCode: {
              options: {
                effort,
                model,
              },
            },
          },
        }),
        RUN_TIMEOUT_MS,
        `resume loadSession (${model})`,
      );

      sessionId = resumed.sessionId ?? sessionId;

      const startedAt = Date.now();
      await withTimeout(
        resumedClient.agentProxy.prompt({
          sessionId,
          prompt: [{ type: 'text', text: PROMPT }],
        }),
        RUN_TIMEOUT_MS,
        `resume prompt (${model})`,
      );
      resumedClient.metrics.latencyMs = Date.now() - startedAt;
      resumedClient.metrics.combinedLen = resumedClient.metrics.messageLen + resumedClient.metrics.thoughtLen;

      return {
        ok: true,
        model,
        effort,
        sessionId,
        messageLen: resumedClient.metrics.messageLen,
        thoughtLen: resumedClient.metrics.thoughtLen,
        combinedLen: resumedClient.metrics.combinedLen,
        latencyMs: resumedClient.metrics.latencyMs,
      };
    } finally {
      await terminateChild(resumedClient.child);
      await closeConnection(resumedClient.connection);
    }
  } catch (error) {
    return {
      ok: false,
      model,
      effort,
      sessionId: null,
      messageLen: null,
      thoughtLen: null,
      combinedLen: null,
      latencyMs: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function createManualClient() {
  const child = spawn('npx', BRIDGE_ARGS, {
    cwd: process.cwd(),
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const webWritable = Writable.toWeb(child.stdin);
  const webReadable = Readable.toWeb(child.stdout);
  const stream = ndJsonStream(webWritable, webReadable);
  const metrics = {
    messageLen: 0,
    thoughtLen: 0,
    combinedLen: 0,
    latencyMs: 0,
  };

  let agentProxy = null;
  const connection = new ClientSideConnection((agent) => {
    agentProxy = agent;
    return {
      requestPermission: async (params) => {
        const optionId = params?.options?.[0]?.optionId;
        if (!optionId) {
          return { outcome: { outcome: 'cancelled' } };
        }
        return { outcome: { outcome: 'selected', optionId } };
      },
      sessionUpdate: async (notification) => {
        const update = notification?.update;
        if (!update || !update.content || update.content.type !== 'text') {
          return;
        }
        const text = typeof update.content.text === 'string' ? update.content.text : '';
        if (update.sessionUpdate === 'agent_message_chunk') {
          metrics.messageLen += text.length;
        } else if (update.sessionUpdate === 'agent_thought_chunk') {
          metrics.thoughtLen += text.length;
        }
      },
      readTextFile: async () => { throw new Error('readTextFile는 manual 측정 스크립트에서 지원하지 않습니다'); },
      writeTextFile: async () => { throw new Error('writeTextFile는 manual 측정 스크립트에서 지원하지 않습니다'); },
      createTerminal: async () => { throw new Error('createTerminal는 manual 측정 스크립트에서 지원하지 않습니다'); },
      terminalOutput: async () => { throw new Error('terminalOutput는 manual 측정 스크립트에서 지원하지 않습니다'); },
      releaseTerminal: async () => { throw new Error('releaseTerminal는 manual 측정 스크립트에서 지원하지 않습니다'); },
      waitForTerminalExit: async () => { throw new Error('waitForTerminalExit는 manual 측정 스크립트에서 지원하지 않습니다'); },
      killTerminal: async () => { throw new Error('killTerminal는 manual 측정 스크립트에서 지원하지 않습니다'); },
    };
  }, stream);

  await withTimeout(waitForAgentProxy(() => agentProxy), RUN_TIMEOUT_MS, 'manual agent proxy 생성');
  await withTimeout(
    agentProxy.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        permissions: true,
        terminal: false,
      },
      clientInfo: {
        name: 'Fleet-Manual-Effort-Probe',
        version: '1.0.0',
      },
    }),
    RUN_TIMEOUT_MS,
    'manual initialize',
  );

  return { child, connection, agentProxy, metrics };
}

function waitForAgentProxy(getAgentProxy) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const agentProxy = getAgentProxy();
      if (agentProxy) {
        clearInterval(timer);
        resolve(agentProxy);
        return;
      }

      if (Date.now() - startedAt > 5_000) {
        clearInterval(timer);
        reject(new Error('ClientSideConnection이 agent proxy를 제공하지 않았습니다'));
      }
    }, 10);
  });
}

async function closeSessionIfPossible(agentProxy, sessionId) {
  if (!agentProxy || !sessionId || typeof agentProxy.closeSession !== 'function') {
    return;
  }

  try {
    await agentProxy.closeSession({ sessionId });
  } catch {
    // 측정 종료 정리 실패는 무시합니다.
  }
}

async function closeConnection(connection) {
  try {
    await Promise.race([
      connection.closed,
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  } catch {
    // 연결 종료 대기 실패는 무시합니다.
  }
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 3_000)),
  ]);

  if (!exited) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', () => resolve()));
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`[timeout] ${label}: ${ms}ms`)), ms);
    }),
  ]);
}

function printRunResult(result) {
  const summary = {
    model: result.model,
    effort: result.effort,
    attempt: result.attempt,
    messageLen: result.messageLen,
    thoughtLen: result.thoughtLen,
    combinedLen: result.combinedLen,
    latencyMs: result.latencyMs,
    stopReason: result.stopReason,
    ok: result.ok,
    error: result.error ?? null,
  };
  console.log(JSON.stringify(summary));
}

function printSummary(results) {
  for (const model of MODELS) {
    const modelRows = results.filter((result) => result.model === model);

    console.log(`\n=== Raw Results: ${model} ===`);
    for (const result of modelRows) {
      console.log(
        [
          `${result.model}`,
          `${result.effort}#${result.attempt}`,
          `ok=${result.ok}`,
          `messageLen=${formatNumber(result.messageLen)}`,
          `thoughtLen=${formatNumber(result.thoughtLen)}`,
          `combinedLen=${formatNumber(result.combinedLen)}`,
          `latencyMs=${formatNumber(result.latencyMs)}`,
          result.error ? `error=${result.error}` : null,
        ].filter(Boolean).join(' | '),
      );
    }

    console.log(`\n=== Summary By Effort: ${model} ===`);
    for (const effort of EFFORTS) {
      const rows = modelRows.filter((result) => result.effort === effort && result.ok);
      console.log(
        JSON.stringify({
          model,
          effort,
          messageLen: summarizeNumbers(rows.map((row) => row.messageLen)),
          thoughtLen: summarizeNumbers(rows.map((row) => row.thoughtLen)),
          combinedLen: summarizeNumbers(rows.map((row) => row.combinedLen)),
          latencyMs: summarizeNumbers(rows.map((row) => row.latencyMs)),
        }),
      );
    }

    console.log(`\n=== Directionality Check: ${model} ===`);
    const lowRows = modelRows.filter((result) => result.effort === 'low');
    const maxRows = modelRows.filter((result) => result.effort === 'max');
    const pairs = lowRows.map((lowRow, index) => {
      const maxRow = maxRows[index];
      return {
        model,
        pair: index + 1,
        lowOk: lowRow?.ok ?? false,
        maxOk: maxRow?.ok ?? false,
        messageLenDelta: subtractNullable(maxRow?.messageLen, lowRow?.messageLen),
        thoughtLenDelta: subtractNullable(maxRow?.thoughtLen, lowRow?.thoughtLen),
        combinedLenDelta: subtractNullable(maxRow?.combinedLen, lowRow?.combinedLen),
        latencyDelta: subtractNullable(maxRow?.latencyMs, lowRow?.latencyMs),
      };
    });
    for (const pair of pairs) {
      console.log(JSON.stringify(pair));
    }
  }
}

function printResumeSummary(result) {
  console.log(`\n=== Resume Measurement: ${result.model} ===`);
  console.log(
    JSON.stringify({
      path: 'loadSession(_meta.claudeCode.options.effort)',
      model: result.model,
      ok: result.ok,
      effort: result.effort,
      messageLen: result.messageLen,
      thoughtLen: result.thoughtLen,
      combinedLen: result.combinedLen,
      latencyMs: result.latencyMs,
      error: result.error ?? null,
    }),
  );
}

function printResumeCollectionSummary(results) {
  console.log('\n=== Resume Measurements (All Models) ===');
  for (const result of results) {
    console.log(
      JSON.stringify({
        model: result.model,
        ok: result.ok,
        effort: result.effort,
        messageLen: result.messageLen,
        thoughtLen: result.thoughtLen,
        combinedLen: result.combinedLen,
        latencyMs: result.latencyMs,
        error: result.error ?? null,
      }),
    );
  }
}

function summarizeNumbers(values) {
  if (values.length === 0 || values.some((value) => value == null)) {
    return null;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    avg: Number((total / values.length).toFixed(2)),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function subtractNullable(left, right) {
  if (left == null || right == null) {
    return null;
  }
  return left - right;
}

function formatNumber(value) {
  return value == null ? 'null' : String(value);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  process.exit(process.exitCode ?? 0);
});
