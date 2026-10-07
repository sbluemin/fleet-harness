import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http2 from "node:http2";
import { tmpdir } from "node:os";
import path from "node:path";
import { fromBinary, fromJson, toBinary, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CURSOR_TOOL_PROVIDER_IDENTIFIER,
  ContextWindowExceededError,
  CursorAdapter,
  buildCursorRunPlan,
  decodeConnectFrames,
  encodeConnectFrame,
  resetCursorWireModelMemory,
  setWireLogTarget,
} from "../../../../src/index.js";
import type {
  CanonicalFunctionTool,
  CanonicalResponseEvent,
  CanonicalResponseRequest,
  CursorAdapterOptions,
  CursorDiagnosticEvent,
  ReasoningEffort,
} from "../../../../src/index.js";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
} from "../../../../src/upstream/cursor/native/generated/cursor-agent-protobuf.js";
import {
  cursorNativeExecRedirect,
  cursorNativeRedirectResultReplies,
} from "../../../../src/upstream/cursor/native/exec-redirect.js";

const temporaryWireLogDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  resetCursorWireModelMemory();
  setWireLogTarget(undefined);
  for (const directory of temporaryWireLogDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function wireLogFile(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "fleet-cursor-wire-log-"));
  temporaryWireLogDirectories.push(directory);
  const filePath = path.join(directory, "wire-log.jsonl");
  setWireLogTarget({ path: filePath });
  return filePath;
}

