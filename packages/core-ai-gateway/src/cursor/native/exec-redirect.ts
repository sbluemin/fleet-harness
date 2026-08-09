type ExecMessage = Record<string, unknown>;

export type CursorNativeRedirectResultType =
  | "readResult"
  | "grepResult"
  | "shellResult"
  | "shellStreamResult";

export interface CursorRedirectToolReference {
  readonly clientName: string;
  readonly wireName: string;
  readonly inputSchemaValue: Record<string, unknown>;
}

export interface CursorNativeExecRedirect {
  readonly call: {
    readonly callId: string;
    readonly toolCallId: string;
    readonly messageId: number;
    readonly execId: string;
    readonly name: string;
    readonly providerIdentifier: string;
    readonly arguments: string;
  };
  readonly nativeResultType: CursorNativeRedirectResultType;
  readonly nativeArgs: Readonly<Record<string, string>>;
  readonly execCase: string;
  readonly adapter: "read-direct" | "grep-direct" | "shell-direct";
}

const READ_CANDIDATES = ["Read"] as const;
const GREP_CANDIDATES = ["Grep"] as const;
const SHELL_CANDIDATES = ["Bash", "shell_command", "exec_command"] as const;

/** Tools needed to redirect the native operations whose result contract Fleet can preserve. */
export const CURSOR_HOT_PATH_TOOL_LEAVES = [
  "read",
  "bash",
  "grep",
  "shellcommand",
  "execcommand",
  "toolsearch",
] as const;

export function isCursorHotPathToolName(name: string): boolean {
  const leaf = toolLeafName(name).replace(/[_-]/g, "").toLowerCase();
  return (CURSOR_HOT_PATH_TOOL_LEAVES as readonly string[]).includes(leaf);
}

/** Caller tools whose Cursor-native equivalent is redirected without advertising a duplicate. */
export function isCursorNativeRedirectToolName(name: string): boolean {
  const leaf = toolLeafName(name).replace(/[_-]/g, "").toLowerCase();
  return ["read", "grep", "bash", "shellcommand", "execcommand"].includes(leaf);
}

/**
 * Convert a Cursor-native exec into a caller-owned tool call only when that caller schema can
 * represent the native operation without dropping a requested semantic. Unsupported and lossy
 * cases deliberately fall through to the typed fail-closed policy.
 */
