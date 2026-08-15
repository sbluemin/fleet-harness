import { EventEmitter } from "node:events";
import http2 from "node:http2";

import { fromBinary, fromJson, toBinary, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { BinaryReader, BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import { afterEach, describe, expect, it } from "vitest";

import {
  CURSOR_TOOL_PROVIDER_IDENTIFIER,
  CursorAdapter,
  CursorSessionIdentityError,
  buildCursorRunPlan,
  decodeConnectFrames,
  encodeConnectFrame,
  resetCursorWireModelMemory,
  resolveCursorSessionIdentity,
} from "../../../src/index.js";
import type {
  CanonicalResponseEvent,
  CanonicalResponseRequest,
  CursorDiagnosticEvent,
} from "../../../src/index.js";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
} from "../../../src/cursor/native/generated/cursor-agent-protobuf.js";
import { cursorNativeExecPolicyReplies } from "../../../src/cursor/native/exec-responses.js";
import {
  cursorNativeExecRedirect,
  cursorNativeRedirectResultReplies,
  isCursorHotPathToolName,
  isCursorNativeRedirectToolName,
} from "../../../src/cursor/native/exec-redirect.js";

afterEach(() => resetCursorWireModelMemory());

describe("Cursor client tool suspension", () => {
  it("completes the turn at execServerMessage instead of waiting forever for turnEnded", async () => {
    const first = await runSyntheticToolTurn("claude-session-a");
    const second = await runSyntheticToolTurn("claude-session-a");
    const other = await runSyntheticToolTurn("claude-session-b");

    const added = first.events.find((event) => event.type === "response.output_item.added");
    const done = first.events.find((event) => event.type === "response.output_item.done");

    expect(added).toMatchObject({ item: { name: "probe_tool" } });
    expect(done).toMatchObject({
      item: {
        name: "probe_tool",
        arguments: JSON.stringify({
          value: "cursor-auto",
          encoded: "cursor-bytes",
          structured: { ok: true },
        }),
      },
    });
    expect(first.events.at(-1)?.type).toBe("response.completed");
    const completed = first.events.at(-1);
    if (completed?.type !== "response.completed") {
      throw new Error("Synthetic Cursor tool turn did not complete");
    }
    expect(completed.response.usage?.input_tokens).toBeGreaterThan(0);
    expect(first.stream.closeCode).toBe(http2.constants.NGHTTP2_CANCEL);
    expect(first.contentType).toBe("application/connect+proto");
    expect(first.requestContextReply).toMatchObject({
      execClientMessage: {
        id: 7,
        execId: "exec-context-7",
        requestContextResult: {
          success: {
            requestContext: {
              tools: [{ name: "probe_tool", toolName: "probe_tool" }],
            },
          },
        },
      },
    });
    expect(first.conversationId).toBe(second.conversationId);
    expect(first.conversationId).not.toBe(other.conversationId);
    expect(first.sessionId).toBe(second.sessionId);
    expect(first.sessionId).not.toBe(other.sessionId);
    expect(first.sessionId).toBe(resolveCursorSessionIdentity(request("claude-session-a")).sessionId);
    expect(first.conversationId).toBe(
      resolveCursorSessionIdentity(request("claude-session-a")).conversationId,
    );
  });

  it("repairs numeric values for client tool arguments declared as strings", async () => {
    const diagnostics: CursorDiagnosticEvent[] = [];
    const taskRequest = taskUpdateRequest();
    const wireName = firstCursorWireToolName(taskRequest);
    const callId = "call-task-update-1";
    const { events } = await runSyntheticCursorTurn([
      {
        interactionUpdate: {
          toolCallStarted: {
            callId,
            toolCall: {
              mcpToolCall: {
                args: {
                  name: wireName,
                  toolCallId: callId,
                  providerIdentifier: CURSOR_TOOL_PROVIDER_IDENTIFIER,
                  toolName: wireName,
                },
              },
            },
          },
        },
      },
      {
        execServerMessage: {
          id: 13,
          execId: "mcp-task-update-13",
          mcpArgs: {
            name: wireName,
            toolCallId: callId,
            providerIdentifier: CURSOR_TOOL_PROVIDER_IDENTIFIER,
            toolName: wireName,
            args: {
              taskId: cursorValue(1),
              status: cursorValue("in_progress"),
              attempt: cursorValue(2),
            },
          },
        },
      },
    ], taskRequest, {
      diagnostics: (event) => diagnostics.push(event),
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: "response.output_item.done",
      item: {
        id: callId,
        type: "function_call",
        call_id: callId,
        name: "TaskUpdate",
        arguments: JSON.stringify({ taskId: "1", status: "in_progress", attempt: 2 }),
      },
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: "client.reply",
      reply: "exec.clientToolSuspend",
      argumentRepairCount: 1,
    }));
  });

  it("maps the Cursor wire alias back to Claude Code's ToolSearch name", async () => {
    const toolRequest: CanonicalResponseRequest = {
      model: "grok-4.5-fast",
      instructions: "Find the requested deferred tool with ToolSearch.",
      input: [{ type: "message", role: "user", content: "Find fleet wiki_read." }],
      tools: [{
        type: "function",
        name: "ToolSearch",
        description: "Load deferred client tools",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      }],
      metadata: { user_id: "claude-session-tool-search" },
      stream: true,
    };
    const wireName = firstCursorWireToolName(toolRequest);
    const callId = "call-tool-search-1";
    const { events } = await runSyntheticCursorTurn([
      {
        interactionUpdate: {
          toolCallStarted: {
            callId,
            toolCall: {
              mcpToolCall: {
                args: {
                  name: wireName,
                  toolCallId: callId,
                  providerIdentifier: CURSOR_TOOL_PROVIDER_IDENTIFIER,
                  toolName: wireName,
                },
              },
            },
          },
        },
      },
      {
        execServerMessage: {
          id: 17,
          execId: "mcp-tool-search-17",
          mcpArgs: {
            name: wireName,
            toolCallId: callId,
            providerIdentifier: CURSOR_TOOL_PROVIDER_IDENTIFIER,
            toolName: wireName,
            args: { query: cursorValue("select:mcp__fleet__wiki_read") },
          },
        },
      },
    ], toolRequest);

    expect(wireName).toMatch(/^cc_tool_search_[a-f0-9]{8}$/);
    expect(events).toContainEqual(expect.objectContaining({
      type: "response.output_item.done",
      item: {
        id: callId,
        type: "function_call",
        call_id: callId,
        name: "ToolSearch",
        arguments: JSON.stringify({ query: "select:mcp__fleet__wiki_read" }),
      },
    }));
  });

  it("rejects Cursor turns that omit metadata.user_id", async () => {
    await expect(runSyntheticCursorTurn([], {
      model: "default",
      instructions: "Call probe_tool.",
      input: [{ type: "message", role: "user", content: "Call the tool now." }],
      stream: true,
    })).rejects.toBeInstanceOf(CursorSessionIdentityError);
  });

  it("emits model.switch when the same Claude session changes Cursor wire models", async () => {
    const diagnostics: CursorDiagnosticEvent[] = [];
    const firstFrames = [
      { interactionUpdate: { textDelta: { text: "ok" } } },
      { interactionUpdate: { tokenDelta: { tokens: 2 } } },
      { conversationCheckpointUpdate: { tokenDetails: { usedTokens: 90_000, maxTokens: 256_000 } } },
      { interactionUpdate: { turnEnded: {} } },
    ];
    const secondFrames = [
      { interactionUpdate: { textDelta: { text: "ok" } } },
      { interactionUpdate: { tokenDelta: { tokens: 2 } } },
      { interactionUpdate: { turnEnded: {} } },
    ];

    await runSyntheticCursorTurn(firstFrames, {
      ...request("claude-session-model-switch"),
      model: "grok-4.5",
      reasoning: { summary: "auto", effort: "low" },
    }, { diagnostics: (event) => diagnostics.push(event) });
    const second = await runSyntheticCursorTurn(secondFrames, {
      ...request("claude-session-model-switch"),
      model: "grok-4.5",
      reasoning: { summary: "auto", effort: "high" },
    }, { diagnostics: (event) => diagnostics.push(event) });

    expect(diagnostics.filter((event) => event.event === "model.switch")).toEqual([
      expect.objectContaining({
        event: "model.switch",
        model: "grok-4.5",
        previousWireModel: "cursor-grok-4.5-low",
        wireModel: "cursor-grok-4.5-high",
      }),
    ]);
    expect(completedCursorUsage(second.events).input_tokens).toBeLessThan(90_000);
    expect(completedCursorUsage(second.events)).not.toHaveProperty("context_window");
  });

  it("rejects unmatched native exec, then completes a client tool turn", async () => {
    const callId = "call-probe-1";
    const clientRequest = request("claude-session-native-retry");
    const wireName = firstCursorWireToolName(clientRequest);
    expect(wireName).toBe("probe_tool");
    const { events, stream } = await runSyntheticCursorTurn([
      {
        interactionUpdate: {
          partialToolCall: {
            callId: "native-glob-1",
            toolCall: { globToolCall: { args: Buffer.from("{}", "utf8").toString("base64") } },
          },
        },
      },
      {
        execServerMessage: {
          id: 11,
          execId: "grep-11",
          grepArgs: { pattern: "README", path: "." },
        },
      },
      {
        execServerMessage: {
          id: 12,
          execId: "shell-12",
          shellStreamArgs: { command: "find . -maxdepth 1 -type f", workingDirectory: "/workspace" },
        },
      },
      {
        interactionUpdate: {
          toolCallStarted: {
            callId,
            toolCall: {
              mcpToolCall: {
                args: {
                  name: wireName,
                  toolCallId: callId,
                  providerIdentifier: CURSOR_TOOL_PROVIDER_IDENTIFIER,
                  toolName: wireName,
                },
              },
            },
          },
        },
      },
      {
        execServerMessage: {
          id: 13,
          execId: "mcp-13",
          mcpArgs: {
            name: wireName,
            toolCallId: callId,
            providerIdentifier: CURSOR_TOOL_PROVIDER_IDENTIFIER,
            toolName: wireName,
            args: { value: cursorValue("probe") },
          },
        },
      },
      // A late native update must not cancel the client-tool finalizer.
      {
        interactionUpdate: {
          toolCallCompleted: {
            callId: "native-shell-1",
            toolCall: { shellToolCall: { args: { command: "find ." } } },
          },
        },
      },
    ], clientRequest);

    const toolEvents = events.filter(
      (event) => event.type === "response.output_item.added" || event.type === "response.output_item.done",
    );
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents).not.toContainEqual(expect.objectContaining({ item: { name: "tool" } }));
    expect(toolEvents.at(-1)).toMatchObject({
      type: "response.output_item.done",
      item: { name: "probe_tool", arguments: JSON.stringify({ value: "probe" }) },
    });
    expect(events.at(-1)?.type).toBe("response.completed");
    // The suspended client tool parks this Run rather than cancelling it, so the transport stays
    // open for the result to attach to.
    expect(stream.closeCode).toBeUndefined();

    const replies = stream.writes.slice(1).map(decodeCursorClientFrame);
    expect(replies).toContainEqual(expect.objectContaining({
      execClientMessage: {
        id: 11,
        execId: "grep-11",
        grepResult: { error: { error: expect.stringContaining("No client bridge tool covers this action") } },
      },
    }));
    expect(replies).toContainEqual(expect.objectContaining({
      execClientMessage: expect.objectContaining({
        id: 12,
        execId: "shell-12",
        shellResult: { failure: expect.objectContaining({ exitCode: 1, aborted: true }) },
      }),
    }));
    expect(replies).toContainEqual({ execClientControlMessage: { streamClose: { id: 12 } } });
  });

  it("redirects high-frequency native exec through advertised client tools", () => {
    const tools = [
      {
        clientName: "Read",
        wireName: "cc_read_aaaaaaaa",
        inputSchemaValue: {
          type: "object",
          properties: { file_path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } },
          required: ["file_path"],
        },
      },
      {
        clientName: "Grep",
        wireName: "cc_grep_bbbbbbbb",
        inputSchemaValue: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            path: { type: "string" },
            glob: { type: "string" },
            output_mode: { type: "string" },
          },
          required: ["pattern"],
        },
      },
      {
        clientName: "Bash",
        wireName: "cc_bash_cccccccc",
        inputSchemaValue: {
          type: "object",
          properties: {
            command: { type: "string" },
            working_directory: { type: "string" },
            description: { type: "string" },
          },
          required: ["command"],
        },
      },
      {
        clientName: "WebFetch",
        wireName: "cc_web_fetch_dddddddd",
        inputSchemaValue: {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
        },
      },
      {
        clientName: "Glob",
        wireName: "cc_glob_eeeeeeee",
        inputSchemaValue: {
          type: "object",
          properties: { pattern: { type: "string" }, path: { type: "string" } },
          required: ["pattern"],
        },
      },
    ] as const;

    expect(cursorNativeExecRedirect(
      { id: 1, execId: "read-1", readArgs: { path: "README.md", toolCallId: "native-read-1" } },
      tools,
      CURSOR_TOOL_PROVIDER_IDENTIFIER,
    )).toMatchObject({
      execCase: "readArgs",
      nativeResultType: "readResult",
      call: {
        name: "Read",
        toolCallId: "native-read-1",
        arguments: JSON.stringify({ file_path: "README.md" }),
      },
    });

    const grep = cursorNativeExecRedirect(
      { id: 2, execId: "grep-2", grepArgs: { pattern: "Fleet", path: "packages", glob: "*.ts" } },
      tools,
      CURSOR_TOOL_PROVIDER_IDENTIFIER,
    );
    expect(grep).toMatchObject({
      execCase: "grepArgs",
      nativeResultType: "grepResult",
      call: {
        name: "Grep",
        arguments: JSON.stringify({
          pattern: "Fleet",
          path: "packages",
          glob: "*.ts",
          output_mode: "content",
        }),
      },
    });

    const shell = cursorNativeExecRedirect(
      {
        id: 3,
        execId: "shell-3",
        shellStreamArgs: { command: "pwd", workingDirectory: "/workspace", toolCallId: "native-shell-3" },
      },
      tools,
      CURSOR_TOOL_PROVIDER_IDENTIFIER,
    );
    expect(shell).toMatchObject({
      execCase: "shellStreamArgs",
      nativeResultType: "shellStreamResult",
      call: {
        name: "Bash",
        toolCallId: "native-shell-3",
      },
    });
    expect(JSON.parse(shell?.call.arguments ?? "{}")).toMatchObject({
      command: "pwd",
      working_directory: "/workspace",
    });

    expect(cursorNativeExecRedirect(
      { id: 4, readArgs: { path: "README.md", offset: 2, limit: 10 } },
      tools,
      CURSOR_TOOL_PROVIDER_IDENTIFIER,
    )).toBeNull();
    expect(cursorNativeExecRedirect(
      { id: 4, readArgs: { path: "README.md", offset: -1 } },
      tools,
      CURSOR_TOOL_PROVIDER_IDENTIFIER,
    )).toBeNull();
    expect(cursorNativeExecRedirect(
      { id: 4, readArgs: { path: "README.md", limit: -1 } },
      tools,
      CURSOR_TOOL_PROVIDER_IDENTIFIER,
    )).toBeNull();
    const grepShell = cursorNativeExecRedirect(
      { id: 5, execId: "grep-shell-5", grepArgs: { pattern: "Fleet", path: "packages", toolCallId: "native-grep-shell-5" } },
      tools.map((tool) => tool.clientName === "Grep"
        ? {
          ...tool,
          inputSchemaValue: {
            type: "object",
            properties: { pattern: { type: "string" } },
            required: ["pattern"],
          },
        }
        : tool),
      CURSOR_TOOL_PROVIDER_IDENTIFIER,
    );
    expect(grepShell).toMatchObject({
      nativeResultType: "grepShellResult",
      adapter: "grep-shell",
      call: { name: "Bash", toolCallId: "native-grep-shell-5" },
    });
    const grepShellCommand = JSON.parse(grepShell?.call.arguments ?? "{}").command as string;
    expect(grepShellCommand).toContain("process.argv.splice(1,1)");
    const encodedScript = grepShellCommand.split(" ").at(-2);
    expect(encodedScript).toBeDefined();
    const grepShellScript = Buffer.from(encodedScript ?? "", "base64url").toString("utf8");
    expect(grepShellScript).toContain('"--sort","path","--max-columns",String(maxContentBytes)');
    expect(grepShellScript).toContain("maxRecordBytes=64*1024");
    expect(grepShellScript).not.toContain("new Map()");
    expect(grepShellScript).not.toContain('"--json"');
    expect(cursorNativeExecRedirect(
      { id: 6, grepArgs: { pattern: "Fleet", path: "packages", outputMode: "files_with_matches" } },
      tools.filter((tool) => tool.clientName !== "Grep"),
      CURSOR_TOOL_PROVIDER_IDENTIFIER,
    )).toBeNull();
    expect(cursorNativeExecRedirect(
      { id: 7, grepArgs: { pattern: "Fleet", path: "packages", multiline: true } },
      tools.filter((tool) => tool.clientName !== "Grep"),
      CURSOR_TOOL_PROVIDER_IDENTIFIER,
    )).toBeNull();
    expect(cursorNativeExecRedirect(
      { id: 8, grepArgs: { pattern: "Fleet", path: "packages", offset: 2 } },
      tools.filter((tool) => tool.clientName !== "Grep"),
      CURSOR_TOOL_PROVIDER_IDENTIFIER,
    )).toBeNull();
    expect(cursorNativeExecRedirect(
      { id: 9, grepArgs: { pattern: "Fleet", path: "packages", sort: "path" } },
      tools.filter((tool) => tool.clientName !== "Grep"),
      CURSOR_TOOL_PROVIDER_IDENTIFIER,
    )).toBeNull();
    expect(cursorNativeExecRedirect(
      { id: 10, grepArgs: { pattern: "Fleet", path: "packages", context: -1 } },
      tools.filter((tool) => tool.clientName !== "Grep"),
      CURSOR_TOOL_PROVIDER_IDENTIFIER,
    )).toBeNull();
    expect(cursorNativeExecRedirect(
      { id: 6, fetchArgs: { url: "https://example.test" } },
      tools,
      CURSOR_TOOL_PROVIDER_IDENTIFIER,
    )).toBeNull();
    expect(cursorNativeExecRedirect(
      { id: 6, lsArgs: { path: "src" } },
      tools,
      CURSOR_TOOL_PROVIDER_IDENTIFIER,
    )).toBeNull();
    expect(cursorNativeExecRedirect(
      { id: 7, writeArgs: { path: "out.txt" } },
      tools,
      CURSOR_TOOL_PROVIDER_IDENTIFIER,
    )).toBeNull();
  });

  it("returns redirected Read output without claiming unverified whole-file metadata", () => {
    const replies = cursorNativeRedirectResultReplies(
      {
        messageId: 1,
        execId: "read-1",
        nativeResultType: "readResult",
        nativeArgs: { path: "README.md" },
      },
      "1→first line\n2→second line",
      false,
    );

    expect(() => fromJson(AgentClientMessageSchema, replies[0] as JsonValue)).not.toThrow();
    expect(replies[0]).toMatchObject({
      execClientMessage: {
        readResult: {
          error: {
            path: "README.md",
            error: expect.stringContaining("Caller output:\n1→first line\n2→second line"),
          },
        },
      },
    });
    expect(replies[0]).not.toEqual(expect.objectContaining({
      execClientMessage: expect.objectContaining({ readResult: expect.objectContaining({ success: expect.anything() }) }),
    }));
  });

  it("accepts only complete caller Bash receipts as native Grep success", () => {
    const receipt = `FLEET_CURSOR_GREP_V1:${Buffer.from(JSON.stringify({
      ok: true,
      outputMode: "content",
      files: [],
      counts: [],
      matches: [{
        file: "packages/a.ts",
        lineNumber: 7,
        content: "Fleet",
        contentTruncated: false,
        isContextLine: false,
      }],
      totalFiles: 1,
      totalLines: 1,
      totalMatchedLines: 1,
      totalMatches: 1,
      clientTruncated: false,
    }), "utf8").toString("base64url")}`;
    const success = cursorNativeRedirectResultReplies(
      {
        messageId: 2,
        execId: "grep-shell-2",
        nativeResultType: "grepShellResult",
        nativeArgs: { pattern: "Fleet", path: "packages", outputMode: "content" },
      },
      receipt,
      false,
    );
    expect(success).toContainEqual(expect.objectContaining({
      execClientMessage: expect.objectContaining({
        grepResult: {
          success: expect.objectContaining({
            outputMode: "content",
            workspaceResults: {
              packages: {
                content: expect.objectContaining({
                  totalLines: 1,
                  totalMatchedLines: 1,
                  clientTruncated: false,
                }),
              },
            },
          }),
        },
      }),
    }));

    const incomplete = cursorNativeRedirectResultReplies(
      {
        messageId: 3,
        execId: "grep-shell-3",
        nativeResultType: "grepShellResult",
        nativeArgs: { pattern: "Fleet", path: "packages", outputMode: "content" },
      },
      "FLEET_CURSOR_GREP_V1:truncated",
      false,
    );
    expect(incomplete).toContainEqual(expect.objectContaining({
      execClientMessage: expect.objectContaining({
        grepResult: { error: { error: expect.stringContaining("invalid Fleet Grep receipt") } },
      }),
    }));
    for (const reply of [...success, ...incomplete]) {
      expect(() => fromJson(AgentClientMessageSchema, reply as JsonValue)).not.toThrow();
    }
  });

  it("formats redirected native results as typed Cursor success frames", () => {
    const shellReplies = cursorNativeRedirectResultReplies(
      {
        messageId: 2,
        execId: "shell-2",
        nativeResultType: "shellStreamResult",
        nativeArgs: { command: "pwd", workingDirectory: "/workspace" },
      },
      "/workspace\n",
      false,
    );
    expect(shellReplies).toHaveLength(5);
    for (const reply of shellReplies) {
      expect(() => fromJson(AgentClientMessageSchema, reply as JsonValue)).not.toThrow();
    }

    const failedShellReplies = cursorNativeRedirectResultReplies(
      {
        messageId: 3,
        execId: "shell-3",
        nativeResultType: "shellStreamResult",
        nativeArgs: { command: "false", workingDirectory: "/workspace" },
      },
      "Exit code 7\ncommand failed",
      false,
    );
    expect(failedShellReplies).toHaveLength(5);
    expect(failedShellReplies).toContainEqual(expect.objectContaining({
      execClientMessage: expect.objectContaining({
        shellStream: { stderr: { data: "command failed" } },
      }),
    }));
    expect(failedShellReplies).toContainEqual(expect.objectContaining({
      execClientMessage: expect.objectContaining({
        shellStream: { exit: { code: 7, cwd: "/workspace", aborted: false } },
      }),
    }));
    expect(failedShellReplies).toContainEqual(expect.objectContaining({
      execClientMessage: expect.objectContaining({
        shellResult: {
          failure: expect.objectContaining({
            exitCode: 7,
            stdout: "",
            stderr: "command failed",
          }),
        },
      }),
    }));
    for (const reply of failedShellReplies) {
      expect(() => fromJson(AgentClientMessageSchema, reply as JsonValue)).not.toThrow();
    }
  });

  it("keeps hot-path tools eager while only redirecting search and shell", () => {
    expect(isCursorHotPathToolName("Read")).toBe(true);
    expect(isCursorNativeRedirectToolName("Read")).toBe(false);
    expect(isCursorNativeRedirectToolName("Grep")).toBe(true);
    expect(isCursorNativeRedirectToolName("Bash")).toBe(true);
    expect(isCursorNativeRedirectToolName("shell_command")).toBe(true);
    expect(isCursorNativeRedirectToolName("exec_command")).toBe(true);
    expect(isCursorHotPathToolName("mcp__fleet__ToolSearch")).toBe(true);
    expect(isCursorHotPathToolName("mcp__fleet__wiki_read")).toBe(false);
  });

  it("encodes a typed fail-closed reply for every supported native exec case", () => {
    const cases: readonly Record<string, unknown>[] = [
      { id: 1, readArgs: { path: "README.md" } },
      { id: 2, writeArgs: { path: "out.txt" } },
      { id: 3, deleteArgs: { path: "out.txt" } },
      { id: 4, lsArgs: { path: "." } },
      { id: 5, grepArgs: { pattern: "Fleet", path: "." } },
      { id: 6, shellArgs: { command: "pwd", workingDirectory: "/workspace" } },
      { id: 7, shellStreamArgs: { command: "pwd", workingDirectory: "/workspace" } },
      { id: 8, backgroundShellSpawnArgs: { command: "pwd", workingDirectory: "/workspace" } },
      { id: 9, writeShellStdinArgs: { shellId: 1, chars: "q" } },
      { id: 10, fetchArgs: { url: "https://example.test" } },
      { id: 11, diagnosticsArgs: { path: "src/index.ts" } },
      { id: 12, listMcpResourcesExecArgs: {} },
      { id: 13, readMcpResourceExecArgs: { uri: "fleet://resource" } },
      { id: 14, recordScreenArgs: {} },
      { id: 15, computerUseArgs: {} },
      { id: 16, mcpArgs: { providerIdentifier: "unsupported-provider" } },
    ];

    for (const exec of cases) {
      const replies = cursorNativeExecPolicyReplies(exec, ["Read", "Bash", "apply_patch"]);
      expect(replies, `missing reply for ${JSON.stringify(exec)}`).not.toBeNull();
      for (const reply of replies ?? []) {
        expect(() => fromJson(AgentClientMessageSchema, reply as JsonValue)).not.toThrow();
      }
    }
    expect(cursorNativeExecPolicyReplies(cases[6] ?? {}, ["Bash"])).toHaveLength(5);
  });

  it("points a rejected native exec at ToolSearch when its replacement is deferred", () => {
    // Measured: told only to "retry with the matching client bridge tool", a model whose catalog
    // did not advertise one answered "none appears available among the current tools" and stopped.
    const reply = JSON.stringify(cursorNativeExecPolicyReplies(
      { id: 1, shellStreamArgs: { command: "rg Fleet" } },
      [{ clientName: "mcp__fleet__ToolSearch", wireName: "cc_tool_search_3161b03b" }],
    ));

    expect(reply).toContain("cc_tool_search_3161b03b");
    expect(reply).toContain("deferred, not missing");
  });

  it("forbids retrying the native tool when nothing at all can replace it", () => {
    // The other measured outcome: the model went back to the Cursor-native tool and was rejected
    // again, which is the loop this branch exists to stop.
    const reply = JSON.stringify(cursorNativeExecPolicyReplies(
      { id: 1, shellStreamArgs: { command: "rg Fleet" } },
      [{ clientName: "mcp__fleet__wiki_read", wireName: "cc_wiki_read_9f1" }],
    ));

    expect(reply).toContain("do not call it");
    expect(reply).not.toContain("Matching tools advertised");
  });

  it("tells an empty-catalog turn to answer in plain text instead of retrying natives", () => {
    // Measured: Claude Code title-generation requests arrive with tools:[] and still carry the
    // user prompt, so Cursor natives fire and the old "continue with the advertised client tools"
    // message had nothing to point at.
    const reply = JSON.stringify(cursorNativeExecPolicyReplies(
      { id: 1, grepArgs: { pattern: "Fleet", path: "." } },
      [],
    ));

    expect(reply).toContain("advertises no client tools");
    expect(reply).toContain("plain text only");
    expect(reply).not.toContain("Continue with the advertised client tools");
  });

  it("orders native-exec retry tools by operation fit instead of catalog order", () => {
    const catalog = ["Bash", "Write", "Edit", "Read"];
    const readReply = JSON.stringify(cursorNativeExecPolicyReplies(
      { id: 1, readArgs: { path: "README.md" } },
      catalog,
    ));
    const writeReply = JSON.stringify(cursorNativeExecPolicyReplies(
      { id: 2, writeArgs: { path: "README.md" } },
      catalog,
    ));
    const grepReply = JSON.stringify(cursorNativeExecPolicyReplies(
      { id: 3, grepArgs: { pattern: "Fleet", path: "." } },
      catalog,
    ));

    expect(readReply.indexOf("`Read`")).toBeLessThan(readReply.indexOf("`Bash`"));
    expect(writeReply.indexOf("`Edit`")).toBeLessThan(writeReply.indexOf("`Write`"));
    expect(writeReply.indexOf("`Write`")).toBeLessThan(writeReply.indexOf("`Bash`"));
    expect(grepReply.indexOf("`Bash`")).toBeLessThan(grepReply.indexOf("`Read`"));
  });

  it("acknowledges Cursor execute hooks that are newer than the vendored descriptor", async () => {
    const diagnostics: CursorDiagnosticEvent[] = [];
    const hookCase = 5;
    const { events, stream } = await runSyntheticCursorTurn([
      rawCursorServerFrame(27, executeHookArgs(hookCase), 27, "hook-27"),
      { interactionUpdate: { textDelta: { text: "continued after hook" } } },
      { interactionUpdate: { turnEnded: {} } },
    ], request("claude-session-execute-hook"), {
      diagnostics: (event) => diagnostics.push(event),
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: "response.output_text.delta",
      delta: "continued after hook",
    }));
    expect(events.at(-1)?.type).toBe("response.completed");
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: "server.frame",
      frame: "execServerMessage.executeHookArgs",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: "client.reply",
      reply: "exec.policy.executeHookArgs",
      count: 1,
    }));

    const hookReply = stream.writes
      .slice(1)
      .map(decodeCursorClientMessage)
      .find((message) => message.execUnknownFields.some((field) => field.no === 27));
    expect(hookReply?.execId).toBe("hook-27");
    const hookResult = hookReply?.execUnknownFields.find((field) => field.no === 27);
    expect(hookResult).toBeDefined();
    expect(executeHookResponseCase(hookResult?.data ?? new Uint8Array())).toBe(hookCase);
  });

  it("rejects future unknown native exec variants instead of leaving the turn open", async () => {
    const diagnostics: CursorDiagnosticEvent[] = [];
    const { events, stream } = await runSyntheticCursorTurn([
      rawCursorServerFrame(31, new Uint8Array(), 31, "future-31"),
      { interactionUpdate: { textDelta: { text: "recovered from unsupported exec" } } },
      { interactionUpdate: { turnEnded: {} } },
    ], request("claude-session-unknown-exec"), {
      diagnostics: (event) => diagnostics.push(event),
    });

    const replies = stream.writes.slice(1).map(decodeCursorClientFrame);
    expect(replies).toContainEqual({
      execClientControlMessage: {
        throw: {
          id: 31,
          error: expect.stringContaining("unknownField31"),
        },
      },
    });
    expect(replies).toContainEqual({
      execClientControlMessage: { streamClose: { id: 31 } },
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: "server.frame",
      frame: "execServerMessage.unknownField31",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: "client.reply",
      reply: "exec.control.unknownField31",
      count: 2,
    }));
    expect(events.at(-1)?.type).toBe("response.completed");
  });

  it("bounds heartbeat-only Cursor stalls with a semantic timeout", async () => {
    const diagnostics: CursorDiagnosticEvent[] = [];
    await expect(runSyntheticCursorTurn([
      { interactionUpdate: { heartbeat: {} } },
    ], request("claude-session-heartbeat-stall"), {
      diagnostics: (event) => diagnostics.push(event),
      idleTimeoutMs: 20,
    })).rejects.toThrow("cursor stream semantic stall timeout");

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: "server.frame",
      frame: "interactionUpdate.heartbeat",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: "transport.semantic_timeout",
      outcome: "semantic_stall_timeout",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: "turn.finish",
      outcome: "semantic_stall_timeout",
      error: "semantic_stall_timeout",
    }));
  });

  it("keeps the Cursor agent stream live with client heartbeats", async () => {
    const { events, stream } = await runSyntheticCursorTurn([
      { interactionUpdate: { textDelta: { text: "heartbeat resumed" } } },
      { interactionUpdate: { turnEnded: {} } },
    ], request("claude-session-heartbeat"), {
      releaseOnHeartbeat: true,
      clientHeartbeatMs: 1,
    });

    const writes = stream.writes.map(decodeCursorClientFrame);
    expect(writes).toContainEqual({ clientHeartbeat: {} });
    expect(events).toContainEqual(expect.objectContaining({
      type: "response.output_text.delta",
      delta: "heartbeat resumed",
    }));
    expect(events.at(-1)?.type).toBe("response.completed");
  });

  it("preserves Cursor thinking deltas as canonical reasoning events", async () => {
    const { events } = await runSyntheticCursorTurn([
      { interactionUpdate: { thinkingDelta: { text: "Inspecting the repository." } } },
      { interactionUpdate: { textDelta: { text: "Done" } } },
      { interactionUpdate: { turnEnded: {} } },
    ], request("claude-session-thinking"));

    expect(events).toContainEqual({
      type: "response.reasoning_summary_text.delta",
      item_id: expect.stringMatching(/_reasoning$/),
      output_index: 0,
      delta: "Inspecting the repository.",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "response.output_text.delta",
      delta: "Done",
    }));
  });

  it("acknowledges a Cursor planning query and lets the turn continue", async () => {
    const { events, stream } = await runSyntheticCursorTurn([
      {
        interactionQuery: {
          id: 23,
          createPlanRequestQuery: {
            args: {
              name: "Inspect canary",
              overview: "Compare the unreleased changes.",
              plan: "1. Read history\n2. Summarize changes",
            },
          },
        },
      },
      { interactionUpdate: { textDelta: { text: "Continuing after the plan.\n" } } },
      { interactionUpdate: { turnEnded: {} } },
    ], request("claude-session-interaction-query"));

    const replies = stream.writes.slice(1).map(decodeCursorClientFrame);
    expect(replies).toContainEqual({
      interactionResponse: {
        id: 23,
        createPlanRequestResponse: { result: { success: {} } },
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "response.output_text.delta",
      delta: expect.stringContaining("Plan: Inspect canary"),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "response.output_text.delta",
      delta: "Continuing after the plan.\n",
    }));
    expect(events.at(-1)?.type).toBe("response.completed");
  });

  it("approves Cursor-native web search and lets the turn return text", async () => {
    const { events, stream } = await runSyntheticCursorTurn([
      {
        interactionQuery: {
          id: 29,
          webSearchRequestQuery: {},
        },
      },
      { interactionUpdate: { textDelta: { text: "Search result with https://example.com/source\n" } } },
      { interactionUpdate: { turnEnded: {} } },
    ], request("claude-session-native-web-search"));

    const replies = stream.writes.slice(1).map(decodeCursorClientFrame);
    expect(replies).toContainEqual({
      interactionResponse: {
        id: 29,
        webSearchRequestResponse: { approved: {} },
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "response.output_text.delta",
      delta: "Search result with https://example.com/source\n",
    }));
    expect(events.at(-1)?.type).toBe("response.completed");
  });

  it("reports payload-free transport diagnostics without affecting the turn", async () => {
    const diagnostics: CursorDiagnosticEvent[] = [];
    const secretPlan = "SECRET_PLAN_PAYLOAD";
    const secretOutput = "SECRET_MODEL_OUTPUT";
    const secretCallId = "SECRET_CALL_ID";
    const { events } = await runSyntheticCursorTurn([
      {
        interactionQuery: {
          id: 41,
          createPlanRequestQuery: {
            args: { name: secretPlan, overview: secretPlan, plan: secretPlan },
          },
        },
      },
      {
        interactionUpdate: {
          toolCallStarted: {
            callId: secretCallId,
            toolCall: {
              mcpToolCall: {
                args: {
                  name: "probe_tool",
                  toolCallId: secretCallId,
                  providerIdentifier: CURSOR_TOOL_PROVIDER_IDENTIFIER,
                  toolName: "probe_tool",
                },
              },
            },
          },
        },
      },
      { interactionUpdate: { textDelta: { text: secretOutput } } },
      { interactionUpdate: { turnEnded: {} } },
    ], {
      ...request("SECRET_SESSION_ID"),
      model: "grok-4.5",
      reasoning: { summary: "auto", effort: "xhigh" },
    }, {
      diagnostics: (event) => diagnostics.push(event),
    });

    expect(events.at(-1)?.type).toBe("response.completed");
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: "turn.start",
      model: "grok-4.5",
      // Grok's ladder tops out at high, so xhigh clamps onto that wire suffix.
      wireModel: "cursor-grok-4.5-high",
      requestedEffort: "xhigh",
      turn: "prompt",
      toolCount: 1,
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: "server.frame",
      frame: "interactionQuery.createPlanRequestQuery",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: "client.reply",
      reply: "interaction.createPlan.approved",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: "turn.finish",
      outcome: "turn_ended",
      frameCount: 4,
      lastFrame: "interactionUpdate.turnEnded",
    }));

    const persistedShape = JSON.stringify(diagnostics);
    for (const secret of [
      secretPlan,
      secretOutput,
      secretCallId,
      "probe_tool",
      "SECRET_SESSION_ID",
      "cursor-test-token",
    ]) {
      expect(persistedShape).not.toContain(secret);
    }
  });

  it("isolates diagnostic callback failures from Cursor turns", async () => {
    const { events } = await runSyntheticCursorTurn([
      { interactionUpdate: { textDelta: { text: "still completes" } } },
      { interactionUpdate: { turnEnded: {} } },
    ], request("claude-session-diagnostic-failure"), {
      diagnostics: () => {
        throw new Error("diagnostic sink failed");
      },
    });

    expect(events.at(-1)?.type).toBe("response.completed");
  });

  it("reports Cursor's absolute checkpoint as cumulative context usage", async () => {
    const diagnostics: CursorDiagnosticEvent[] = [];
    const { events } = await runSyntheticCursorTurn([
      { interactionUpdate: { textDelta: { text: "checkpointed output" } } },
      { interactionUpdate: { tokenDelta: { tokens: 7 } } },
      { conversationCheckpointUpdate: { tokenDetails: { usedTokens: 4_200, maxTokens: 256_000 } } },
      { interactionUpdate: { turnEnded: {} } },
    ], request("claude-session-checkpoint"), {
      diagnostics: (event) => diagnostics.push(event),
    });

    const completed = events.at(-1);
    expect(completed?.type).toBe("response.completed");
    if (completed?.type !== "response.completed") return;
    expect(completed.response.usage).toEqual({
      input_tokens: 4_193,
      output_tokens: 7,
      context_window: 256_000,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: "server.frame",
      frame: "conversationCheckpointUpdate",
      contextTokens: 4_200,
      contextWindow: 256_000,
    }));
  });

  it("keeps the last Cursor checkpoint across turns until a new checkpoint rebases it", async () => {
    const sessionRequest = request("claude-session-context-continuity");
    const first = await runSyntheticCursorTurn([
      { interactionUpdate: { textDelta: { text: "ok" } } },
      { interactionUpdate: { tokenDelta: { tokens: 10 } } },
      { conversationCheckpointUpdate: { tokenDetails: { usedTokens: 100_000, maxTokens: 256_000 } } },
      { interactionUpdate: { turnEnded: {} } },
    ], sessionRequest);
    const withoutCheckpoint = await runSyntheticCursorTurn([
      { interactionUpdate: { textDelta: { text: "ok" } } },
      { interactionUpdate: { tokenDelta: { tokens: 10 } } },
      { interactionUpdate: { turnEnded: {} } },
    ], sessionRequest);
    const afterAuthoritativeRebase = await runSyntheticCursorTurn([
      { interactionUpdate: { textDelta: { text: "ok" } } },
      { interactionUpdate: { tokenDelta: { tokens: 10 } } },
      { conversationCheckpointUpdate: { tokenDetails: { usedTokens: 40_000, maxTokens: 256_000 } } },
      { interactionUpdate: { turnEnded: {} } },
    ], sessionRequest);

    expect(completedCursorUsage(first.events)).toEqual({
      input_tokens: 99_990,
      output_tokens: 10,
      context_window: 256_000,
    });
    expect(completedCursorUsage(withoutCheckpoint.events)).toEqual({
      input_tokens: 100_000,
      output_tokens: 10,
      context_window: 256_000,
    });
    expect(completedCursorUsage(afterAuthoritativeRebase.events)).toEqual({
      input_tokens: 39_990,
      output_tokens: 10,
      context_window: 256_000,
    });
  });

});

