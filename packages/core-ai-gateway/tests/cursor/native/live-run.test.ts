import { EventEmitter } from "node:events";
import http2 from "node:http2";

import { fromBinary, fromJson, toBinary, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CURSOR_TOOL_PROVIDER_IDENTIFIER,
  ContextWindowExceededError,
  CursorAdapter,
  buildCursorRunPlan,
  decodeConnectFrames,
  encodeConnectFrame,
  resetCursorWireModelMemory,
} from "../../../src/index.js";
import type {
  CanonicalFunctionTool,
  CanonicalResponseEvent,
  CanonicalResponseRequest,
  CursorAdapterOptions,
  CursorDiagnosticEvent,
  ReasoningEffort,
} from "../../../src/index.js";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
} from "../../../src/cursor/native/generated/cursor-agent-protobuf.js";

afterEach(() => {
  vi.useRealTimers();
  resetCursorWireModelMemory();
});

describe("Cursor live client-tool Run bridge", () => {
  it.each(["kimi-k3-1m", "claude-opus-5"])(
    "parks and attaches %s without opening a resume Run",
    async (model) => {
      const call = cursorCall("call-read-1", 21);
      const stream = new BridgeCursorStream(
        cursorToolFrames([call]),
        cursorCompletionFrames("same Run completed"),
        1,
      );
      const harness = cursorHarness([stream]);
      const initial = cursorRequest("session-single", model);

      try {
        const firstEvents = await collectCursorResponse(harness.adapter, initial);
        const secondEvents = await collectCursorResponse(
          harness.adapter,
          cursorContinuation(initial, [call], [cursorResult(call, "README contents")]),
        );

        expect(firstEvents.at(-1)?.type).toBe("response.completed");
        expect(canonicalText(secondEvents)).toBe("same Run completed");
        expect(harness.openedStreams).toBe(1);
        expect(cursorClientWrites(stream).filter((message) => message.runRequest)).toHaveLength(1);
        expect(cursorClientWrites(stream)).not.toContainEqual(expect.objectContaining({
          runRequest: { action: { resumeAction: expect.anything() } },
        }));
        expect(cursorMcpResultWrites(stream)).toEqual([
          expect.objectContaining({
            id: call.messageId,
            execId: call.execId,
            mcpResult: expect.objectContaining({ success: expect.anything() }),
          }),
        ]);
        expect(stream.closeCode).not.toBe(http2.constants.NGHTTP2_CANCEL);
      } finally {
        harness.adapter.dispose();
      }
    },
  );

  it("keeps an enabled diagnostic reporter through a disabled tool continuation", async () => {
    const call = cursorCall("call-diagnostics-on", 22);
    const stream = new BridgeCursorStream(
      cursorToolFrames([call]),
      cursorCompletionFrames("diagnosed Run completed"),
      1,
    );
    const diagnostics: CursorDiagnosticEvent[] = [];
    const harness = cursorHarness([stream], {
      diagnostics: (event) => diagnostics.push(event),
    });
    const initial = cursorRequest("session-diagnostics-on", "kimi-k3-1m");

    try {
      await collectCursorResponseWithDiagnostics(harness.adapter, initial, true);
      await collectCursorResponseWithDiagnostics(
        harness.adapter,
        cursorContinuation(initial, [call], [cursorResult(call, "README contents")]),
        false,
      );

      expect(diagnostics.filter((event) => event.event === "turn.start")).toHaveLength(2);
      expect(diagnostics).toContainEqual(expect.objectContaining({
        event: "bridge.attach",
        outcome: "exact_match",
      }));
    } finally {
      harness.adapter.dispose();
    }
  });

  it("keeps a disabled diagnostic reporter through an enabled tool continuation", async () => {
    const call = cursorCall("call-diagnostics-off", 23);
    const stream = new BridgeCursorStream(
      cursorToolFrames([call]),
      cursorCompletionFrames("quiet Run completed"),
      1,
    );
    const diagnostics: CursorDiagnosticEvent[] = [];
    const harness = cursorHarness([stream], {
      diagnostics: (event) => diagnostics.push(event),
    });
    const initial = cursorRequest("session-diagnostics-off", "kimi-k3-1m");

    try {
      await collectCursorResponseWithDiagnostics(harness.adapter, initial, false);
      await collectCursorResponseWithDiagnostics(
        harness.adapter,
        cursorContinuation(initial, [call], [cursorResult(call, "README contents")]),
        true,
      );

      expect(diagnostics).toEqual([]);
    } finally {
      harness.adapter.dispose();
    }
  });

  it("applies a changed diagnostic policy to the next newly opened Run", async () => {
    const diagnostics: CursorDiagnosticEvent[] = [];
    const harness = cursorHarness([
      new BridgeCursorStream(cursorCompletionFrames("quiet Run completed")),
      new BridgeCursorStream(cursorCompletionFrames("diagnosed Run completed")),
    ], {
      diagnostics: (event) => diagnostics.push(event),
    });

    try {
      await collectCursorResponseWithDiagnostics(
        harness.adapter,
        cursorRequest("session-diagnostics-next-off", "kimi-k3"),
        false,
      );
      expect(diagnostics).toEqual([]);

      await collectCursorResponseWithDiagnostics(
        harness.adapter,
        cursorRequest("session-diagnostics-next-on", "kimi-k3"),
        true,
      );
      expect(diagnostics).toContainEqual(expect.objectContaining({ event: "turn.start" }));
      expect(harness.openedStreams).toBe(2);
    } finally {
      harness.adapter.dispose();
    }
  });

  it("injects an exact parallel batch once and preserves is_error as success.isError", async () => {
    const calls = [cursorCall("call-a", 31), cursorCall("call-b", 32)];
    const stream = new BridgeCursorStream(
      cursorToolFrames(calls),
      cursorCompletionFrames("parallel complete"),
      calls.length,
    );
    const harness = cursorHarness([stream]);
    const initial = cursorRequest("session-parallel", "kimi-k3");

    try {
      await collectCursorResponse(harness.adapter, initial);
      await collectCursorResponse(harness.adapter, cursorContinuation(initial, calls, [
        cursorResult(calls[1]!, "tool b failed", true),
        cursorResult(calls[0]!, "tool a ok"),
      ]));

      const results = cursorMcpResultWrites(stream);
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({
        id: calls[0]!.messageId,
        execId: calls[0]!.execId,
        mcpResult: {
          success: {
            content: [{ text: { text: "tool a ok" } }],
          },
        },
      });
      expect(results[1]).toMatchObject({
        id: calls[1]!.messageId,
        execId: calls[1]!.execId,
        mcpResult: {
          success: {
            content: [{ text: { text: "tool b failed" } }],
            isError: true,
          },
        },
      });
      expect(harness.openedStreams).toBe(1);
    } finally {
      harness.adapter.dispose();
    }
  });

  it("rejects swapped public and tool identifiers without live injection", async () => {
    const first = { ...cursorCall("swap-a", 33), toolCallId: "swap-b" };
    const second = { ...cursorCall("swap-b", 34), toolCallId: "swap-a" };
    await expectCorrelationBatchColdFallback(
      [
        cursorToolStartedFrame(first),
        cursorToolStartedFrame(second),
        cursorExecFrame(first),
        cursorExecFrame(second),
      ],
      [first, second],
      "swapped-identifiers",
    );
  });

  it("rejects a cross-field identifier collision between unique entries", async () => {
    const first = cursorCall("collision-a", 35);
    const second = cursorCall("collision-b", 36);
    const conflicting = {
      ...cursorCall("collision-frame", 37),
      callId: first.callId,
      toolCallId: second.toolCallId,
    };
    await expectCorrelationBatchColdFallback(
      [
        cursorToolStartedFrame(first),
        cursorToolStartedFrame(second),
        cursorToolStartedFrame(conflicting),
        cursorExecFrame(first),
        cursorExecFrame(second),
      ],
      [first, second],
      "cross-field-collision",
    );
  });

  it("rejects a three-entry identifier ambiguity without live injection", async () => {
    const calls = [
      cursorCall("ambiguity-a", 38),
      cursorCall("ambiguity-b", 39),
      cursorCall("ambiguity-c", 40),
    ];
    const [first, second, third] = calls as [CursorCallSpec, CursorCallSpec, CursorCallSpec];
    const ambiguities = [
      { ...first, toolCallId: second.toolCallId },
      { ...second, toolCallId: third.toolCallId },
      { ...third, toolCallId: first.toolCallId },
    ];
    await expectCorrelationBatchColdFallback(
      [
        ...calls.map(cursorToolStartedFrame),
        ...ambiguities.map(cursorToolPartialFrame),
        ...calls.map(cursorExecFrame),
      ],
      calls,
      "three-entry-ambiguity",
    );
  });

  it("adopts a unique public call id after an exec-first suspension", async () => {
    const call = cursorCall("exec-first", 43);
    const authoritativeCall = { ...call, callId: call.toolCallId };
    const stream = new BridgeCursorStream(
      [
        cursorExecFrame(call),
        cursorToolStartedFrame(call),
        cursorToolPartialFrame(call),
        cursorToolCompletedFrame(call),
      ],
      cursorCompletionFrames("exec-first complete"),
      1,
    );
    const harness = cursorHarness([stream]);
    const initial = cursorRequest("session-exec-first", "kimi-k3-1m");

    try {
      const initialEvents = await collectCursorResponse(harness.adapter, initial);
      expect(initialEvents).toContainEqual(expect.objectContaining({
        type: "response.output_item.added",
        item: expect.objectContaining({ call_id: call.toolCallId }),
      }));
      const events = await collectCursorResponse(
        harness.adapter,
        cursorContinuation(initial, [authoritativeCall], [
          cursorResult(authoritativeCall, "exec-first result"),
        ]),
      );

      expect(canonicalText(events)).toBe("exec-first complete");
      expect(cursorMcpResultWrites(stream)).toEqual([
        expect.objectContaining({ id: call.messageId, execId: call.execId }),
      ]);
      expect(harness.openedStreams).toBe(1);
    } finally {
      harness.adapter.dispose();
    }
  });

  it("reconciles reordered parallel exec, partial, completed, and started frames", async () => {
    const first = cursorCall("reordered-a", 44);
    const second = cursorCall("reordered-b", 45);
    const authoritative = [first, { ...second, callId: second.toolCallId }];
    const stream = new BridgeCursorStream(
      [
        cursorExecFrame(second),
        cursorToolPartialFrame(first),
        cursorExecFrame(first),
        cursorToolCompletedFrame(second),
        cursorToolStartedFrame(first),
        cursorToolStartedFrame(second),
      ],
      cursorCompletionFrames("reordered parallel complete"),
      2,
    );
    const harness = cursorHarness([stream]);
    const initial = cursorRequest("session-reordered-parallel", "claude-opus-5");

    try {
      await collectCursorResponse(harness.adapter, initial);
      const events = await collectCursorResponse(
        harness.adapter,
        cursorContinuation(initial, authoritative, [
          cursorResult(authoritative[0]!, "first result"),
          cursorResult(authoritative[1]!, "second result"),
        ]),
      );

      expect(canonicalText(events)).toBe("reordered parallel complete");
      const results = cursorMcpResultWrites(stream);
      expect(results).toHaveLength(2);
      expect(results.find((result) => result.id === first.messageId)).toMatchObject({
        execId: first.execId,
        mcpResult: { success: { content: [{ text: { text: "first result" } }] } },
      });
      expect(results.find((result) => result.id === second.messageId)).toMatchObject({
        execId: second.execId,
        mcpResult: { success: { content: [{ text: { text: "second result" } }] } },
      });
      expect(harness.openedStreams).toBe(1);
    } finally {
      harness.adapter.dispose();
    }
  });

  it("carries the latest checkpoint into a second tool segment on the same Run", async () => {
    const first = cursorCall("checkpoint-cycle-a", 46);
    const second = cursorCall("checkpoint-cycle-b", 47);
    const stream = new BridgeCursorStream(
      [
        {
          conversationCheckpointUpdate: {
            tokenDetails: { usedTokens: 120_000, maxTokens: 256_000 },
          },
        },
        ...cursorToolFrames([first]),
      ],
      cursorToolFrames([second]),
      1,
      [{ afterMcpResults: 2, frames: cursorCompletionFrames("two cycles complete") }],
    );
    const harness = cursorHarness([stream]);
    const initial = cursorRequest("session-checkpoint-cycle", "kimi-k3-1m");
    const firstContinuation = cursorContinuation(initial, [first], [
      cursorResult(first, "first result"),
    ]);

    try {
      await collectCursorResponse(harness.adapter, initial);
      const secondSegmentEvents = await collectCursorResponse(
        harness.adapter,
        firstContinuation,
      );
      expect(cursorCompletedUsage(secondSegmentEvents)).toMatchObject({
        input_tokens: 120_000,
        context_window: 256_000,
      });

      const finalEvents = await collectCursorResponse(harness.adapter, {
        ...firstContinuation,
        input: [
          ...firstContinuation.input,
          {
            type: "function_call",
            call_id: second.callId,
            name: second.name,
            arguments: JSON.stringify({ path: "README.md" }),
          },
          cursorResult(second, "second result"),
        ],
      });
      expect(canonicalText(finalEvents)).toBe("two cycles complete");
      expect(cursorMcpResultWrites(stream)).toHaveLength(2);
      expect(harness.openedStreams).toBe(1);
    } finally {
      harness.adapter.dispose();
    }
  });

  it("drops a carried checkpoint once the conversation shrinks below it", async () => {
    // 소비 측은 보관 체크포인트를 입력 토큰의 바닥으로 쓴다. Claude Code가 컴팩트해
    // 대화가 급감해도 바닥이 남아 있으면 계기가 세션이 끝날 때까지 그 값에 고정된다.
    const largeStream = new BridgeCursorStream([
      {
        conversationCheckpointUpdate: {
          tokenDetails: { usedTokens: 120_000, maxTokens: 256_000 },
        },
      },
      ...cursorCompletionFrames("large turn complete"),
    ]);
    const compactedStream = new BridgeCursorStream(
      cursorCompletionFrames("compacted turn complete"),
    );
    const harness = cursorHarness([largeStream, compactedStream]);
    const base = cursorRequest("session-checkpoint-staleness", "kimi-k3-1m");
    const large: CanonicalResponseRequest = {
      ...base,
      input: [{ type: "message", role: "user", content: "x".repeat(60_000) }],
    };

    try {
      const largeUsage = cursorCompletedUsage(
        await collectCursorResponse(harness.adapter, large),
      );
      expect(largeUsage?.input_tokens).toBeGreaterThan(100_000);

      const compactedUsage = cursorCompletedUsage(
        await collectCursorResponse(harness.adapter, base),
      );
      expect(compactedUsage?.input_tokens).toBeLessThan(10_000);
    } finally {
      harness.adapter.dispose();
    }
  });

  it("refuses the next turn once Cursor's own count fills the model window", async () => {
    // 이 지점이 곧 Claude Code의 점유 계기가 1M 좌표에서 포화하는 지점이다. 넘어가면
    // 대화가 더 커져도 계기가 움직이지 않아 클라이언트가 자기 압축 임계를 볼 수 없다.
    const saturating = new BridgeCursorStream([
      {
        conversationCheckpointUpdate: {
          tokenDetails: { usedTokens: 256_000, maxTokens: 256_000 },
        },
      },
      ...cursorCompletionFrames("window is full"),
    ]);
    const harness = cursorHarness([saturating]);
    const request = cursorRequest("session-window-saturated", "kimi-k3-1m");

    try {
      await collectCursorResponse(harness.adapter, request);

      await expect(harness.adapter.stream(request, {
        apiKey: "cursor-test-token",
        modelContextWindow: 256_000,
      })).rejects.toBeInstanceOf(ContextWindowExceededError);
      // 거절된 턴은 업스트림에 닿지 않는다.
      expect(harness.openedStreams).toBe(1);
    } finally {
      harness.adapter.dispose();
    }
  });

  it("refuses a tool continuation at the window instead of reattaching blind", async () => {
    // bridge를 지원하는 모델은 tool 결과가 parked Run에 붙으므로 cold Run 경로를
    // 타지 않는다. 그 경로에만 검사를 두면 tool을 쓰는 세션 전체가 포화된 계기로
    // 계속 달린다 — 정확히 이 수정이 없애려는 상태다.
    const call = cursorCall("call-window-full", 61);
    const stream = new BridgeCursorStream([
      {
        conversationCheckpointUpdate: {
          tokenDetails: { usedTokens: 256_000, maxTokens: 256_000 },
        },
      },
      ...cursorToolFrames([call]),
    ]);
    const harness = cursorHarness([stream]);
    const initial = cursorRequest("session-window-continuation", "kimi-k3-1m");

    try {
      await collectCursorResponse(harness.adapter, initial);
      const continuation = cursorContinuation(initial, [call], [
        cursorResult(call, "tool result"),
      ]);

      await expect(harness.adapter.stream(continuation, {
        apiKey: "cursor-test-token",
        modelContextWindow: 256_000,
      })).rejects.toBeInstanceOf(ContextWindowExceededError);
      expect(harness.openedStreams).toBe(1);
    } finally {
      harness.adapter.dispose();
    }
  });

  it("forces a compacted retry to open a cold Run instead of the saturated one", async () => {
    // mismatch 판정은 대화 내용을 보지 않는다. 압축된 재시도가 같은 call id를 보존하면
    // 그대로 통과해 이미 포화된 Run에 다시 붙고, 압축은 클라이언트에만 반영된 채
    // 업스트림 세션은 가득 찬 상태로 이어진다.
    const call = cursorCall("call-window-retry", 62);
    const parked = new BridgeCursorStream(
      [
        {
          conversationCheckpointUpdate: {
            tokenDetails: { usedTokens: 256_000, maxTokens: 256_000 },
          },
        },
        ...cursorToolFrames([call]),
      ],
      cursorCompletionFrames("saturated run continued"),
      1,
    );
    const cold = new BridgeCursorStream(cursorCompletionFrames("cold run opened"));
    const harness = cursorHarness([parked, cold]);
    const base = cursorRequest("session-window-retry", "kimi-k3-1m");
    const large: CanonicalResponseRequest = {
      ...base,
      input: [{ type: "message", role: "user", content: "x".repeat(60_000) }],
    };

    try {
      await collectCursorResponse(harness.adapter, large);
      await expect(harness.adapter.stream(
        cursorContinuation(large, [call], [cursorResult(call, "tool result")]),
        { apiKey: "cursor-test-token", modelContextWindow: 256_000 },
      )).rejects.toBeInstanceOf(ContextWindowExceededError);

      // 압축된 재시도 — 히스토리는 줄었지만 진행 중이던 call/result는 보존된다.
      const events = await collectAdapterEvents(await harness.adapter.stream(
        cursorContinuation(base, [call], [cursorResult(call, "tool result")]),
        { apiKey: "cursor-test-token", modelContextWindow: 256_000 },
      ));

      expect(canonicalText(events)).toBe("cold run opened");
      expect(harness.openedStreams).toBe(2);
    } finally {
      harness.adapter.dispose();
    }
  });

  it("opens cold when the first request after a saturated call is already compacted", async () => {
    // Claude Code가 413을 받기 전에 스스로 압축하면 거절 경로가 아예 실행되지 않는다.
    // 그때도 parked Run이 전제한 대화는 사라졌으므로 붙여서는 안 된다.
    const call = cursorCall("call-window-selfcompact", 63);
    const parked = new BridgeCursorStream(
      [
        {
          conversationCheckpointUpdate: {
            tokenDetails: { usedTokens: 256_000, maxTokens: 256_000 },
          },
        },
        ...cursorToolFrames([call]),
      ],
      cursorCompletionFrames("saturated run continued"),
      1,
    );
    const cold = new BridgeCursorStream(cursorCompletionFrames("cold run opened"));
    const harness = cursorHarness([parked, cold]);
    const base = cursorRequest("session-window-selfcompact", "kimi-k3-1m");
    const large: CanonicalResponseRequest = {
      ...base,
      input: [{ type: "message", role: "user", content: "x".repeat(60_000) }],
    };

    try {
      await collectCursorResponse(harness.adapter, large);

      // 413 없이 곧바로 압축된 continuation이 도착한다.
      const events = await collectAdapterEvents(await harness.adapter.stream(
        cursorContinuation(base, [call], [cursorResult(call, "tool result")]),
        { apiKey: "cursor-test-token", modelContextWindow: 256_000 },
      ));

      expect(canonicalText(events)).toBe("cold run opened");
      expect(harness.openedStreams).toBe(2);
    } finally {
      harness.adapter.dispose();
    }
  });

  it("stays out of the way while Cursor's count is under the window", async () => {
    const belowWindow = new BridgeCursorStream([
      {
        conversationCheckpointUpdate: {
          tokenDetails: { usedTokens: 255_999, maxTokens: 256_000 },
        },
      },
      ...cursorCompletionFrames("first turn complete"),
    ]);
    const next = new BridgeCursorStream(cursorCompletionFrames("second turn complete"));
    const harness = cursorHarness([belowWindow, next]);
    const request = cursorRequest("session-window-under", "kimi-k3-1m");

    try {
      await collectCursorResponse(harness.adapter, request);
      const events = await collectAdapterEvents(await harness.adapter.stream(request, {
        apiKey: "cursor-test-token",
        modelContextWindow: 256_000,
      }));

      expect(canonicalText(events)).toBe("second turn complete");
      expect(harness.openedStreams).toBe(2);
    } finally {
      harness.adapter.dispose();
    }
  });

  it("lets a compacted retry through instead of refusing it again", async () => {
    // 413을 받은 Claude Code는 압축 후 훨씬 작은 요청을 다시 보낸다. 그 축소가
    // 체크포인트를 폐기시키므로 같은 거절이 반복되지 않는다.
    const saturating = new BridgeCursorStream([
      {
        conversationCheckpointUpdate: {
          tokenDetails: { usedTokens: 256_000, maxTokens: 256_000 },
        },
      },
      ...cursorCompletionFrames("window is full"),
    ]);
    const compacted = new BridgeCursorStream(cursorCompletionFrames("compacted turn complete"));
    const harness = cursorHarness([saturating, compacted]);
    const base = cursorRequest("session-window-compacted", "kimi-k3-1m");
    const large: CanonicalResponseRequest = {
      ...base,
      input: [{ type: "message", role: "user", content: "x".repeat(60_000) }],
    };

    try {
      await collectCursorResponse(harness.adapter, large);
      const events = await collectAdapterEvents(await harness.adapter.stream(base, {
        apiKey: "cursor-test-token",
        modelContextWindow: 256_000,
      }));

      expect(canonicalText(events)).toBe("compacted turn complete");
      expect(harness.openedStreams).toBe(2);
    } finally {
      harness.adapter.dispose();
    }
  });

  it.each(["partial", "extra", "duplicate", "stale"])(
    "rejects a %s result batch without injecting and falls back cold",
    async (kind) => {
      const calls = [cursorCall("call-a", 41), cursorCall("call-b", 42)];
      const parked = new BridgeCursorStream(cursorToolFrames(calls));
      const fallback = new BridgeCursorStream(cursorCompletionFrames("cold fallback"));
      const harness = cursorHarness([parked, fallback]);
      const initial = cursorRequest(`session-${kind}`, "kimi-k3-1m");
      const exact = calls.map((call) => cursorResult(call, `${call.callId} result`));
      const results = kind === "partial"
        ? exact.slice(0, 1)
        : kind === "extra"
          ? [...exact, { call_id: "call-extra", output: "extra" }]
          : kind === "duplicate"
            ? [exact[0]!, exact[0]!]
            : [exact[0]!, { call_id: "call-stale", output: "stale" }];

      try {
        await collectCursorResponse(harness.adapter, initial);
        const events = await collectCursorResponse(
          harness.adapter,
          cursorContinuation(initial, calls, results),
        );

        expect(canonicalText(events)).toBe("cold fallback");
        expect(cursorMcpResultWrites(parked)).toHaveLength(0);
        expect(parked.closeCode).toBe(http2.constants.NGHTTP2_CANCEL);
        expect(harness.openedStreams).toBe(2);
        expect(cursorClientWrites(fallback)[0]).toMatchObject({
          runRequest: { action: { resumeAction: {} } },
        });
      } finally {
        harness.adapter.dispose();
      }
    },
  );

  it.each(["model", "effort", "tool catalog"])(
    "partitions pending Runs by exact %s",
    async (partition) => {
      const call = cursorCall("call-separated", 51);
      const parked = new BridgeCursorStream(cursorToolFrames([call]));
      const fallback = new BridgeCursorStream(cursorCompletionFrames("separate fallback"));
      const harness = cursorHarness([parked, fallback]);
      const initial = cursorRequest(
        `session-separation-${partition}`,
        partition === "effort" ? "kimi-k3" : "kimi-k3-1m",
        partition === "effort" ? "low" : undefined,
      );
      let continuation = cursorContinuation(initial, [call], [cursorResult(call, "done")]);
      if (partition === "model") continuation = { ...continuation, model: "claude-opus-5" };
      if (partition === "effort") {
        continuation = { ...continuation, reasoning: { summary: "auto", effort: "high" } };
      }
      if (partition === "tool catalog") {
        continuation = {
          ...continuation,
          tools: continuation.tools?.map((tool) => ({ ...tool, description: "changed catalog" })),
        };
      }

      try {
        await collectCursorResponse(harness.adapter, initial);
        await collectCursorResponse(harness.adapter, continuation);

        expect(cursorMcpResultWrites(parked)).toHaveLength(0);
        expect(parked.closeCode).toBe(http2.constants.NGHTTP2_CANCEL);
        expect(harness.openedStreams).toBe(2);
      } finally {
        harness.adapter.dispose();
      }
    },
  );

  it("cold-resumes a live model when ToolSearch activates deferred tools", async () => {
    const initial: CanonicalResponseRequest = {
      model: "claude-opus-5",
      instructions: "Use ToolSearch before calling a deferred Fleet tool.",
      input: [{ type: "message", role: "user", content: "Dispatch a Fleet carrier." }],
      tools: [
        {
          type: "function",
          name: "ToolSearch",
          description: "Load deferred tools",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
        {
          type: "function",
          name: "mcp__fleet__carrier_dispatch",
          description: "Dispatch a Fleet carrier",
          parameters: { type: "object", properties: {} },
          defer_loading: true,
        },
      ],
      metadata: { user_id: "session-tool-search-catalog" },
      stream: true,
    };
    const initialPlan = buildCursorRunPlan(initial, "conversation-tool-search-catalog");
    const toolSearchWireName = initialPlan.tools.find((tool) => (
      tool.clientName === "ToolSearch"
    ))?.toolName;
    if (!toolSearchWireName) throw new Error("Missing ToolSearch wire alias");
    const call: CursorCallSpec = {
      ...cursorCall("call-tool-search", 59),
      name: toolSearchWireName,
    };
    const parked = new BridgeCursorStream(cursorToolFrames([call]));
    const fallback = new BridgeCursorStream(cursorCompletionFrames("deferred tool loaded"));
    const harness = cursorHarness([parked, fallback]);
    const continuation: CanonicalResponseRequest = {
      ...initial,
      input: [
        initial.input[0]!,
        {
          type: "function_call",
          call_id: call.callId,
          name: "ToolSearch",
          arguments: '{"query":"select:mcp__fleet__carrier_dispatch"}',
        },
        {
          type: "function_call_output",
          call_id: call.callId,
          output: '{"type":"tool_reference","tool_name":"mcp__fleet__carrier_dispatch"}',
          tool_references: ["mcp__fleet__carrier_dispatch"],
        },
      ],
    };

    try {
      await collectCursorResponse(harness.adapter, initial);
      const events = await collectCursorResponse(harness.adapter, continuation);

      expect(canonicalText(events)).toBe("deferred tool loaded");
      expect(cursorMcpResultWrites(parked)).toHaveLength(0);
      expect(parked.closeCode).toBe(http2.constants.NGHTTP2_CANCEL);
      expect(harness.openedStreams).toBe(2);
      expect(cursorClientWrites(fallback)[0]).toMatchObject({
        runRequest: {
          mcpTools: {
            mcpTools: expect.arrayContaining([
              expect.objectContaining({ toolName: "mcp__fleet__carrier_dispatch" }),
            ]),
          },
        },
      });
    } finally {
      harness.adapter.dispose();
    }
  });

  it("keeps credential A parked while credential B cold-resumes the same conversation", async () => {
    const credentialA = "cursor-credential-a";
    const credentialB = "cursor-credential-b";
    const call = cursorCall("call-credential-partition", 56);
    const credentialARun = new BridgeCursorStream(
      cursorToolFrames([call]),
      cursorCompletionFrames("credential A attached"),
      1,
    );
    const credentialBRun = new BridgeCursorStream(
      cursorCompletionFrames("credential B cold fallback"),
    );
    const harness = cursorHarness([credentialARun, credentialBRun]);
    const initial = cursorRequest("shared-credential-conversation", "kimi-k3-1m");
    const continuation = cursorContinuation(initial, [call], [cursorResult(call, "done")]);

    try {
      await collectCursorResponse(harness.adapter, initial, credentialA);
      const credentialBEvents = await collectCursorResponse(
        harness.adapter,
        continuation,
        credentialB,
      );

      expect(canonicalText(credentialBEvents)).toBe("credential B cold fallback");
      expect(credentialARun.closed).toBe(false);
      expect(cursorMcpResultWrites(credentialARun)).toHaveLength(0);
      expect(cursorMcpResultWrites(credentialBRun)).toHaveLength(0);
      expect(cursorClientWrites(credentialBRun)[0]).toMatchObject({
        runRequest: { action: { resumeAction: {} } },
      });

      const credentialAEvents = await collectCursorResponse(
        harness.adapter,
        continuation,
        credentialA,
      );
      expect(canonicalText(credentialAEvents)).toBe("credential A attached");
      expect(cursorMcpResultWrites(credentialARun)).toHaveLength(1);
      expect(cursorMcpResultWrites(credentialBRun)).toHaveLength(0);
      expect(harness.openedStreams).toBe(2);
    } finally {
      harness.adapter.dispose();
    }
  });

  it("does not supersede credential A when credential B sends a new prompt", async () => {
    const diagnostics: CursorDiagnosticEvent[] = [];
    const credentialA = "cursor-prompt-credential-a";
    const credentialB = "cursor-prompt-credential-b";
    const call = cursorCall("call-cross-credential-prompt", 57);
    const credentialARun = new BridgeCursorStream(
      cursorToolFrames([call]),
      cursorCompletionFrames("credential A survived"),
      1,
    );
    const credentialBRun = new BridgeCursorStream(
      cursorCompletionFrames("credential B prompt complete"),
    );
    const harness = cursorHarness([credentialARun, credentialBRun], {
      diagnostics: (event) => diagnostics.push(event),
    });
    const initial = cursorRequest("shared-prompt-conversation", "kimi-k3-1m");

    try {
      await collectCursorResponse(harness.adapter, initial, credentialA);
      const credentialBEvents = await collectCursorResponse(harness.adapter, {
        ...initial,
        model: "claude-opus-5",
        input: [{ type: "message", role: "user", content: "Start another task." }],
      }, credentialB);

      expect(canonicalText(credentialBEvents)).toBe("credential B prompt complete");
      expect(credentialARun.closed).toBe(false);
      expect(cursorMcpResultWrites(credentialARun)).toHaveLength(0);
      expect(diagnostics.filter((event) => event.event === "model.switch")).toHaveLength(0);

      const credentialAEvents = await collectCursorResponse(
        harness.adapter,
        cursorContinuation(initial, [call], [cursorResult(call, "done")]),
        credentialA,
      );
      expect(canonicalText(credentialAEvents)).toBe("credential A survived");
      expect(cursorMcpResultWrites(credentialARun)).toHaveLength(1);
      expect(harness.openedStreams).toBe(2);
    } finally {
      harness.adapter.dispose();
    }
  });

  it("does not cross-attach a different conversation", async () => {
    const call = cursorCall("call-conversation", 61);
    const parked = new BridgeCursorStream(cursorToolFrames([call]));
    const separate = new BridgeCursorStream(cursorCompletionFrames("other conversation"));
    const harness = cursorHarness([parked, separate]);
    const initial = cursorRequest("conversation-a", "kimi-k3-1m");
    const other = cursorContinuation(
      cursorRequest("conversation-b", "kimi-k3-1m"),
      [call],
      [cursorResult(call, "wrong conversation")],
    );

    await collectCursorResponse(harness.adapter, initial);
    await collectCursorResponse(harness.adapter, other);
    expect(cursorMcpResultWrites(parked)).toHaveLength(0);
    expect(harness.openedStreams).toBe(2);
    expect(parked.closed).toBe(false);
    harness.adapter.dispose();
    expect(parked.closed).toBe(true);
  });

  it("atomically claims a pending Run so concurrent attaches cannot double-write", async () => {
    const call = cursorCall("call-atomic", 71);
    const parked = new BridgeCursorStream(
      cursorToolFrames([call]),
      cursorCompletionFrames("attached once"),
      1,
    );
    const fallback = new BridgeCursorStream(cursorCompletionFrames("duplicate fallback"));
    const harness = cursorHarness([parked, fallback]);
    const initial = cursorRequest("session-atomic", "claude-fable-5");
    const continuation = cursorContinuation(initial, [call], [cursorResult(call, "once")]);

    try {
      await collectCursorResponse(harness.adapter, initial);
      const responses = await Promise.all([
        harness.adapter.stream(continuation, { apiKey: "cursor-test-token" }),
        harness.adapter.stream(continuation, { apiKey: "cursor-test-token" }),
      ]);
      await Promise.all(responses.map(collectAdapterEvents));

      expect(cursorMcpResultWrites(parked)).toHaveLength(1);
      expect(harness.openedStreams).toBe(2);
      expect(cursorClientWrites(fallback)[0]).toMatchObject({
        runRequest: { action: { resumeAction: {} } },
      });
    } finally {
      harness.adapter.dispose();
    }
  });

  it("expires parked Runs at the injected TTL and closes transport state", async () => {
    const diagnostics: CursorDiagnosticEvent[] = [];
    const call = cursorCall("call-expire", 81);
    const parked = new BridgeCursorStream(cursorToolFrames([call]));
    const harness = cursorHarness([parked], {
      pendingLiveRunTtlMs: 5,
      diagnostics: (event) => diagnostics.push(event),
    });

    await collectCursorResponse(
      harness.adapter,
      cursorRequest("session-expire", "kimi-k3-1m"),
    );
    await waitFor(() => parked.closed);

    expect(parked.closeCode).toBe(http2.constants.NGHTTP2_CANCEL);
    expect(harness.sessions[0]?.closeCount).toBeGreaterThan(0);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: "bridge.expire",
      outcome: "ttl",
    }));
    harness.adapter.dispose();
  });

  it("evicts by injected capacity and dispose closes the remaining parked Run", async () => {
    const callA = cursorCall("call-capacity-a", 91);
    const callB = cursorCall("call-capacity-b", 92);
    const streamA = new BridgeCursorStream(cursorToolFrames([callA]));
    const streamB = new BridgeCursorStream(cursorToolFrames([callB]));
    const harness = cursorHarness([streamA, streamB], { pendingLiveRunCapacity: 1 });

    await collectCursorResponse(harness.adapter, cursorRequest("capacity-a", "kimi-k3-1m"));
    await collectCursorResponse(harness.adapter, cursorRequest("capacity-b", "kimi-k3-1m"));
    expect(streamA.closed).toBe(true);
    expect(streamA.closeCode).toBe(http2.constants.NGHTTP2_CANCEL);
    expect(streamB.closed).toBe(false);

    harness.adapter.dispose();
    expect(streamB.closed).toBe(true);
    expect(harness.sessions[1]?.closeCount).toBeGreaterThan(0);
  });

  it("rejects cross-credential capacity pressure without evicting the parked owner", async () => {
    const diagnostics: CursorDiagnosticEvent[] = [];
    const credentialA = "capacity-credential-a";
    const credentialB = "capacity-credential-b";
    const callA = cursorCall("call-capacity-owner", 93);
    const callB = cursorCall("call-capacity-rejected", 94);
    const streamA = new BridgeCursorStream(
      cursorToolFrames([callA]),
      cursorCompletionFrames("credential A attached after pressure"),
      1,
    );
    const rejectedB = new BridgeCursorStream(cursorToolFrames([callB]));
    const fallbackB = new BridgeCursorStream(cursorCompletionFrames("credential B cold fallback"));
    const harness = cursorHarness([streamA, rejectedB, fallbackB], {
      pendingLiveRunCapacity: 1,
      diagnostics: (event) => diagnostics.push(event),
    });
    const requestA = cursorRequest("capacity-owner", "kimi-k3-1m");
    const requestB = cursorRequest("capacity-pressure", "kimi-k3-1m");

    try {
      await collectCursorResponse(harness.adapter, requestA, credentialA);
      await collectCursorResponse(harness.adapter, requestB, credentialB);

      expect(streamA.closed).toBe(false);
      expect(rejectedB.closeCode).toBe(http2.constants.NGHTTP2_CANCEL);
      expect(harness.sessions[1]?.closeCount).toBe(1);
      expect(diagnostics).toContainEqual(expect.objectContaining({
        event: "bridge.expire",
        outcome: "capacity_rejected",
      }));
      expect(cursorAdapterLiveState(harness.adapter)).toEqual({
        liveRuns: 1,
        pendingRuns: 1,
        pendingTimers: 1,
      });

      const credentialBEvents = await collectCursorResponse(
        harness.adapter,
        cursorContinuation(requestB, [callB], [cursorResult(callB, "B result")]),
        credentialB,
      );
      expect(canonicalText(credentialBEvents)).toBe("credential B cold fallback");
      expect(streamA.closed).toBe(false);
      expect(cursorAdapterLiveState(harness.adapter)).toEqual({
        liveRuns: 1,
        pendingRuns: 1,
        pendingTimers: 1,
      });

      const credentialAEvents = await collectCursorResponse(
        harness.adapter,
        cursorContinuation(requestA, [callA], [cursorResult(callA, "A result")]),
        credentialA,
      );
      expect(canonicalText(credentialAEvents)).toBe("credential A attached after pressure");
      expect(cursorMcpResultWrites(streamA)).toHaveLength(1);
      expect(cursorMcpResultWrites(rejectedB)).toHaveLength(0);
      expect(cursorMcpResultWrites(fallbackB)).toHaveLength(0);
      expect(harness.openedStreams).toBe(3);
      expect(harness.sessions[1]?.closeCount).toBe(1);
      expect(cursorAdapterLiveState(harness.adapter)).toEqual({
        liveRuns: 0,
        pendingRuns: 0,
        pendingTimers: 0,
      });
    } finally {
      harness.adapter.dispose();
    }
  });

  it("detaches the suspended segment abort and binds the attached segment abort", async () => {
    const call = cursorCall("call-abort", 101);
    const stream = new BridgeCursorStream(cursorToolFrames([call]), [], 1);
    const harness = cursorHarness([stream]);
    const firstController = new AbortController();
    const initial = cursorRequest("session-abort-segment", "kimi-k3-1m");

    await collectCursorResponse(
      harness.adapter,
      initial,
      "cursor-test-token",
      firstController.signal,
    );
    firstController.abort();
    expect(stream.closed).toBe(false);

    const secondController = new AbortController();
    const response = await harness.adapter.stream(
      cursorContinuation(initial, [call], [cursorResult(call, "done")]),
      { apiKey: "cursor-test-token", signal: secondController.signal },
    );
    const collecting = collectAdapterEvents(response);
    secondController.abort();
    await expect(collecting).rejects.toThrow("cancelled by caller");
    expect(stream.closed).toBe(true);
    expect(harness.sessions[0]?.closeCount).toBeGreaterThan(0);
    harness.adapter.dispose();
  });

  it("cancels an attached Run when the client aborts before suspension", async () => {
    const stream = new BridgeCursorStream([]);
    const harness = cursorHarness([stream]);
    const controller = new AbortController();
    const response = await harness.adapter.stream(
      cursorRequest("session-abort-before", "kimi-k3-1m"),
      { apiKey: "cursor-test-token", signal: controller.signal },
    );
    const collecting = collectAdapterEvents(response);
    controller.abort();

    await expect(collecting).rejects.toThrow("cancelled by caller");
    expect(stream.closed).toBe(true);
    expect(harness.sessions[0]?.closeCount).toBeGreaterThan(0);
    harness.adapter.dispose();
  });

  it("a new user prompt supersedes and disposes the parked Run", async () => {
    const call = cursorCall("call-superseded", 111);
    const parked = new BridgeCursorStream(cursorToolFrames([call]));
    const nextRun = new BridgeCursorStream(cursorCompletionFrames("new prompt complete"));
    const harness = cursorHarness([parked, nextRun]);
    const initial = cursorRequest("session-new-prompt", "kimi-k3-1m");

    try {
      await collectCursorResponse(harness.adapter, initial);
      const events = await collectCursorResponse(harness.adapter, {
        ...initial,
        input: [{ type: "message", role: "user", content: "Start a different task." }],
      });

      expect(canonicalText(events)).toBe("new prompt complete");
      expect(cursorMcpResultWrites(parked)).toHaveLength(0);
      expect(parked.closeCode).toBe(http2.constants.NGHTTP2_CANCEL);
      expect(cursorClientWrites(nextRun)[0]).toMatchObject({
        runRequest: { action: { userMessageAction: {} } },
      });
    } finally {
      harness.adapter.dispose();
    }
  });

  it.each(["auto", "composer-2.5", "grok-4.5"])(
    "keeps %s on frozen cancel and cold-resume behavior",
    async (model) => {
      const call = cursorCall(`call-frozen-${model}`, 121);
      const first = new BridgeCursorStream(cursorToolFrames([call]));
      const resumed = new BridgeCursorStream(cursorCompletionFrames("cold model complete"));
      const harness = cursorHarness([first, resumed]);
      const initial = cursorRequest(`session-frozen-${model}`, model);

      try {
        await collectCursorResponse(harness.adapter, initial);
        await collectCursorResponse(
          harness.adapter,
          cursorContinuation(initial, [call], [cursorResult(call, "done")]),
        );

        expect(harness.openedStreams).toBe(2);
        expect(cursorMcpResultWrites(first)).toHaveLength(0);
        expect(first.closeCode).toBe(http2.constants.NGHTTP2_CANCEL);
        expect(cursorClientWrites(resumed)[0]).toMatchObject({
          runRequest: { action: { resumeAction: {} } },
        });
      } finally {
        harness.adapter.dispose();
      }
    },
  );
});