export function cursorNativeExecRedirect(
  exec: ExecMessage,
  tools: readonly CursorRedirectToolReference[],
  providerIdentifier: string,
): CursorNativeExecRedirect | null {
  const messageId = numberValue(exec.id ?? 0);
  const execId = stringValue(exec.execId) || `redirect-${messageId}`;

  if (isRecord(exec.readArgs)) {
    const path = stringValue(exec.readArgs.path);
    if (!path) return null;
    const offset = numberOrUndefined(exec.readArgs.offset);
    const limit = numberOrUndefined(exec.readArgs.limit);
    // Fleet's vendored ReadSuccess has no rangeApplied field. Redirecting a ranged read would force
    // totalLines to claim either the slice length or zero as the whole-file count, so keep it on the
    // typed fail-closed path until the wire can represent that distinction.
    if (offset !== undefined || limit !== undefined) return null;
    const mapped = tools
      .filter((tool) => matchesLeaf(tool, READ_CANDIDATES))
      .map((tool) => ({ tool, args: readArguments(tool.inputSchemaValue, path, offset, limit) }))
      .find((candidate) => candidate.args !== null);
    if (!mapped?.args) return null;
    return redirect(exec, mapped.tool, providerIdentifier, messageId, execId, "readArgs", "readResult", "read-direct", mapped.args, {
      path,
      ...(offset === undefined ? {} : { offset: String(offset) }),
      ...(limit === undefined ? {} : { limit: String(limit) }),
    });
  }

  if (isRecord(exec.grepArgs)) {
    const grepArgs = exec.grepArgs;
    const pattern = stringValue(grepArgs.pattern);
    if (!pattern.trim()) return null;
    const path = stringValue(grepArgs.path) || ".";
    const glob = stringValue(grepArgs.glob);
    const outputMode = normalizedGrepOutputMode(stringValue(grepArgs.outputMode));
    if (!outputMode) return null;
    const mapped = tools
      .filter((tool) => matchesLeaf(tool, GREP_CANDIDATES))
      .map((tool) => ({
        tool,
        args: grepArguments(tool, {
          pattern,
          path,
          glob,
          outputMode,
          caseInsensitive: grepArgs.caseInsensitive === true,
          contextBefore: numberOrUndefined(grepArgs.contextBefore),
          contextAfter: numberOrUndefined(grepArgs.contextAfter),
          context: numberOrUndefined(grepArgs.context),
          headLimit: numberOrUndefined(grepArgs.headLimit),
          offset: numberOrUndefined(grepArgs.offset),
        }),
      }))
      .find((candidate) => candidate.args !== null);
    if (!mapped?.args) return null;
    return redirect(exec, mapped.tool, providerIdentifier, messageId, execId, "grepArgs", "grepResult", "grep-direct", mapped.args, {
      pattern,
      path,
      outputMode,
      ...(glob ? { glob } : {}),
      ...(numberOrUndefined(grepArgs.offset) === undefined
        ? {}
        : { offset: String(numberOrUndefined(grepArgs.offset)) }),
    });
  }

  if (isRecord(exec.shellArgs) || isRecord(exec.shellStreamArgs)) {
    const argsRecord: ExecMessage = isRecord(exec.shellArgs) ? exec.shellArgs : (exec.shellStreamArgs as ExecMessage);
    const command = stringValue(argsRecord.command);
    if (!command) return null;
    const cwd = stringValue(argsRecord.workingDirectory);
    const timeout = positiveNumber(argsRecord.timeout) ?? positiveNumber(argsRecord.hardTimeout);
    const mapped = tools
      .filter((tool) => matchesLeaf(tool, SHELL_CANDIDATES))
      .map((tool) => ({ tool, args: shellArguments(tool.inputSchemaValue, command, cwd || undefined, timeout) }))
      .find((candidate) => candidate.args !== null);
    if (!mapped?.args) return null;
    const stream = isRecord(exec.shellStreamArgs);
    return redirect(
      exec,
      mapped.tool,
      providerIdentifier,
      messageId,
      execId,
      stream ? "shellStreamArgs" : "shellArgs",
      stream ? "shellStreamResult" : "shellResult",
      "shell-direct",
      mapped.args,
      {
        command,
        ...(cwd ? { workingDirectory: cwd } : {}),
      },
    );
  }

  return null;
}

export function cursorNativeRedirectResultReplies(
  correlation: {
    readonly messageId: number;
    readonly execId: string;
    readonly nativeResultType: CursorNativeRedirectResultType;
    readonly nativeArgs?: Readonly<Record<string, string>>;
  },
  output: string,
  isError: boolean,
): readonly unknown[] {
  const exec = { id: correlation.messageId, execId: correlation.execId };
  const args = correlation.nativeArgs ?? {};
  const shellOutput = parseCallerShellOutput(output, isError);
  if (isError && !correlation.nativeResultType.startsWith("shell")) {
    return cursorNativeRedirectErrorReplies(correlation, output);
  }

  switch (correlation.nativeResultType) {
    case "readResult": {
      const parsed = parseCallerReadOutput(output);
      return [execReply(exec, "readResult", {
        success: {
          path: args.path ?? "",
          totalLines: lineCount(parsed.content),
          fileSize: String(Buffer.byteLength(parsed.content, "utf8")),
          truncated: parsed.truncated,
          content: parsed.content,
        },
      })];
    }
    case "grepResult": {
      return [execReply(exec, "grepResult", {
        success: buildGrepSuccess(args, output),
      })];
    }
    case "shellResult": {
      return [execReply(exec, "shellResult", shellResult(args, shellOutput))];
    }
    case "shellStreamResult": {
      const cwd = args.workingDirectory ?? "";
      return [
        execReply(exec, "shellStream", { start: {} }),
        ...(shellOutput.stdout.length > 0
          ? [execReply(exec, "shellStream", { stdout: { data: shellOutput.stdout } })]
          : []),
        ...(shellOutput.stderr.length > 0
          ? [execReply(exec, "shellStream", { stderr: { data: shellOutput.stderr } })]
          : []),
        execReply(exec, "shellStream", {
          exit: {
            code: shellOutput.exitCode,
            cwd,
            aborted: shellOutput.aborted,
          },
        }),
        execReply(exec, "shellResult", shellResult(args, shellOutput)),
        { execClientControlMessage: { streamClose: { id: correlation.messageId } } },
      ];
    }
  }
}