async function runSyntheticToolTurn(userId: string): Promise<{
  readonly events: readonly CanonicalResponseEvent[];
  readonly stream: FakeCursorStream;
  readonly conversationId: string;
  readonly sessionId: string;
  readonly requestContextReply: unknown;
  readonly contentType: unknown;
}> {
  const callId = "call-probe-1";
  const frames = [
    {
      execServerMessage: {
        id: 7,
        execId: "exec-context-7",
        requestContextArgs: {},
      },
    },
    {
      interactionUpdate: {
        toolCallStarted: {
          callId,
          toolCall: {
            mcpToolCall: {
              args: {
                name: "probe_tool",
                toolCallId: callId,
                providerIdentifier: CURSOR_TOOL_PROVIDER_IDENTIFIER,
                toolName: "probe_tool",
              },
            },
          },
        },
      },
    },
    {
      execServerMessage: {
        mcpArgs: {
          name: "probe_tool",
          toolCallId: callId,
          providerIdentifier: CURSOR_TOOL_PROVIDER_IDENTIFIER,
          toolName: "probe_tool",
          args: {
            value: Buffer.from("cursor-auto", "utf8").toString("base64"),
            encoded: Buffer.from("cursor-bytes", "utf8").toString("base64"),
            structured: cursorValue({ ok: true }),
          },
        },
      },
    },
    // Some Cursor builds echo completion after the exec suspension frame. That
    // late activity must re-arm, not permanently cancel, the bounded finalizer.
    {
      interactionUpdate: {
        toolCallCompleted: {
          callId,
          toolCall: {
            mcpToolCall: {
              args: {
                name: "probe_tool",
                toolCallId: callId,
                providerIdentifier: CURSOR_TOOL_PROVIDER_IDENTIFIER,
                toolName: "probe_tool",
              },
            },
          },
        },
      },
    },
  ];
  const { events, stream, requestHeaders } = await runSyntheticCursorTurn(frames, request(userId));
  const initial = decodeCursorClientFrame(stream.writes[0] ?? Buffer.alloc(0)) as {
    readonly runRequest?: { readonly conversationId?: unknown };
  };
  const conversationId = initial.runRequest?.conversationId;
  if (typeof conversationId !== "string") throw new Error("Synthetic Cursor request had no conversation id");
  const sessionId = requestHeaders?.["x-session-id"];
  if (typeof sessionId !== "string") throw new Error("Synthetic Cursor request had no x-session-id");
  const requestContextReply = decodeCursorClientFrame(stream.writes[1] ?? Buffer.alloc(0));
  return {
    events,
    stream,
    conversationId,
    sessionId,
    requestContextReply,
    contentType: requestHeaders?.["content-type"],
  };
}