async function expectCorrelationBatchColdFallback(
  frames: readonly unknown[],
  calls: readonly CursorCallSpec[],
  userId: string,
): Promise<void> {
  const rejected = new BridgeCursorStream(frames);
  const fallback = new BridgeCursorStream(cursorCompletionFrames("correlation cold fallback"));
  const harness = cursorHarness([rejected, fallback]);
  const initial = cursorRequest(userId, "kimi-k3-1m");

  try {
    await collectCursorResponse(harness.adapter, initial);
    const events = await collectCursorResponse(
      harness.adapter,
      cursorContinuation(
        initial,
        calls,
        calls.map((call) => cursorResult(call, `${call.callId} result`)),
      ),
    );

    expect(canonicalText(events)).toBe("correlation cold fallback");
    expect(cursorMcpResultWrites(rejected)).toHaveLength(0);
    expect(rejected.closeCode).toBe(http2.constants.NGHTTP2_CANCEL);
    expect(cursorClientWrites(fallback)[0]).toMatchObject({
      runRequest: { action: { resumeAction: {} } },
    });
    expect(harness.openedStreams).toBe(2);
  } finally {
    harness.adapter.dispose();
  }
}

interface CursorCallSpec {
  readonly callId: string;
  readonly toolCallId: string;
  readonly messageId: number;
  readonly execId: string;
  readonly name: string;
}