function cursorNativeRedirectErrorReplies(
  correlation: {
    readonly messageId: number;
    readonly execId: string;
    readonly nativeResultType: CursorNativeRedirectResultType;
    readonly nativeArgs?: Readonly<Record<string, string>>;
  },
  error: string,
): readonly unknown[] {
  const exec = { id: correlation.messageId, execId: correlation.execId };
  const args = correlation.nativeArgs ?? {};
  switch (correlation.nativeResultType) {
    case "readResult":
      return [execReply(exec, "readResult", { error: { path: args.path ?? "", error } })];
    case "grepResult":
      return [execReply(exec, "grepResult", { error: { error } })];
    case "shellResult":
      return [execReply(exec, "shellResult", shellFailure(args, error))];
    case "shellStreamResult": {
      const cwd = args.workingDirectory ?? "";
      return [
        execReply(exec, "shellStream", { start: {} }),
        execReply(exec, "shellStream", { stderr: { data: error } }),
        execReply(exec, "shellStream", { exit: { code: 1, cwd, aborted: true } }),
        execReply(exec, "shellResult", shellFailure(args, error)),
        { execClientControlMessage: { streamClose: { id: correlation.messageId } } },
      ];
    }
  }
}

function readArguments(
  schema: Record<string, unknown>,
  path: string,
  offset: number | undefined,
  limit: number | undefined,
): Record<string, unknown> | null {
  const pathKey = firstSchemaProperty(schema, ["file_path", "path"]);
  if (!pathKey) return null;
  if (offset !== undefined && !schemaHasProperty(schema, "offset")) return null;
  if (limit !== undefined && !schemaHasProperty(schema, "limit")) return null;
  return {
    [pathKey]: path,
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
  };
}

interface GrepMappingInput {
  readonly pattern: string;
  readonly path: string;
  readonly glob: string;
  readonly outputMode: "content" | "files_with_matches" | "count";
  readonly caseInsensitive: boolean;
  readonly contextBefore?: number;
  readonly contextAfter?: number;
  readonly context?: number;
  readonly headLimit?: number;
  readonly offset?: number;
}

function grepArguments(
  tool: CursorRedirectToolReference,
  input: GrepMappingInput,
): Record<string, unknown> | null {
  const leaf = normalizedLeaf(tool.clientName);
  if (leaf === "grep") {
    if (!schemaHasProperty(tool.inputSchemaValue, "pattern")) return null;
    const args: Record<string, unknown> = { pattern: input.pattern };
    if (input.path !== ".") {
      if (!schemaHasProperty(tool.inputSchemaValue, "path")) return null;
      args.path = input.path;
    }
    const optionMappings: ReadonlyArray<readonly [unknown, string]> = [
      [input.glob || undefined, "glob"],
      [input.outputMode === "content" ? undefined : input.outputMode, "output_mode"],
      [input.caseInsensitive ? true : undefined, "case_insensitive"],
      [input.contextBefore, "context_before"],
      [input.contextAfter, "context_after"],
      [input.context, "context"],
      [input.headLimit, "head_limit"],
      [input.offset, "offset"],
    ];
    for (const [value, key] of optionMappings) {
      if (value === undefined) continue;
      if (!schemaHasProperty(tool.inputSchemaValue, key)) return null;
      args[key] = value;
    }
    return args;
  }
  return null;
}