async function runSyntheticCursorTurn(
  frames: readonly SyntheticCursorFrame[],
  canonicalRequest: CanonicalResponseRequest,
  options: {
    readonly releaseOnHeartbeat?: boolean;
    readonly clientHeartbeatMs?: number;
    readonly idleTimeoutMs?: number;
    readonly diagnostics?: (event: CursorDiagnosticEvent) => void;
  } = {},
): Promise<{
  readonly events: readonly CanonicalResponseEvent[];
  readonly stream: FakeCursorStream;
  readonly requestHeaders: http2.OutgoingHttpHeaders | undefined;
}> {
  const stream = new FakeCursorStream(frames, options.releaseOnHeartbeat ?? false);
  let requestHeaders: http2.OutgoingHttpHeaders | undefined;
  const session = Object.assign(new EventEmitter(), {
    request: (headers: http2.OutgoingHttpHeaders) => {
      requestHeaders = headers;
      return stream;
    },
    close: () => undefined,
  });
  const adapter = new CursorAdapter({
    connect: (() => session as unknown as http2.ClientHttp2Session) as typeof http2.connect,
    idleTimeoutMs: options.idleTimeoutMs ?? 1_000,
    toolFinalizeGraceMs: 0,
    clientHeartbeatMs: options.clientHeartbeatMs ?? 5_000,
    diagnostics: options.diagnostics,
  });
  const response = await adapter.stream(canonicalRequest, {
    apiKey: "cursor-test-token",
    signal: AbortSignal.timeout(1_000),
  });
  if (!response.ok) throw new Error("Synthetic Cursor response unexpectedly failed");

  const events: CanonicalResponseEvent[] = [];
  for await (const event of response.events) events.push(event);
  return { events, stream, requestHeaders };
}