function cursorCall(callId: string, messageId: number): CursorCallSpec {
  return {
    callId,
    toolCallId: `cursor-${callId}`,
    messageId,
    execId: `exec-${messageId}`,
    name: "probe_tool",
  };
}

function cursorResult(
  call: CursorCallSpec,
  output: string,
  isError = false,
): Extract<CanonicalResponseRequest["input"][number], { type: "function_call_output" }> {
  return {
    type: "function_call_output",
    call_id: call.callId,
    output,
    ...(isError ? { is_error: true } : {}),
  };
}

const PROBE_TOOLS: readonly CanonicalFunctionTool[] = [{
  type: "function",
  name: "probe_tool",
  description: "Read a named path",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
}];

function cursorRequest(
  userId: string,
  model: string,
  effort?: ReasoningEffort,
): CanonicalResponseRequest {
  return {
    model,
    instructions: "Use probe_tool and continue until complete.",
    input: [{ type: "message", role: "user", content: "Read README.md." }],
    tools: PROBE_TOOLS.map((tool) => ({ ...tool })),
    metadata: { user_id: userId },
    ...(effort === undefined ? {} : { reasoning: { summary: "auto", effort } }),
    stream: true,
  };
}

function cursorContinuation(
  initial: CanonicalResponseRequest,
  calls: readonly CursorCallSpec[],
  results: readonly { readonly call_id: string; readonly output: string; readonly is_error?: boolean }[],
): CanonicalResponseRequest {
  return {
    ...initial,
    input: [
      initial.input[0]!,
      ...calls.map((call) => ({
        type: "function_call" as const,
        call_id: call.callId,
        name: call.name,
        arguments: JSON.stringify({ path: "README.md" }),
      })),
      ...results.map((result) => ({
        type: "function_call_output" as const,
        call_id: result.call_id,
        output: result.output,
        ...(result.is_error === undefined ? {} : { is_error: result.is_error }),
      })),
    ],
  };
}