function shellArguments(
  schema: Record<string, unknown>,
  command: string,
  cwd: string | undefined,
  timeout: number | undefined,
): Record<string, unknown> | null {
  const commandKey = firstSchemaProperty(schema, ["command", "cmd"]);
  if (!commandKey) return null;
  const args: Record<string, unknown> = { [commandKey]: command };
  if (cwd) {
    const cwdKey = firstSchemaProperty(schema, ["working_directory", "workdir", "cwd"]);
    if (!cwdKey) return null;
    args[cwdKey] = cwd;
  }
  if (timeout !== undefined) {
    if (!schemaHasProperty(schema, "timeout")) return null;
    args.timeout = timeout;
  }
  if (schemaHasProperty(schema, "description")) {
    args.description = "Cursor-native tool redirected through the Fleet client bridge";
  }
  return args;
}

function buildGrepSuccess(
  args: Readonly<Record<string, string>>,
  output: string,
): Record<string, unknown> {
  const outputMode = normalizedGrepOutputMode(args.outputMode) ?? "content";
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !line.startsWith("[") && !/^no matches/i.test(line));
  const path = args.path || ".";
  let result: Record<string, unknown>;
  if (outputMode === "files_with_matches") {
    result = {
      files: {
        files: lines,
        totalFiles: lines.length,
        clientTruncated: false,
        ripgrepTruncated: false,
        ...(args.offset === undefined ? {} : { offsetApplied: Number(args.offset) }),
      },
    };
  } else if (outputMode === "count") {
    const counts = lines.flatMap((line) => {
      const separator = line.lastIndexOf(":");
      if (separator < 1) return [];
      const count = Number.parseInt(line.slice(separator + 1), 10);
      return Number.isNaN(count) ? [] : [{ file: line.slice(0, separator), count }];
    });
    result = {
      count: {
        counts,
        totalFiles: counts.length,
        totalMatches: counts.reduce((sum, entry) => sum + entry.count, 0),
        clientTruncated: false,
        ripgrepTruncated: false,
        ...(args.offset === undefined ? {} : { offsetApplied: Number(args.offset) }),
      },
    };
  } else {
    const byFile = new Map<string, Array<Record<string, unknown>>>();
    let totalMatchedLines = 0;
    for (const line of lines) {
      const matched = line.match(/^(.+?):(\d+):\s?(.*)$/);
      const context = line.match(/^(.+?)-(\d+)-\s?(.*)$/);
      const parsed = matched ?? context;
      if (!parsed) continue;
      const [, file, lineNumber, content] = parsed;
      if (!file || !lineNumber || content === undefined) continue;
      const entries = byFile.get(file) ?? [];
      entries.push({
        lineNumber: Number(lineNumber),
        content,
        contentTruncated: false,
        isContextLine: context !== null,
      });
      byFile.set(file, entries);
      if (!context) totalMatchedLines += 1;
    }
    const matches = [...byFile].map(([file, fileMatches]) => ({ file, matches: fileMatches }));
    result = {
      content: {
        matches,
        totalLines: matches.reduce((sum, entry) => sum + entry.matches.length, 0),
        totalMatchedLines,
        clientTruncated: false,
        ripgrepTruncated: false,
        ...(args.offset === undefined ? {} : { offsetApplied: Number(args.offset) }),
      },
    };
  }
  return {
    pattern: args.pattern ?? "",
    path,
    outputMode,
    workspaceResults: { [path]: result },
  };
}

function parseCallerReadOutput(output: string): { readonly content: string; readonly truncated: boolean } {
  const lines = output.split(/\r?\n/);
  const contentLines: string[] = [];
  let numbered = 0;
  let truncated = false;
  for (const line of lines) {
    if (/^\s*\[?(?:showing|output truncated|truncated)/i.test(line)) {
      truncated = true;
      continue;
    }
    const match = line.match(/^\s*\d+[→\t│|]\s?(.*)$/);
    if (match) {
      numbered += 1;
      contentLines.push(match[1] ?? "");
    } else {
      contentLines.push(line);
    }
  }
  return {
    content: numbered > 0 ? contentLines.join("\n") : output,
    truncated,
  };
}

interface CallerShellOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly aborted: boolean;
}