function cursorWireEntries(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function cursorWirePlanCount(filePath: string): number {
  return cursorWireEntries(filePath).filter((entry) => entry.event === "cursor.wire.plan").length;
}

describe("Cursor live client-tool Run bridge", () => {

  it("redirects native Grep through a readable shell search, native Glob to the caller Glob, and fails closed on a broken receipt", async () => {
    const nativeCall = cursorCall("native-grep-shell-failure", 29);
    const stream = new BridgeCursorStream(
      [{
        execServerMessage: {
          id: nativeCall.messageId,
          execId: nativeCall.execId,
          grepArgs: {
            pattern: "Fleet",
            path: "packages",
            toolCallId: nativeCall.callId,
          },
        },
      }],
      cursorCompletionFrames("grep failure handled"),
      1,
    );
    const harness = cursorHarness([stream]);
    const initial: CanonicalResponseRequest = {
      ...cursorRequest("session-native-grep-shell-failure", "composer-2.5"),
      tools: [{
        type: "function",
        name: "Bash",
        description: "Run a shell command under caller permissions",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
          additionalProperties: false,
        },
      }],
    };

    try {
      const initialEvents = await collectCursorResponse(harness.adapter, initial);
      const callId = addedFunctionCallIds(initialEvents)[0];
      if (!callId) throw new Error("Missing redirected Bash call");
      const command = initialEvents.flatMap((event) => (
        event.type === "response.output_item.done" && event.item.type === "function_call"
          ? [JSON.parse(event.item.arguments).command as string]
          : []
      ))[0];
      if (!command) throw new Error("Missing redirected shell command");
      expect(command.startsWith("rg -n -H --heading --color=never ")).toBe(true);
      expect(command.slice(0, 160)).toContain("Fleet");
      expect(command).toContain("--regexp 'Fleet'");
      expect(command).toContain("-- 'packages'");
      expect(command).toContain("head -c 12288");
      expect(command).not.toContain("base64url");
      expect(command).not.toContain("node -e");
      expect(command).not.toContain("awk");

      const events = await collectCursorResponse(
        harness.adapter,
        cursorContinuation(
          initial,
          [{ ...nativeCall, name: "Bash" }],
          [{ call_id: callId, output: "truncated caller output" }],
        ),
      );

      expect(canonicalText(events)).toBe("grep failure handled");
      expect(harness.openedStreams).toBe(1);
      expect(cursorClientWrites(stream)).toContainEqual(expect.objectContaining({
        execClientMessage: expect.objectContaining({
          grepResult: {
            error: { error: expect.stringContaining("complete Fleet Grep receipt") },
          },
        }),
      }));

      const correlation = {
        messageId: nativeCall.messageId,
        execId: nativeCall.execId,
        nativeResultType: "grepShellResult" as const,
        nativeArgs: { pattern: "Fleet", path: "packages", outputMode: "content" },
      };
      const successBody = [
        "sub/12:odd.ts",
        "2:parseGrepShellReceipt here",
        "3-nearby",
        "",
      ].join("\n");
      // The caller may trim the newline after the trailer.
      const success = cursorNativeRedirectResultReplies(correlation, [
        successBody,
        `fleet-grep status=ok rc=0 bytes=${Buffer.byteLength(successBody)}`,
      ].join("\n"), false);
      expect(success).toContainEqual(expect.objectContaining({
        execClientMessage: expect.objectContaining({
          grepResult: {
            success: {
              pattern: "Fleet",
              path: "packages",
              outputMode: "content",
              workspaceResults: {
                packages: {
                  content: {
                    matches: [{
                      file: "sub/12:odd.ts",
                      matches: [
                        {
                          lineNumber: 2,
                          content: "parseGrepShellReceipt here",
                          contentTruncated: false,
                          isContextLine: false,
                        },
                        {
                          lineNumber: 3,
                          content: "nearby",
                          contentTruncated: false,
                          isContextLine: true,
                        },
                      ],
                    }],
                    totalLines: 2,
                    totalMatchedLines: 1,
                    clientTruncated: false,
                    ripgrepTruncated: false,
                  },
                },
              },
            },
          },
        }),
      }));
      const kept = "sub/plain.ts\n4:function cursor\n";
      const limit = 12 * 1024;
      // The byte cap cut a multibyte character, which the caller decoded to U+FFFD (3 bytes).
      const transmitted = kept + "x".repeat(limit - Buffer.byteLength(kept) - 2) + "\uFFFD";
      const truncated = cursorNativeRedirectResultReplies(correlation, [
        transmitted,
        `fleet-grep status=ok rc=0 bytes=${limit + 50}`,
        "",
      ].join("\n"), false);
      expect(truncated).toContainEqual(expect.objectContaining({
        execClientMessage: expect.objectContaining({
          grepResult: {
            success: expect.objectContaining({
              workspaceResults: {
                packages: {
                  content: expect.objectContaining({
                    totalLines: 1,
                    totalMatchedLines: 1,
                    clientTruncated: true,
                  }),
                },
              },
            }),
          },
        }),
      }));
      const ambiguousBody = "sub/12:odd.ts\nnot a numbered line\n";
      const shortBody = "sub/plain.ts\n4:function cursor\n";
      for (const broken of [
        [
          ambiguousBody,
          `fleet-grep status=ok rc=0 bytes=${Buffer.byteLength(ambiguousBody)}`,
          "",
        ].join("\n"),
        [
          shortBody,
          "fleet-grep status=ok rc=0 bytes=0",
          "",
        ].join("\n"),
      ]) {
        expect(cursorNativeRedirectResultReplies(correlation, broken, false)).toContainEqual(
          expect.objectContaining({
            execClientMessage: expect.objectContaining({
              grepResult: { error: { error: expect.stringContaining("invalid Fleet Grep receipt") } },
            }),
          }),
        );
      }
      expect(cursorNativeExecRedirect(
        { id: 1, execId: "newline", grepArgs: { pattern: "a\nb", path: "packages" } },
        [{
          clientName: "Bash",
          wireName: "bash",
          inputSchemaValue: { type: "object", properties: { command: { type: "string" } } },
        }],
        "cursor",
      )).toBeNull();

      // Cursor's shell always names a working directory; Claude Code's Bash has no field for it.
      const bashTool = {
        clientName: "Bash",
        wireName: "bash",
        inputSchemaValue: {
          type: "object",
          properties: { command: { type: "string" }, timeout: { type: "number" } },
        },
      };
      const shellDirectory = mkdtempSync(path.join(tmpdir(), "fleet-cursor-shell-cwd-"));
      temporaryWireLogDirectories.push(shellDirectory);
      const nativeShell = (workingDirectory: string) => cursorNativeExecRedirect(
        {
          id: 4,
          execId: "native-shell",
          shellStreamArgs: {
            command: "basename \"$PWD\"\nfalse || echo fallback # trailing comment",
            workingDirectory,
            timeout: 30000,
          },
        },
        [bashTool],
        "cursor",
      );
      const runRedirected = (workingDirectory: string) => {
        const shellRedirect = nativeShell(workingDirectory);
        expect(shellRedirect).toMatchObject({ adapter: "shell-direct", nativeResultType: "shellStreamResult" });
        const args = JSON.parse(shellRedirect?.call.arguments ?? "{}") as { command: string; timeout: number };
        expect(args.timeout).toBe(30000);
        return spawnSync("/bin/sh", ["-c", args.command], { cwd: tmpdir(), encoding: "utf8" });
      };
      const inDirectory = runRedirected(shellDirectory);
      expect(inDirectory.stdout).toBe(`${path.basename(shellDirectory)}\nfallback\n`);
      expect(inDirectory.status).toBe(0);
      // A directory that cannot be entered runs no part of the command anywhere else.
      const missingDirectory = runRedirected(path.join(shellDirectory, "missing"));
      expect(missingDirectory.stdout).toBe("");
      expect(missingDirectory.status).not.toBe(0);

      // Cursor's own file-name search arrives as a pattern-less grep that carries only a glob.
      const globSchema = {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" } },
      };
      const globRedirect = cursorNativeExecRedirect(
        {
          id: 2,
          execId: "native-glob",
          grepArgs: {
            path: "/repo",
            glob: "**/runtime/*/CLAUDE.md",
            outputMode: "files_with_matches",
          },
        },
        [
          { clientName: "Grep", wireName: "grep", inputSchemaValue: { type: "object", properties: { pattern: { type: "string" } } } },
          { clientName: "Glob", wireName: "glob", inputSchemaValue: globSchema },
        ],
        "cursor",
      );
      expect(globRedirect).toMatchObject({ adapter: "glob-direct", nativeResultType: "grepResult" });
      expect(globRedirect?.call.name).toBe("Glob");
      expect(JSON.parse(globRedirect?.call.arguments ?? "{}")).toEqual({
        pattern: "**/runtime/*/CLAUDE.md",
        path: "/repo",
      });
      // 공백만 있는 내용 검색은 파일 이름 검색이 아니므로 내용 조건을 버린 채 Glob으로 가지 않는다.
      expect(cursorNativeExecRedirect(
        {
          id: 4,
          execId: "native-grep-whitespace",
          grepArgs: { pattern: " ", path: "/repo", glob: "**/*.ts", outputMode: "files_with_matches" },
        },
        [{ clientName: "Glob", wireName: "glob", inputSchemaValue: globSchema }],
        "cursor",
      )).toBeNull();
      // Cursor prefixes an absolute glob_pattern with `**` too; the caller gets it relative to the path.
      const absoluteGlob = cursorNativeExecRedirect(
        {
          id: 3,
          execId: "native-glob-absolute",
          grepArgs: {
            path: "/repo",
            glob: "**/repo/runtime/*/CLAUDE.md",
            outputMode: "files_with_matches",
          },
        },
        [{ clientName: "Glob", wireName: "glob", inputSchemaValue: globSchema }],
        "cursor",
      );
      expect(JSON.parse(absoluteGlob?.call.arguments ?? "{}")).toEqual({
        pattern: "runtime/*/CLAUDE.md",
        path: "/repo",
      });
      const globCorrelation = {
        messageId: 2,
        execId: "native-glob",
        nativeResultType: "grepResult" as const,
        nativeArgs: globRedirect?.nativeArgs,
      };
      const globFiles = (output: string) => cursorNativeRedirectResultReplies(globCorrelation, output, false);
      // Claude Code 2.1.292 Glob: a bare cwd-relative list, cut with a counted notice.
      expect(redirectedFiles(globFiles(
        "runtime/a/CLAUDE.md\n[slug]/CLAUDE.md\n(Showing 2 of 120 matching files; 118 more are not listed. Narrow the pattern or path to see the rest.)",
      ))).toEqual({
        files: ["runtime/a/CLAUDE.md", "[slug]/CLAUDE.md"],
        totalFiles: 2,
        clientTruncated: true,
        ripgrepTruncated: false,
      });
      expect(redirectedFiles(globFiles("No files found"))).toMatchObject({ files: [], totalFiles: 0 });
      // An oversized Glob result keeps only its preview's whole paths.
      const longPath = (n: number) => `gl2/${"a".repeat(840)}/path-${n}.ts`;
      expect(redirectedFiles(globFiles([
        "<persisted-output>",
        "Output too large (84KB). Full output saved to: /tmp/session/tool-results/toolu_2.txt",
        "",
        "Preview (first 2KB):",
        longPath(1),
        longPath(2),
        "...",
        "</persisted-output>",
      ].join("\n")))).toEqual({
        files: [longPath(1), longPath(2)],
        totalFiles: 2,
        clientTruncated: true,
        ripgrepTruncated: false,
      });

      // A content search on the caller's Grep lists files under a count header. Names are
      // cwd-relative, so a real file can carry that header's or a notice's exact wording.
      const grepFiles = (output: string, offset?: string) => redirectedFiles(cursorNativeRedirectResultReplies({
        messageId: 5,
        execId: "native-grep-files",
        nativeResultType: "grepResult",
        nativeArgs: {
          pattern: "NEEDLE",
          path: "/repo",
          outputMode: "files_with_matches",
          ...(offset === undefined ? {} : { offset }),
        },
      }, output, false));
      const names = ["No matches found.txt", "Found 3 files", "No files found", "한글/파일.ts", "[slug]/page.tsx"];
      const listing = { files: names, totalFiles: 5, clientTruncated: false, ripgrepTruncated: false };
      expect(grepFiles(["Found 5 files", ...names].join("\n"))).toEqual(listing);
      expect(grepFiles(`${["Found 5 files", ...names].join("\r\n")}\r\n`)).toEqual(listing);
      expect(grepFiles("No files found")).toMatchObject({ files: [], totalFiles: 0 });
      expect(grepFiles("No entries at this offset. [Showing results with pagination = offset: 500]", "500"))
        .toMatchObject({ files: [], totalFiles: 0, offsetApplied: 500 });
      // An oversized result arrives as a saved-file notice whose preview lists only whole lines.
      const persisted = (preview: string) => [
        "<persisted-output>",
        "Output too large (31.3KB). Full output saved to: /tmp/session/tool-results/toolu_1.txt",
        "",
        "Preview (first 2KB):",
        preview,
        "...",
        "</persisted-output>",
      ].join("\n");
      // Short of the 2000-unit limit, the preview ended at a newline: its last path is whole.
      expect(grepFiles(persisted("Found 250 files limit: 250\nlong/file-260.txt\nlong/file-259.txt"))).toEqual({
        files: ["long/file-260.txt", "long/file-259.txt"],
        totalFiles: 2,
        clientTruncated: true,
        ripgrepTruncated: false,
      });
      // A preview filling the limit was cut inside a name too long to back off to its newline.
      const cutPreview = `Found 250 files limit: 250\nlong/file-260.txt\ndeep/${"d".repeat(2000)}`.slice(0, 2000);
      expect(grepFiles(persisted(cutPreview))).toMatchObject({ files: ["long/file-260.txt"], totalFiles: 1 });

      // Content and count notices sit after a blank line. A row whose name starts with `[` or
      // "No matches" is a file, and the caller's summary is not.
      const grepBranch = (outputMode: "content" | "count", output: string, offset?: string) => {
        const replies = cursorNativeRedirectResultReplies({
          messageId: 6,
          execId: "native-grep-body",
          nativeResultType: "grepResult",
          nativeArgs: {
            pattern: "NEEDLE",
            path: "/repo",
            outputMode,
            ...(offset === undefined ? {} : { offset }),
          },
        }, output, false);
        const reply = replies[0] as {
          execClientMessage?: {
            grepResult?: { success?: { workspaceResults?: Record<string, { content?: unknown; count?: unknown }> } };
          };
        };
        return Object.values(reply.execClientMessage?.grepResult?.success?.workspaceResults ?? {})[0];
      };
      expect(grepBranch("content", [
        "[top]/first.txt:1:[needle first]",
        "No matches.txt:2:needle",
        "",
        "[Showing results with pagination = limit: 2]",
      ].join("\n"))?.content).toEqual({
        matches: [
          {
            file: "[top]/first.txt",
            matches: [{
              lineNumber: 1,
              content: "[needle first]",
              contentTruncated: false,
              isContextLine: false,
            }],
          },
          {
            file: "No matches.txt",
            matches: [{
              lineNumber: 2,
              content: "needle",
              contentTruncated: false,
              isContextLine: false,
            }],
          },
        ],
        totalLines: 2,
        totalMatchedLines: 2,
        clientTruncated: true,
        ripgrepTruncated: false,
      });
      expect(grepBranch("count", [
        "[top]/first.txt:2",
        "no matches here.md:1",
        "",
        "Found 12 total occurrences across 6 files. with pagination = limit: 2",
      ].join("\n"))?.count).toEqual({
        counts: [
          { file: "[top]/first.txt", count: 2 },
          { file: "no matches here.md", count: 1 },
        ],
        totalFiles: 2,
        totalMatches: 3,
        clientTruncated: true,
        ripgrepTruncated: false,
      });
      // An offset-only page still has its rows. `limit: N` is what marks a cut.
      expect(grepBranch("content", [
        "[top]/first.txt:1:needle",
        "",
        "[Showing results with pagination = offset: 100]",
      ].join("\n"), "100")?.content).toMatchObject({
        totalLines: 1,
        totalMatchedLines: 1,
        clientTruncated: false,
        offsetApplied: 100,
      });
      expect(grepBranch("count", [
        "[top]/first.txt:2",
        "",
        "Found 12 total occurrences across 6 files. with pagination = offset: 100",
      ].join("\n"), "100")?.count).toMatchObject({
        totalFiles: 1,
        totalMatches: 2,
        clientTruncated: false,
        offsetApplied: 100,
      });
      expect(grepBranch("content", "No matches found")?.content).toMatchObject({
        matches: [],
        totalLines: 0,
        clientTruncated: false,
      });
      // A single-file body has no path prefix. It must not be read as a file name.
      expect(grepBranch("content", "[needle first]\nneedle second")?.content).toMatchObject({
        matches: [],
        totalLines: 0,
      });
    } finally {
      harness.adapter.dispose();
    }
  });

  it("redirects a ranged native read to the caller Read and claims success only for a proven range", async () => {
    // Cursor announces the model's read, then runs it; its call id carries a newline.
    const callId = "call-read-0\nfc_read_0";
    const path = "/repo/runtime/fleet-console/CLAUDE.md";
    const stream = new BridgeCursorStream(
      [
        { interactionUpdate: { toolCallStarted: { callId, toolCall: { readToolCall: { args: { path, limit: 3 } } } } } },
        { execServerMessage: { id: 41, execId: "exec-41", readArgs: { path, toolCallId: callId, limit: 3 } } },
      ],
      cursorCompletionFrames("read handled"),
      1,
    );
    const diagnostics: CursorDiagnosticEvent[] = [];
    const harness = cursorHarness([stream], { diagnostics: (event) => diagnostics.push(event) });
    const readSchema = {
      type: "object",
      properties: { file_path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } },
      required: ["file_path"],
      additionalProperties: false,
    };
    const initial: CanonicalResponseRequest = {
      ...cursorRequest("session-native-ranged-read", "composer-2.5"),
      tools: [{ type: "function", name: "Read", description: "Read a file", parameters: readSchema }],
    };

    try {
      const initialEvents = await collectCursorResponse(harness.adapter, initial);
      const redirected = initialEvents.flatMap((event) => (
        event.type === "response.output_item.done" && event.item.type === "function_call" ? [event.item] : []
      ))[0];
      if (!redirected) throw new Error("Missing redirected Read call");
      expect(redirected.name).toBe("Read");
      expect(JSON.parse(redirected.arguments)).toEqual({ file_path: path, limit: 3 });
      expect(diagnostics).toContainEqual(expect.objectContaining({
        event: "exec.read.range",
        outcome: "exec exec:limit started:limit",
      }));

      // Claude Code 2.1.292's own Read output for those lines.
      const events = await collectCursorResponse(harness.adapter, cursorContinuation(
        initial,
        [{ callId: redirected.call_id, toolCallId: callId, messageId: 41, execId: "exec-41", name: "Read" }],
        [{ call_id: redirected.call_id, output: "1\tline 1\n2\tline 2\n3\tline 3" }],
      ));
      expect(canonicalText(events)).toBe("read handled");
      expect(cursorClientWrites(stream)).toContainEqual(expect.objectContaining({
        execClientMessage: expect.objectContaining({
          readResult: { success: { path, content: "line 1\nline 2\nline 3", rangeApplied: true } },
        }),
      }));
    } finally {
      harness.adapter.dispose();
    }

    const readTool = [{ clientName: "Read", wireName: "read", inputSchemaValue: readSchema }];
    const nativeRead = (readArgs: Record<string, unknown>, started?: Record<string, unknown>) => (
      cursorNativeExecRedirect({ id: 7, execId: "exec-7", readArgs: { path, toolCallId: "t", ...readArgs } }, readTool, "cursor", started)
    );
    // A limit announced only on toolCallStarted is enough; the offset base does not matter for it.
    expect(JSON.parse(nativeRead({}, { path, limit: 30 })?.call.arguments ?? "{}")).toEqual({ file_path: path, limit: 30 });
    // No range, or one the caller's Read cannot state exactly, never becomes a whole-file read.
    for (const [readArgs, started] of [
      [{}, undefined],
      [{}, { path }],
      [{ offset: 1 }, undefined],
      [{}, { path, offset: 5, limit: 3 }],
      [{ offset: 5, limit: 3 }, { path, offset: 4, limit: 3 }],
      [{ limit: 0 }, undefined],
      [{ offset: -3 }, undefined],
      [{ limit: 3, encodingHint: "utf-16le" }, undefined],
    ] as const) {
      expect(nativeRead(readArgs, started)).toBeNull();
    }

    // Output that does not prove the range keeps the caller's text and claims no success.
    const correlation = {
      messageId: 7,
      execId: "exec-7",
      nativeResultType: "readResult" as const,
      nativeArgs: { path, startLine: "50" },
    };
    for (const output of [
      "<system-reminder>Warning: the file exists but is shorter than the provided offset (50). The file has 41 lines.</system-reminder>",
      "1\tline 1\n2\tline 2",
    ]) {
      expect(cursorNativeRedirectResultReplies(correlation, output, false)).toEqual([{
        execClientMessage: {
          id: 7,
          execId: "exec-7",
          readResult: { error: { path, error: expect.stringContaining(`Caller output:\n${output}`) } },
        },
      }]);
    }
  });

  it("parks a call whose exec message is the first of the Run and keeps it across an unknown update", async () => {
    // Cursor numbers exec messages from zero and `id` has implicit presence, so the first client
    // tool of a Run arrives with no `id` field at all. Every other call here carries a nonzero id.
    const call = cursorCall("call-first-exec-of-run", 0);
    const stream = new BridgeCursorStream(
      cursorToolFrames([call]),
      cursorCompletionFrames("first exec completed"),
      1,
    );
    const diagnostics: CursorDiagnosticEvent[] = [];
    const harness = cursorHarness([stream], {
      diagnostics: (event) => diagnostics.push(event),
    });
    const initial = cursorRequest("session-first-exec", "grok-4.5");

    try {
      await collectCursorResponseWithDiagnostics(harness.adapter, initial, true);
      // Measured 2026-10-06 (cursor-agent 2026.10.01): an update carrying only fields this
      // descriptor does not know can land right after a park. It must not cost the warm Run.
      await stream.emitFrames([unknownOnlyInteractionUpdate(25)]);
      const secondEvents = await collectCursorResponseWithDiagnostics(
        harness.adapter,
        cursorContinuation(initial, [call], [cursorResult(call, "README contents")]),
        true,
      );

      expect(canonicalText(secondEvents)).toBe("first exec completed");
      expect(diagnostics).toContainEqual(expect.objectContaining({
        event: "server.frame",
        frame: "interactionUpdate.unknownField25",
      }));
      expect(diagnostics).toContainEqual(expect.objectContaining({
        event: "bridge.park",
        outcome: "client_tool_suspended",
      }));
      expect(diagnostics).toContainEqual(expect.objectContaining({
        event: "bridge.attach",
        outcome: "exact_match",
      }));
      expect(diagnostics).not.toContainEqual(expect.objectContaining({ event: "bridge.mismatch" }));
      expect(harness.openedStreams).toBe(1);
    } finally {
      harness.adapter.dispose();
    }
  });

  it("asks once more on a new Run when grok-4.7 only announces its next step after a tool result", async () => {
    // grok-4.7 sometimes ends a tool-result turn on an announcement with no reasoning and no call;
    // the same input with the announcement replayed and a short nudge appended reasons and calls
    // the tool (22/22, 2026-10-07). Cursor closes the stream at turnEnded, so the ask is a new Run.
    const first = cursorCall("call-resample-1", 1);
    const recovered = cursorCall("call-resample-2", 2);
    const waiting = cursorCall("call-resample-4", 4);
    const announcement = "Now I'll run the tests.";
    const firstRun = new BridgeCursorStream(cursorToolFrames([first]));
    // Claude Code appends a background-job notice to the result turn as its own user text, so the
    // bridge cold-resumes; the turn is still a tool-result turn and must stay armed.
    const announcedRun = new BridgeCursorStream(cursorCompletionFrames(announcement));
    const recoveredRun = new BridgeCursorStream(
      [
        { conversationCheckpointUpdate: { tokenDetails: { usedTokens: 5_000, maxTokens: 256_000 } } },
        { interactionUpdate: { thinkingDelta: { text: "Run them." } } },
        { interactionUpdate: { textDelta: { text: "Running the tests." } } },
        ...cursorToolFrames([recovered]),
      ],
      cursorCompletionFrames("Still checking."),
      1,
    );
    const textAgainRun = new BridgeCursorStream(cursorCompletionFrames("Checking again."));
    const yieldingRun = new BridgeCursorStream(
      cursorToolFrames([waiting]),
      cursorCompletionFrames("Waiting for the background job."),
      1,
    );
    // Would recover with a call if the gateway asked again after the yielding call.
    const unwantedRun = new BridgeCursorStream(cursorToolFrames([cursorCall("call-resample-5", 5)]));
    const harness = cursorHarness([
      firstRun,
      announcedRun,
      recoveredRun,
      textAgainRun,
      yieldingRun,
      unwantedRun,
    ]);
    const adapter = harness.adapter.forHarness({
      yieldToolCalls: [{ name: "probe_tool", whenArgumentTrue: "background" }],
    });
    const turn = async (request: CanonicalResponseRequest) => (
      collectAdapterEvents(await adapter.stream(request, { apiKey: "cursor-test-token" }))
    );
    const call = (spec: CursorCallSpec, args: Record<string, unknown> = { path: "README.md" }) => ({
      type: "function_call" as const,
      call_id: spec.callId,
      name: spec.name,
      arguments: JSON.stringify(args),
    });
    const initial = cursorRequest("session-resample", "grok-4.7");
    const afterFirst = [
      ...initial.input,
      call(first),
      cursorResult(first, "ok"),
      {
        type: "message" as const,
        role: "user" as const,
        content: "<system-reminder>A background task finished.</system-reminder>",
      },
    ];
    const afterRecovered = [
      ...afterFirst,
      { type: "message" as const, role: "assistant" as const, content: announcement },
      call(recovered),
      cursorResult(recovered, "ok"),
    ];
    const prompted = [
      ...afterRecovered,
      { type: "message" as const, role: "assistant" as const, content: "Still checking." },
      { type: "message" as const, role: "user" as const, content: "Wait for the job." },
    ];

    try {
      await turn(initial);
      const recovery = await turn({ ...initial, input: afterFirst });

      // One message: the announcement once, then the recovered call. The second Run's own
      // re-announcement is dropped so the user does not read the same step twice.
      expect(recovery.filter((event) => event.type === "response.created")).toHaveLength(1);
      expect(canonicalText(recovery)).toBe(announcement);
      expect(addedFunctionCallIds(recovery)).toEqual([recovered.callId]);
      expect(announcedRun.closed).toBe(true);
      expect(cursorClientWrites(recoveredRun)[0]).toMatchObject({
        runRequest: { action: { userMessageAction: { userMessage: { text: expect.any(String) } } } },
      });

      // The recovered Run stays warm for the client's next request even though that request is
      // smaller than the nudged one Cursor measured.
      const second = await turn({ ...initial, input: afterRecovered });
      expect(harness.openedStreams).toBe(4);
      expect(cursorMcpResultWrites(recoveredRun)).toHaveLength(1);
      // That continuation only announced too; a second ask that announces again is dropped, the
      // client gets the first answer, and there is no third ask.
      expect(canonicalText(second)).toBe("Still checking.");
      expect(addedFunctionCallIds(second)).toEqual([]);

      // After a call that yields the turn to wait, a short text ending is the wait itself.
      await turn({ ...initial, input: prompted });
      const waited = await turn({
        ...initial,
        input: [...prompted, call(waiting, { path: "README.md", background: true }), cursorResult(waiting, "started")],
      });
      expect(canonicalText(waited)).toBe("Waiting for the background job.");
      expect(addedFunctionCallIds(waited)).toEqual([]);
      expect(harness.openedStreams).toBe(5);
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
    const initial = cursorRequest("shared-credential-conversation", "grok-4.5");
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

  it("atomically claims a pending Run so concurrent attaches cannot double-write", async () => {
    const call = cursorCall("call-atomic", 71);
    const parked = new BridgeCursorStream(
      cursorToolFrames([call]),
      cursorCompletionFrames("attached once"),
      1,
    );
    const fallback = new BridgeCursorStream(cursorCompletionFrames("duplicate fallback"));
    const harness = cursorHarness([parked, fallback]);
    const initial = cursorRequest("session-atomic", "composer-2.5-fast");
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

  it("cancels an attached Run when the client aborts before suspension", async () => {
    const stream = new BridgeCursorStream([]);
    const harness = cursorHarness([stream]);
    const controller = new AbortController();
    const response = await harness.adapter.stream(
      cursorRequest("session-abort-before", "grok-4.5"),
      { apiKey: "cursor-test-token", signal: controller.signal },
    );
    const collecting = collectAdapterEvents(response);
    controller.abort();

    await expect(collecting).rejects.toThrow("cancelled by caller");
    expect(stream.closed).toBe(true);
    expect(harness.sessions[0]?.closeCount).toBeGreaterThan(0);
    harness.adapter.dispose();
  });
});

async function expectCorrelationBatchColdFallback(
  frames: readonly unknown[],
  calls: readonly CursorCallSpec[],
  userId: string,
): Promise<void> {
  const rejected = new BridgeCursorStream(frames);
  const fallback = new BridgeCursorStream(cursorCompletionFrames("correlation cold fallback"));
  const harness = cursorHarness([rejected, fallback]);
  const initial = cursorRequest(userId, "grok-4.5");

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

function addedFunctionCallIds(events: readonly CanonicalResponseEvent[]): readonly string[] {
  return events.flatMap((event) => (
    event.type === "response.output_item.added" && event.item.type === "function_call"
      ? [event.item.call_id]
      : []
  ));
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

function cursorExecResultCompleted(message: Record<string, unknown>): boolean {
  return message.mcpResult !== undefined
    || message.readResult !== undefined
    || message.grepResult !== undefined
    || message.shellResult !== undefined;
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
  private responded = false;
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
    this.respond();
    const message = decodeCursorClientFrame(value);
    if (!this.initialReleased && isRecord(message) && message.runRequest !== undefined) {
      this.initialReleased = true;
      this.release(this.initialFrames);
    }
    if (
      isRecord(message)
      && isRecord(message.execClientMessage)
      && cursorExecResultCompleted(message.execClientMessage)
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

  /** Cursor answers with response headers before any frame; the adapter gates decoding on them. */
  private respond(): void {
    if (this.responded) return;
    this.responded = true;
    queueMicrotask(() => this.emit("response", {
      ":status": 200,
      "content-type": "application/connect+proto",
    }));
  }

  /**
   * Deliver frames at an arbitrary point, which is the only way to place Cursor's trailing tail
   * after a park: the park itself is driven by the adapter's own finalize timer, so no
   * write-triggered release can land on the far side of it.
   */
  async emitFrames(frames: readonly unknown[]): Promise<void> {
    this.release(frames);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  private release(frames: readonly unknown[]): void {
    if (frames.length === 0) return;
    // A macrotask, so the adapter's response-head continuation has installed its data
    // listener first — an EventEmitter drops what it emits with no listener attached.
    setImmediate(() => {
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
  if (value instanceof Uint8Array) return encodeConnectFrame(value);
  const message = fromJson(AgentServerMessageSchema, value as JsonValue);
  return encodeConnectFrame(toBinary(AgentServerMessageSchema, message));
}

/** An `interactionUpdate` whose only field is one the vendored descriptor does not declare. */
function unknownOnlyInteractionUpdate(fieldNumber: number): Uint8Array {
  const interactionUpdate = AgentServerMessageSchema.fields
    .find((field) => field.localName === "interactionUpdate");
  if (!interactionUpdate) throw new Error("Missing interactionUpdate field");
  const inner = new BinaryWriter();
  inner.tag(fieldNumber, WireType.Varint).uint64(1_760_000_000_000n);
  const outer = new BinaryWriter();
  outer.tag(interactionUpdate.number, WireType.LengthDelimited).bytes(inner.finish());
  return outer.finish();
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

function redirectedFiles(replies: readonly unknown[]): unknown {
  const reply = replies[0] as {
    execClientMessage?: { grepResult?: { success?: { workspaceResults?: Record<string, { files?: unknown }> } } };
  };
  return Object.values(reply.execClientMessage?.grepResult?.success?.workspaceResults ?? {})[0]?.files;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