function completedCursorUsage(events: readonly CanonicalResponseEvent[]) {
  const completed = events.at(-1);
  if (completed?.type !== "response.completed" || completed.response.usage == null) {
    throw new Error("Synthetic Cursor turn did not complete with usage");
  }
  return completed.response.usage;
}

function request(userId: string): CanonicalResponseRequest {
  return {
    model: "default",
    instructions: "Call probe_tool.",
    input: [{ type: "message", role: "user", content: "Call the tool now." }],
    tools: [{
      type: "function",
      name: "probe_tool",
      description: "Harmless diagnostic tool",
      parameters: {
        type: "object",
        properties: {
          value: { type: "string" },
          encoded: { type: "string" },
          structured: { type: "object" },
        },
        required: ["value"],
        additionalProperties: false,
      },
    }],
    metadata: { user_id: userId },
    stream: true,
  };
}

function readRequest(): CanonicalResponseRequest {
  return {
    model: "composer-2.5-fast",
    instructions: "Read a repository file with the Read client tool.",
    input: [{ type: "message", role: "user", content: "Read a file and explain it." }],
    tools: [{
      type: "function",
      name: "Read",
      description: "Read a file from the repository",
      parameters: {
        type: "object",
        properties: { file_path: { type: "string" } },
        required: ["file_path"],
        additionalProperties: false,
      },
    }],
    metadata: { user_id: "claude-session-native-retry" },
    stream: true,
  };
}