function parseCallerShellOutput(output: string, isError: boolean): CallerShellOutput {
  const match = output.match(/^Exit code (-?\d+)\r?\n([\s\S]*)$/);
  if (match) {
    const exitCode = Number.parseInt(match[1] ?? "1", 10);
    return {
      stdout: "",
      stderr: match[2] ?? "",
      exitCode: Number.isSafeInteger(exitCode) ? exitCode : 1,
      aborted: false,
    };
  }
  return isError
    ? { stdout: "", stderr: output, exitCode: 1, aborted: true }
    : { stdout: output, stderr: "", exitCode: 0, aborted: false };
}

function shellResult(
  args: Readonly<Record<string, string>>,
  output: CallerShellOutput,
): Record<string, unknown> {
  const details = {
    command: args.command ?? "",
    workingDirectory: args.workingDirectory ?? "",
    exitCode: output.exitCode,
    signal: "",
    stdout: output.stdout,
    stderr: output.stderr,
    executionTime: 0,
  };
  return output.exitCode === 0
    ? { success: details }
    : { failure: { ...details, aborted: output.aborted } };
}

function shellFailure(args: Readonly<Record<string, string>>, error: string): Record<string, unknown> {
  return {
    failure: {
      command: args.command ?? "",
      workingDirectory: args.workingDirectory ?? "",
      exitCode: 1,
      signal: "",
      stdout: "",
      stderr: error,
      executionTime: 0,
      aborted: true,
    },
  };
}

function redirect(
  exec: ExecMessage,
  tool: CursorRedirectToolReference,
  providerIdentifier: string,
  messageId: number,
  execId: string,
  execCase: string,
  nativeResultType: CursorNativeRedirectResultType,
  adapter: CursorNativeExecRedirect["adapter"],
  args: Record<string, unknown>,
  nativeArgs: Record<string, string>,
): CursorNativeExecRedirect {
  const toolCallId = execArgsToolCallId(exec) || crypto.randomUUID();
  return {
    call: {
      callId: toolCallId,
      toolCallId,
      messageId,
      execId,
      name: tool.clientName,
      providerIdentifier,
      arguments: JSON.stringify(args),
    },
    nativeResultType,
    nativeArgs,
    execCase,
    adapter,
  };
}

function execArgsToolCallId(exec: ExecMessage): string {
  for (const value of Object.values(exec)) {
    if (!isRecord(value)) continue;
    const toolCallId = stringValue(value.toolCallId);
    if (toolCallId) return toolCallId;
  }
  return "";
}

function matchesLeaf(tool: CursorRedirectToolReference, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => normalizedLeaf(tool.clientName) === normalizedLeaf(candidate));
}

function normalizedLeaf(name: string): string {
  return toolLeafName(name).replace(/[_-]/g, "").toLowerCase();
}

function normalizedGrepOutputMode(value: string): "content" | "files_with_matches" | "count" | undefined {
  if (!value || value === "content") return "content";
  if (value === "files_with_matches" || value === "count") return value;
  return undefined;
}

function firstSchemaProperty(schema: Record<string, unknown>, candidates: readonly string[]): string | undefined {
  return candidates.find((candidate) => schemaHasProperty(schema, candidate));
}

function schemaHasProperty(schema: Record<string, unknown>, name: string): boolean {
  return isRecord(schema.properties) && Object.prototype.hasOwnProperty.call(schema.properties, name);
}

function execReply(exec: ExecMessage, resultName: string, result: unknown): unknown {
  return {
    execClientMessage: {
      id: numberValue(exec.id),
      ...(stringValue(exec.execId) ? { execId: stringValue(exec.execId) } : {}),
      [resultName]: result,
    },
  };
}

function toolLeafName(name: string): string {
  return name.split("__").at(-1) ?? name;
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const number = numberOrUndefined(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