function cursorToolFrames(calls: readonly CursorCallSpec[]): unknown[] {
  return calls.flatMap((call) => [
    cursorToolStartedFrame(call),
    cursorExecFrame(call),
  ]);
}

function cursorToolStartedFrame(call: CursorCallSpec): unknown {
  return cursorToolUpdateFrame("toolCallStarted", call);
}

function cursorToolPartialFrame(call: CursorCallSpec): unknown {
  return cursorToolUpdateFrame("partialToolCall", call, { argsTextDelta: "{}" });
}

function cursorToolCompletedFrame(call: CursorCallSpec): unknown {
  return cursorToolUpdateFrame("toolCallCompleted", call);
}

function cursorToolUpdateFrame(
  update: "toolCallStarted" | "partialToolCall" | "toolCallCompleted",
  call: CursorCallSpec,
  extra: Record<string, unknown> = {},
): unknown {
  return {
    interactionUpdate: {
      [update]: {
        callId: call.callId,
        toolCall: {
          mcpToolCall: {
            args: {
              name: call.name,
              toolName: call.name,
              toolCallId: call.toolCallId,
              providerIdentifier: CURSOR_TOOL_PROVIDER_IDENTIFIER,
            },
          },
        },
        ...extra,
      },
    },
  };
}

function cursorExecFrame(call: CursorCallSpec): unknown {
  return {
    execServerMessage: {
      id: call.messageId,
      execId: call.execId,
      mcpArgs: {
        name: call.name,
        toolName: call.name,
        toolCallId: call.toolCallId,
        providerIdentifier: CURSOR_TOOL_PROVIDER_IDENTIFIER,
        args: { path: cursorValue("README.md") },
      },
    },
  };
}