function taskUpdateRequest(): CanonicalResponseRequest {
  return {
    model: "grok-4.5-fast",
    instructions: "Update task 1.",
    input: [{ type: "message", role: "user", content: "Mark task 1 in progress." }],
    tools: [{
      type: "function",
      name: "TaskUpdate",
      description: "Update a task",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          attempt: { type: "number" },
        },
        required: ["taskId", "status"],
        additionalProperties: false,
      },
    }],
    metadata: { user_id: "claude-session-task-update" },
    stream: true,
  };
}

function firstCursorWireToolName(request: CanonicalResponseRequest): string {
  const plan = buildCursorRunPlan(request, "conversation-wire-name");
  const runRequest = (plan.payload as {
    readonly runRequest?: {
      readonly mcpTools?: { readonly mcpTools?: ReadonlyArray<{ readonly toolName?: string }> };
    };
  }).runRequest;
  const wireName = runRequest?.mcpTools?.mcpTools?.find((tool) => tool.toolName)?.toolName;
  if (!wireName) throw new Error("Missing Cursor wire tool");
  return wireName;
}

function cursorValue(value: JsonValue): string {
  return Buffer.from(toBinary(ValueSchema, fromJson(ValueSchema, value))).toString("base64");
}

function encodeCursorServerFrame(value: unknown): Buffer {
  const message = fromJson(AgentServerMessageSchema, value as JsonValue);
  return encodeConnectFrame(toBinary(AgentServerMessageSchema, message));
}