function cursorCompletionFrames(text: string): unknown[] {
  return [
    { interactionUpdate: { textDelta: { text } } },
    { interactionUpdate: { tokenDelta: { tokens: 4 } } },
    { interactionUpdate: { turnEnded: {} } },
  ];
}

async function collectCursorResponse(
  adapter: CursorAdapter,
  request: CanonicalResponseRequest,
  apiKey = "cursor-test-token",
  signal?: AbortSignal,
): Promise<readonly CanonicalResponseEvent[]> {
  return collectAdapterEvents(await adapter.stream(request, { apiKey, signal }));
}

async function collectCursorResponseWithDiagnostics(
  adapter: CursorAdapter,
  request: CanonicalResponseRequest,
  diagnosticsEnabled: boolean,
): Promise<readonly CanonicalResponseEvent[]> {
  return collectAdapterEvents(await adapter.stream(request, {
    apiKey: "cursor-test-token",
    diagnosticsEnabled,
  }));
}

async function collectAdapterEvents(
  response: Awaited<ReturnType<CursorAdapter["stream"]>>,
): Promise<readonly CanonicalResponseEvent[]> {
  if (!response.ok) throw new Error("Synthetic Cursor response unexpectedly failed");
  const events: CanonicalResponseEvent[] = [];
  for await (const event of response.events) events.push(event);
  return events;
}