interface RawCursorServerFrame {
  readonly rawPayload: Uint8Array;
}

type SyntheticCursorFrame = unknown | RawCursorServerFrame;

function encodeSyntheticCursorServerFrame(value: SyntheticCursorFrame): Buffer {
  return isRawCursorServerFrame(value)
    ? encodeConnectFrame(value.rawPayload)
    : encodeCursorServerFrame(value);
}

function isRawCursorServerFrame(value: SyntheticCursorFrame): value is RawCursorServerFrame {
  return typeof value === "object"
    && value !== null
    && "rawPayload" in value
    && value.rawPayload instanceof Uint8Array;
}

function rawCursorServerFrame(
  fieldNumber: number,
  value: Uint8Array,
  id: number,
  execId: string,
): RawCursorServerFrame {
  const exec = encodeWireMessage((writer) => {
    writer.tag(1, WireType.Varint).uint32(id);
    writer.tag(15, WireType.LengthDelimited).string(execId);
    writer.tag(fieldNumber, WireType.LengthDelimited).bytes(value);
  });
  return {
    rawPayload: encodeWireMessage((writer) => {
      writer.tag(2, WireType.LengthDelimited).bytes(exec);
    }),
  };
}

function executeHookArgs(hookCase: number): Uint8Array {
  const request = encodeWireMessage((writer) => {
    writer.tag(hookCase, WireType.LengthDelimited).bytes(new Uint8Array());
  });
  return encodeWireMessage((writer) => {
    writer.tag(1, WireType.LengthDelimited).bytes(request);
  });
}

function executeHookResponseCase(unknownFieldData: Uint8Array): number | undefined {
  try {
    const result = new BinaryReader(unknownFieldData).bytes();
    const resultReader = new BinaryReader(result);
    const [responseField, responseWireType] = resultReader.tag();
    if (responseField !== 1 || responseWireType !== WireType.LengthDelimited) return undefined;
    const response = resultReader.bytes();
    const responseReader = new BinaryReader(response);
    const [hookCase, hookWireType] = responseReader.tag();
    return hookWireType === WireType.LengthDelimited ? hookCase : undefined;
  } catch {
    return undefined;
  }
}

function encodeWireMessage(write: (writer: BinaryWriter) => void): Uint8Array {
  const writer = new BinaryWriter();
  write(writer);
  return writer.finish();
}

function decodeCursorClientMessage(value: Buffer): {
  readonly execId: string;
  readonly execUnknownFields: readonly { readonly no: number; readonly data: Uint8Array }[];
} {
  const frame = decodeConnectFrames(value).frames[0];
  if (!frame) throw new Error("Missing Cursor client frame");
  const message = fromBinary(AgentClientMessageSchema, frame.payload) as unknown as {
    readonly message?: {
      readonly case?: string;
      readonly value?: {
        readonly execId?: string;
        readonly $unknown?: readonly { readonly no: number; readonly data: Uint8Array }[];
      };
    };
  };
  if (message.message?.case !== "execClientMessage") {
    return { execId: "", execUnknownFields: [] };
  }
  return {
    execId: message.message.value?.execId ?? "",
    execUnknownFields: message.message.value?.$unknown ?? [],
  };
}