function canonicalText(events: readonly CanonicalResponseEvent[]): string {
  return events
    .filter((event): event is Extract<CanonicalResponseEvent, { type: "response.output_text.delta" }> => (
      event.type === "response.output_text.delta"
    ))
    .map((event) => event.delta)
    .join("");
}

function cursorCompletedUsage(events: readonly CanonicalResponseEvent[]) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "response.completed") return event.response.usage;
  }
  throw new Error("Missing Cursor response.completed event");
}

function cursorAdapterLiveState(adapter: CursorAdapter): {
  readonly liveRuns: number;
  readonly pendingRuns: number;
  readonly pendingTimers: number;
} {
  const state = adapter as unknown as {
    readonly liveRuns: ReadonlySet<unknown>;
    readonly pendingLiveRuns: ReadonlyMap<unknown, { readonly timer: unknown }>;
  };
  return {
    liveRuns: state.liveRuns.size,
    pendingRuns: state.pendingLiveRuns.size,
    pendingTimers: new Set([...state.pendingLiveRuns.values()].map((pending) => pending.timer)).size,
  };
}

interface CursorHarness {
  readonly adapter: CursorAdapter;
  readonly sessions: FakeCursorSession[];
  readonly openedStreams: number;
}

function cursorHarness(
  streams: readonly BridgeCursorStream[],
  options: Partial<CursorAdapterOptions> = {},
): CursorHarness {
  const sessions: FakeCursorSession[] = [];
  let openedStreams = 0;
  const connect = (() => {
    const stream = streams[openedStreams];
    if (!stream) throw new Error(`Unexpected Cursor Run ${openedStreams + 1}`);
    openedStreams += 1;
    const session = new FakeCursorSession(stream);
    sessions.push(session);
    return session as unknown as http2.ClientHttp2Session;
  }) as typeof http2.connect;
  const adapter = new CursorAdapter({
    connect,
    idleTimeoutMs: 60_000,
    clientHeartbeatMs: 60_000,
    toolFinalizeGraceMs: 0,
    ...options,
  });
  return {
    adapter,
    sessions,
    get openedStreams() {
      return openedStreams;
    },
  };
}