function decodeCursorClientFrame(value: Buffer): unknown {
  const frame = decodeConnectFrames(value).frames[0];
  if (!frame) throw new Error("Missing Cursor client frame");
  return toJson(
    AgentClientMessageSchema,
    fromBinary(AgentClientMessageSchema, frame.payload),
  );
}

class FakeCursorStream extends EventEmitter {
  readonly writes: Buffer[] = [];
  closeCode: number | undefined;
  private sent = false;
  private responded = false;

  constructor(
    private readonly frames: readonly SyntheticCursorFrame[],
    private readonly releaseOnHeartbeat: boolean,
  ) {
    super();
  }

  setTimeout(): this {
    return this;
  }

  write(chunk: Uint8Array): boolean {
    this.writes.push(Buffer.from(chunk));
    // Cursor answers with response headers before any frame; the adapter gates decoding on them.
    if (!this.responded) {
      this.responded = true;
      queueMicrotask(() => this.emit("response", {
        ":status": 200,
        "content-type": "application/connect+proto",
      }));
    }
    const message = this.releaseOnHeartbeat
      ? decodeCursorClientFrame(Buffer.from(chunk)) as Record<string, unknown>
      : undefined;
    if (!this.sent && (!this.releaseOnHeartbeat || message?.clientHeartbeat !== undefined)) {
      this.sent = true;
      // A macrotask, so the adapter's response-head continuation has installed its data
      // listener first — an EventEmitter drops what it emits with no listener attached.
      setImmediate(() => this.emit(
        "data",
        Buffer.concat(this.frames.map(encodeSyntheticCursorServerFrame)),
      ));
    }
    return true;
  }

  close(code?: number): void {
    this.closeCode = code;
    queueMicrotask(() => this.emit("close"));
  }

  destroy(error?: Error): void {
    if (error) queueMicrotask(() => this.emit("error", error));
    queueMicrotask(() => this.emit("close"));
  }
}