class FakeCursorSession extends EventEmitter {
  closeCount = 0;

  constructor(private readonly stream: BridgeCursorStream) {
    super();
  }

  request(): BridgeCursorStream {
    return this.stream;
  }

  close(): void {
    this.closeCount += 1;
  }
}

interface BridgeCursorRelease {
  readonly afterMcpResults: number;
  readonly frames: readonly unknown[];
}

class BridgeCursorStream extends EventEmitter {
  readonly writes: Buffer[] = [];
  closed = false;
  destroyed = false;
  writableEnded = false;
  closeCode: number | undefined;
  private initialReleased = false;
  private mcpResultCount = 0;
  private readonly releasedMcpCounts = new Set<number>();
  private readonly continuationReleases: readonly BridgeCursorRelease[];

  constructor(
    private readonly initialFrames: readonly unknown[],
    continuationFrames: readonly unknown[] = [],
    expectedMcpResults?: number,
    additionalReleases: readonly BridgeCursorRelease[] = [],
  ) {
    super();
    this.continuationReleases = [
      ...(expectedMcpResults === undefined
        ? []
        : [{ afterMcpResults: expectedMcpResults, frames: continuationFrames }]),
      ...additionalReleases,
    ];
  }

  setTimeout(): this {
    return this;
  }

  write(chunk: Uint8Array): boolean {
    const value = Buffer.from(chunk);
    this.writes.push(value);
    const message = decodeCursorClientFrame(value);
    if (!this.initialReleased && isRecord(message) && message.runRequest !== undefined) {
      this.initialReleased = true;
      this.release(this.initialFrames);
    }
    if (
      isRecord(message)
      && isRecord(message.execClientMessage)
      && message.execClientMessage.mcpResult !== undefined
    ) {
      this.mcpResultCount += 1;
      for (const release of this.continuationReleases) {
        if (
          release.afterMcpResults === this.mcpResultCount
          && !this.releasedMcpCounts.has(release.afterMcpResults)
        ) {
          this.releasedMcpCounts.add(release.afterMcpResults);
          this.release(release.frames);
        }
      }
    }
    return true;
  }

  close(code?: number): void {
    if (this.closed) return;
    this.closeCode = code;
    this.closed = true;
    this.writableEnded = true;
    queueMicrotask(() => this.emit("close"));
  }

  destroy(error?: Error): void {
    if (this.closed) return;
    this.destroyed = true;
    this.closed = true;
    this.writableEnded = true;
    if (error) queueMicrotask(() => this.emit("error", error));
    queueMicrotask(() => this.emit("close"));
  }

  private release(frames: readonly unknown[]): void {
    if (frames.length === 0) return;
    queueMicrotask(() => {
      if (this.closed) return;
      this.emit("data", Buffer.concat(frames.map(encodeCursorServerFrame)));
    });
  }
}

function cursorClientWrites(stream: BridgeCursorStream): Record<string, unknown>[] {
  return stream.writes.map((write) => decodeCursorClientFrame(write));
}

function cursorMcpResultWrites(stream: BridgeCursorStream): Record<string, unknown>[] {
  return cursorClientWrites(stream).flatMap((message) => {
    const exec = isRecord(message.execClientMessage) ? message.execClientMessage : undefined;
    return exec && exec.mcpResult !== undefined ? [exec] : [];
  });
}

function decodeCursorClientFrame(value: Buffer): Record<string, unknown> {
  const frame = decodeConnectFrames(value).frames[0];
  if (!frame) throw new Error("Missing Cursor client frame");
  const decoded = toJson(
    AgentClientMessageSchema,
    fromBinary(AgentClientMessageSchema, frame.payload),
  );
  if (!isRecord(decoded)) throw new Error("Cursor client frame was not an object");
  return decoded;
}

function encodeCursorServerFrame(value: unknown): Buffer {
  const message = fromJson(AgentServerMessageSchema, value as JsonValue);
  return encodeConnectFrame(toBinary(AgentServerMessageSchema, message));
}

function cursorValue(value: JsonValue): string {
  return Buffer.from(toBinary(ValueSchema, fromJson(ValueSchema, value))).toString("base64");
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Cursor test state");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
