type ExecMessage = Record<string, unknown>;

export type CursorNativeRedirectResultType =
  | "readResult"
  | "grepResult"
  | "grepShellResult"
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
  readonly adapter: "read-direct" | "grep-direct" | "glob-direct" | "grep-shell" | "shell-direct";
}

interface CursorGrepInput {
  readonly pattern: string;
  readonly path: string;
  readonly glob: string;
  readonly outputMode: "content" | "files_with_matches" | "count";
  readonly caseInsensitive: boolean;
  readonly contextBefore?: number;
  readonly contextAfter?: number;
  readonly context?: number;
  readonly type?: string;
  readonly headLimit?: number;
  readonly multiline: boolean;
  readonly sort?: string;
  readonly sortAscending?: boolean;
  readonly offset?: number;
}

const READ_CANDIDATES = ["Read"] as const;
const GREP_CANDIDATES = ["Grep"] as const;
const GLOB_CANDIDATES = ["Glob"] as const;
const SHELL_CANDIDATES = ["Bash", "shell_command", "exec_command"] as const;

/** Caller tools kept eager because Cursor uses them directly or through a native redirect. */
const CURSOR_HOT_PATH_TOOL_LEAVES = [
  "read",
  "bash",
  "grep",
  "glob",
  "shellcommand",
  "execcommand",
  "toolsearch",
] as const;

export function isCursorHotPathToolName(name: string): boolean {
  const leaf = toolLeafName(name).replace(/[_-]/g, "").toLowerCase();
  return (CURSOR_HOT_PATH_TOOL_LEAVES as readonly string[]).includes(leaf);
}

/** Caller tools a Cursor-native exec can be translated into. */
export function isCursorNativeRedirectToolName(name: string): boolean {
  const leaf = toolLeafName(name).replace(/[_-]/g, "").toLowerCase();
  return ["read", "grep", "glob", "bash", "shellcommand", "execcommand"].includes(leaf);
}

/** The redirect candidates of one request, in the shape every redirect decision reads. */
export function cursorNativeRedirectToolReferences(
  tools: readonly { readonly clientName: string; readonly toolName: string; readonly inputSchemaValue: Record<string, unknown> }[],
): CursorRedirectToolReference[] {
  return tools
    .filter((tool) => isCursorNativeRedirectToolName(tool.clientName))
    .map((tool) => ({
      clientName: tool.clientName,
      wireName: tool.toolName,
      inputSchemaValue: tool.inputSchemaValue,
    }));
}

/** Whether a native read has a caller Read it could be translated into. */
export function hasCursorNativeReadCandidate(tools: readonly CursorRedirectToolReference[]): boolean {
  return tools.some((tool) => (
    matchesLeaf(tool, READ_CANDIDATES) && firstSchemaProperty(tool.inputSchemaValue, ["file_path", "path"]) !== undefined
  ));
}

/**
 * How many lines the caller Read is asked for at least. Cursor's ReadSuccess needs the file's total
 * line count, which only the end of the file can prove, and the caller never reports it. A read that
 * fills the window proves nothing, so the window is asked for on every redirected read: when the
 * caller returns fewer lines than it was asked for, its last line number is the file's line count.
 */
export const CURSOR_NATIVE_READ_EOF_WINDOW = 500;

/** Where a redirected native read took its line range from. */
export type CursorNativeReadRangeSource = "exec" | "toolCallStarted";

export interface CursorNativeReadRangeDecision {
  /**
   * `exec` or `toolCallStarted` when a line range was established, otherwise why the read stays
   * on the fail-closed policy path. Payload-free: no path, offset, or limit value.
   */
  readonly outcome: CursorNativeReadRangeSource | "unranged" | "mismatch" | "started-offset" | "encoding-hint" | "invalid";
  /** Which range fields each source carried, e.g. `exec:none started:limit`. Payload-free. */
  readonly fields: string;
  readonly range?: {
    readonly source: CursorNativeReadRangeSource;
    /** First line the caller must return, counted from 1 like Cursor's own read executor. */
    readonly startLine: number;
    /** Caller `offset`, omitted when the read starts at the first line. */
    readonly offset?: number;
    readonly limit?: number;
  };
}

/**
 * Decide the line range of a Cursor-native read. A read with no range is never redirected:
 * redirecting path-only reads made the model re-send whole files over and over (#696), and a body
 * that cannot be shown complete sent it back to re-read (#1141); Claude Code may also cut such a
 * read and report the cut only outside the tool result. A ranged read is the exception because the
 * caller numbers every line it returns, so the answer can prove the range and say so with
 * `range_applied`, and its last number is the file's line count once it stops short of the window.
 *
 * cursor-agent applies a range only from the exec ReadArgs `offset` (#4, 1-based, 0 counting as 1,
 * negative meaning a tail) and `limit` (#5, 0 meaning no lines), so those win. The model's own
 * `readToolCall.args` on the matching `toolCallStarted` is used only for a limit with no offset:
 * cursor-agent's own UIs disagree on whether that offset counts from 0 or 1, and a limit alone does
 * not depend on it. A tail, a zero limit, or two sources that disagree stay fail-closed, since the
 * caller's Read cannot state them.
 */
export function cursorNativeReadRange(
  readArgs: Record<string, unknown>,
  started: Record<string, unknown> | undefined,
): CursorNativeReadRangeDecision {
  const execOffset = readRangeNumber(readArgs.offset);
  const execLimit = readRangeNumber(readArgs.limit);
  const startedOffset = started === undefined ? undefined : readRangeNumber(started.offset);
  const startedLimit = started === undefined ? undefined : readRangeNumber(started.limit);
  const fields = `exec:${readRangeShape(execOffset, execLimit)} started:${
    started === undefined ? "absent" : readRangeShape(startedOffset, startedLimit)
  }`;
  if ([execOffset, execLimit, startedOffset, startedLimit].some((value) => value === null)) {
    return { outcome: "invalid", fields };
  }
  // cursor-agent decodes the file with this encoding; the caller's Read has no way to ask for one.
  if (readArgs.encodingHint !== undefined && readArgs.encodingHint !== "") {
    return { outcome: "encoding-hint", fields };
  }
  let source: CursorNativeReadRangeSource;
  let offset: number | undefined;
  let limit: number | undefined;
  if (execOffset !== undefined || execLimit !== undefined) {
    if (started !== undefined && (startedOffset !== execOffset || startedLimit !== execLimit)) {
      return { outcome: "mismatch", fields };
    }
    source = "exec";
    offset = execOffset ?? undefined;
    limit = execLimit ?? undefined;
  } else if (startedOffset !== undefined) {
    return { outcome: "started-offset", fields };
  } else if (startedLimit !== undefined) {
    source = "toolCallStarted";
    limit = startedLimit ?? undefined;
  } else {
    return { outcome: "unranged", fields };
  }
  if ((offset !== undefined && offset < 0) || (limit !== undefined && limit <= 0)) {
    return { outcome: "invalid", fields };
  }
  const callerOffset = offset !== undefined && offset > 1 ? offset : undefined;
  if (callerOffset === undefined && limit === undefined) return { outcome: "unranged", fields };
  return {
    outcome: source,
    fields,
    range: {
      source,
      startLine: callerOffset ?? 1,
      ...(callerOffset === undefined ? {} : { offset: callerOffset }),
      ...(limit === undefined ? {} : { limit }),
    },
  };
}

/** A whole number, `undefined` when absent, or `null` when present but not a usable line count. */
function readRangeNumber(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function readRangeShape(offset: number | undefined | null, limit: number | undefined | null): string {
  if (offset !== undefined && limit !== undefined) return "offset+limit";
  if (offset !== undefined) return "offset";
  if (limit !== undefined) return "limit";
  return "none";
}

/**
 * Caller tools kept out of the advertised catalog because Cursor owns the capability.
 *
 * This is deliberately narrower than the redirect targets above. A shell tool is
 * withheld because Cursor's own shell is the same capability under another name, and
 * advertising both invites the model to pick one at random. `Grep` is not: the
 * redirect can only carry the subset of its schema the native shape can express and
 * fail-closes on the rest, so the caller's tool is the better route and the redirect
 * remains the fallback for a native call the model makes anyway.
 */
export function isCursorWithheldToolName(name: string): boolean {
  const leaf = toolLeafName(name).replace(/[_-]/g, "").toLowerCase();
  return ["bash", "shellcommand", "execcommand"].includes(leaf);
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
  /** `readToolCall.args` of the `toolCallStarted` whose call id matches this read, if seen. */
  readToolStarted?: Record<string, unknown>,
): CursorNativeExecRedirect | null {
  const messageId = numberValue(exec.id ?? 0);
  const execId = stringValue(exec.execId) || `redirect-${messageId}`;

  if (isRecord(exec.readArgs)) {
    const path = stringValue(exec.readArgs.path);
    if (!path) return null;
    const range = cursorNativeReadRange(exec.readArgs, readToolStarted).range;
    if (!range) return null;
    const callerLimit = Math.max(CURSOR_NATIVE_READ_EOF_WINDOW, range.limit ?? 0);
    const mapped = tools
      .filter((tool) => matchesLeaf(tool, READ_CANDIDATES))
      .map((tool) => ({ tool, args: readArguments(tool.inputSchemaValue, path, range.offset, callerLimit) }))
      .find((candidate) => candidate.args !== null);
    if (!mapped?.args) return null;
    return redirect(
      exec,
      mapped.tool,
      providerIdentifier,
      messageId,
      execId,
      "readArgs",
      "readResult",
      "read-direct",
      mapped.args,
      {
        path,
        startLine: String(range.startLine),
        ...(range.limit === undefined ? {} : { limit: String(range.limit) }),
        callerLimit: String(callerLimit),
      },
    );
  }

  if (isRecord(exec.grepArgs)) {
    const grepArgs = exec.grepArgs;
    const pattern = stringValue(grepArgs.pattern);
    // Cursor's own file-name search has no exec of its own: it arrives as a grep with no pattern,
    // only a glob, in files_with_matches mode. Rejecting it as a malformed grep left the model
    // with a native Glob that never ran and a retry list that did not name the caller's Glob.
    if (!pattern) return globRedirect(exec, grepArgs, tools, providerIdentifier, messageId, execId);
    // 공백만 있는 패턴은 유효한 내용 조건이라 Glob으로 넘기면 조건이 사라진다. 이전처럼 정책 응답으로 막는다.
    if (!pattern.trim()) return null;
    const path = stringValue(grepArgs.path) || ".";
    const glob = stringValue(grepArgs.glob);
    const outputMode = normalizedGrepOutputMode(stringValue(grepArgs.outputMode));
    if (!outputMode) return null;
    const sort = stringValue(grepArgs.sort) || undefined;
    if (sort && !["none", "path", "modified", "accessed", "created"].includes(sort)) return null;
    const numericOptions = [
      grepArgs.contextBefore,
      grepArgs.contextAfter,
      grepArgs.context,
      grepArgs.headLimit,
      grepArgs.offset,
    ];
    if (numericOptions.some((value) => typeof value === "number" && value < 0)) return null;
    const mappingInput: CursorGrepInput = {
      pattern,
      path,
      glob,
      outputMode,
      caseInsensitive: grepArgs.caseInsensitive === true,
      contextBefore: positiveNumber(grepArgs.contextBefore),
      contextAfter: positiveNumber(grepArgs.contextAfter),
      context: positiveNumber(grepArgs.context),
      type: stringValue(grepArgs.type) || undefined,
      headLimit: positiveNumber(grepArgs.headLimit),
      multiline: grepArgs.multiline === true,
      sort,
      sortAscending: Object.prototype.hasOwnProperty.call(grepArgs, "sortAscending")
        ? grepArgs.sortAscending === true
        : undefined,
      offset: positiveNumber(grepArgs.offset),
    };
    const mapped = tools
      .filter((tool) => matchesLeaf(tool, GREP_CANDIDATES))
      .map((tool) => ({ tool, args: grepArguments(tool, mappingInput) }))
      .find((candidate) => candidate.args !== null);
    const nativeArgs = {
      pattern,
      path,
      outputMode,
      ...(glob ? { glob } : {}),
      ...(positiveNumber(grepArgs.offset) === undefined
        ? {}
        : { offset: String(positiveNumber(grepArgs.offset)) }),
    };
    if (mapped?.args) {
      return redirect(
        exec,
        mapped.tool,
        providerIdentifier,
        messageId,
        execId,
        "grepArgs",
        "grepResult",
        "grep-direct",
        mapped.args,
        nativeArgs,
      );
    }
    const shell = tools
      .filter((tool) => matchesLeaf(tool, SHELL_CANDIDATES))
      .map((tool) => ({
        tool,
        args: grepShellArguments(tool.inputSchemaValue, mappingInput),
      }))
      .find((candidate) => candidate.args !== null);
    if (!shell?.args) return null;
    return redirect(
      exec,
      shell.tool,
      providerIdentifier,
      messageId,
      execId,
      "grepArgs",
      "grepShellResult",
      "grep-shell",
      shell.args,
      nativeArgs,
    );
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

/**
 * Map a pattern-less, glob-only native grep onto the caller's Glob. A relative glob is passed
 * verbatim: Cursor has already prefixed the model's `glob_pattern` with a recursive `**` segment,
 * and a caller Glob rooted at the same path matches that pattern the same way. Any other grep option
 * means the request is not a plain file-name search, so it stays on the fail-closed policy path.
 */
function globRedirect(
  exec: ExecMessage,
  grepArgs: ExecMessage,
  tools: readonly CursorRedirectToolReference[],
  providerIdentifier: string,
  messageId: number,
  execId: string,
): CursorNativeExecRedirect | null {
  const glob = stringValue(grepArgs.glob);
  if (!glob.trim()) return null;
  if (normalizedGrepOutputMode(stringValue(grepArgs.outputMode)) !== "files_with_matches") return null;
  if (
    stringValue(grepArgs.type)
    || stringValue(grepArgs.sort)
    || grepArgs.caseInsensitive === true
    || grepArgs.multiline === true
    || [
      grepArgs.contextBefore,
      grepArgs.contextAfter,
      grepArgs.context,
      grepArgs.headLimit,
      grepArgs.offset,
    ].some((value) => typeof value === "number" && value !== 0)
  ) {
    return null;
  }
  const path = stringValue(grepArgs.path) || ".";
  const tool = tools.find((candidate) => (
    matchesLeaf(candidate, GLOB_CANDIDATES)
    && schemaHasProperty(candidate.inputSchemaValue, "pattern")
    && (path === "." || schemaHasProperty(candidate.inputSchemaValue, "path"))
  ));
  if (!tool) return null;
  return redirect(
    exec,
    tool,
    providerIdentifier,
    messageId,
    execId,
    "grepArgs",
    "grepResult",
    "glob-direct",
    { pattern: callerGlobPattern(glob, path), ...(path === "." ? {} : { path }) },
    { pattern: "", path, outputMode: "files_with_matches", glob },
  );
}

/**
 * Cursor prefixes even an absolute `glob_pattern` with its recursive segment, turning
 * `/repo/src/*.ts` searched under `/repo` into `**` + `/repo/src/*.ts`, which matches nothing
 * there, so an existing file came back as an empty result. When the absolute part lies inside
 * the absolute search path, hand the caller the pattern relative to that path instead.
 */
function callerGlobPattern(glob: string, path: string): string {
  if (!glob.startsWith("**/") || !path.startsWith("/")) return glob;
  const absolute = glob.slice(2);
  const root = path.endsWith("/") ? path : `${path}/`;
  return absolute.startsWith(root) && absolute.length > root.length
    ? absolute.slice(root.length)
    : glob;
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
      // Only ranged reads are redirected, and the caller is asked for a window past the request.
      // Claude Code 2.1.292 answers a ranged read with exactly the lines asked for or with an
      // error; it cuts only an unranged read. When the numbered lines stop short of the window
      // the caller has reached the end of the file, and its last number is the file's line count,
      // the one thing Cursor's ReadSuccess needs and the caller never reports. The file size never
      // reaches the gateway and is left unset rather than invented. Anything that does not prove
      // the end keeps the caller's output and claims no success.
      const verdict = judgeCallerRead(args, output);
      return [execReply(exec, "readResult", verdict.outcome === "proven"
        ? {
          success: {
            path: args.path ?? "",
            content: verdict.content,
            totalLines: verdict.totalLines,
            truncated: false,
            rangeApplied: true,
          },
        }
        : { error: { path: args.path ?? "", error: verdict.error } })];
    }
    case "grepShellResult": {
      const receipt = parseGrepShellReceipt(output, args.outputMode ?? "content");
      return [execReply(exec, "grepResult", receipt.ok
        ? { success: buildGrepReceiptSuccess(args, receipt) }
        : { error: { error: receipt.error } })];
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
    case "grepShellResult":
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
  limit: number,
): Record<string, unknown> | null {
  const pathKey = firstSchemaProperty(schema, ["file_path", "path"]);
  if (!pathKey) return null;
  const args: Record<string, unknown> = { [pathKey]: path };
  if (offset !== undefined) {
    if (!schemaHasProperty(schema, "offset")) return null;
    args.offset = offset;
  }
  if (!schemaHasProperty(schema, "limit")) return null;
  args.limit = limit;
  return args;
}

/**
 * The numbered lines of a caller Read, or why its output is not one listing. Claude Code numbers
 * every line `N<TAB>` (`N:` when its tab-aware separator is on), shows the empty line after a final
 * newline as a bare `N<TAB>`, and answers an offset past the end, an empty file, or a cap with a
 * notice instead of numbered lines. A ranged read is never cut short silently, so consecutive
 * numbers from the requested start, no more lines than were asked for, and nothing else make it a
 * listing whose last number is trustworthy.
 */
function callerReadRange(
  output: string,
  startLine: number,
  limit: number,
): { readonly ok: true; readonly lines: readonly string[] } | { readonly ok: false; readonly reason: string } {
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  // Every listed line starts with its number, so a blank line around the listing is the caller's.
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
  if (lines.length === 0) return { ok: false, reason: "it is not a numbered line listing" };
  const content: string[] = [];
  for (const [index, line] of lines.entries()) {
    const numbered = /^(\d+)(?:[\t:]([\s\S]*))?$/.exec(line);
    // Only the last line may lose its separator: a caller that trims its tail turns `41<TAB>` into `41`.
    if (!numbered || (numbered[2] === undefined && index !== lines.length - 1)) {
      return { ok: false, reason: "it is not a numbered line listing" };
    }
    if (Number(numbered[1]) !== startLine + index) {
      return { ok: false, reason: `its lines are not numbered from line ${startLine}` };
    }
    content.push(numbered[2] ?? "");
  }
  if (content.length > limit) {
    return { ok: false, reason: `it has more than ${limit} lines` };
  }
  return { ok: true, lines: content };
}

export type CursorNativeReadEofOutcome = "proven" | "window" | "not-listing" | "caller-error";

type CursorNativeReadVerdict =
  | { readonly outcome: "proven"; readonly content: string; readonly totalLines: number }
  | { readonly outcome: "window" | "not-listing"; readonly error: string };

/**
 * Judge the caller Read of a redirected native read. Cursor needs the file's total line count, and
 * the caller reports none, so success is claimed only when the caller returned fewer lines than it
 * was asked for: it then reached the end of the file, and its last line number is the count. Nothing
 * is estimated and the file is never opened here.
 */
function judgeCallerRead(args: Readonly<Record<string, string>>, output: string): CursorNativeReadVerdict {
  const startLine = Number(args.startLine);
  const callerLimit = Number(args.callerLimit);
  const limit = args.limit === undefined ? undefined : Number(args.limit);
  const notListing = (reason: string): CursorNativeReadVerdict => ({
    outcome: "not-listing",
    error: `The caller Read tool completed, but Fleet cannot show that its output is the requested line range because ${reason}. Use the caller Read tool for authoritative paging. Caller output:\n${output}`,
  });
  if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(callerLimit) || callerLimit < 1) {
    return notListing("no line range was requested");
  }
  const parsed = callerReadRange(output, startLine, callerLimit);
  if (!parsed.ok) return notListing(parsed.reason);
  if (parsed.lines.length >= callerLimit) {
    return {
      outcome: "window",
      error: `The caller Read tool completed, but Fleet cannot confirm the end of the file within ${callerLimit} lines from line ${startLine}, so it cannot report the file's total line count. Use the caller Read tool for authoritative paging. Caller output:\n${output}`,
    };
  }
  const requested = limit === undefined || !Number.isSafeInteger(limit) ? parsed.lines : parsed.lines.slice(0, limit);
  return {
    outcome: "proven",
    content: requested.join("\n"),
    totalLines: startLine + parsed.lines.length - 1,
  };
}

/** What the caller Read of a redirected native read proved. Payload-free, for diagnostics. */
export function cursorNativeReadEofOutcome(
  correlation: { readonly nativeArgs?: Readonly<Record<string, string>> },
  output: string,
  isError: boolean,
): CursorNativeReadEofOutcome {
  return isError ? "caller-error" : judgeCallerRead(correlation.nativeArgs ?? {}, output).outcome;
}

function grepArguments(
  tool: CursorRedirectToolReference,
  input: CursorGrepInput,
): Record<string, unknown> | null {
  const leaf = normalizedLeaf(tool.clientName);
  if (leaf === "grep") {
    if (!schemaHasProperty(tool.inputSchemaValue, "pattern")) return null;
    const args: Record<string, unknown> = { pattern: input.pattern };
    if (input.path !== ".") {
      if (!schemaHasProperty(tool.inputSchemaValue, "path")) return null;
      args.path = input.path;
    }
    // Each option is looked up by candidate rather than by one fixed name. Claude Code
    // spells its ripgrep switches as the flags themselves — `-i`, `-B`, `-A` — while a
    // caller that models the same options as words spells them out; both are a `Grep`
    // that can express the operation. Naming only one shape meant every case-insensitive
    // or context-carrying native search fail-closed to the shell path below, which was
    // measured against the client's real schema, not inferred.
    const optionMappings: ReadonlyArray<readonly [unknown, readonly string[]]> = [
      [input.glob || undefined, ["glob"]],
      [input.outputMode, ["output_mode"]],
      [input.caseInsensitive ? true : undefined, ["-i", "case_insensitive"]],
      [input.contextBefore, ["-B", "context_before"]],
      [input.contextAfter, ["-A", "context_after"]],
      [input.context, ["context", "-C"]],
      [input.type, ["type"]],
      [input.headLimit, ["head_limit"]],
      [input.multiline ? true : undefined, ["multiline"]],
      [input.sort, ["sort"]],
      [input.sortAscending, ["sort_ascending"]],
      [input.offset, ["offset"]],
    ];
    for (const [value, candidates] of optionMappings) {
      if (value === undefined) continue;
      const key = firstSchemaProperty(tool.inputSchemaValue, candidates);
      // No spelling of this option exists on the caller's tool, so the redirect cannot
      // state what the model asked for. Fail closed and let the shell path try.
      if (key === undefined) return null;
      args[key] = value;
    }
    return args;
  }
  return null;
}

const GREP_SHELL_BYTE_LIMIT = 12 * 1024;
const GREP_SHELL_MAX_COLUMNS = 2000;
const GREP_SHELL_COLUMN_SUFFIX = " [... omitted end of long line]";
// A UTF-8 sequence cut by the byte cap decodes to U+FFFD, which shifts the received size by a few bytes.
const GREP_SHELL_BYTE_SLACK = 3;

function grepShellArguments(
  schema: Record<string, unknown>,
  input: CursorGrepInput,
): Record<string, unknown> | null {
  if (
    input.outputMode !== "content"
    || input.headLimit !== undefined
    || input.offset !== undefined
    || input.multiline
    || input.sort !== undefined
  ) {
    return null;
  }
  const pattern = posixSingleQuote(input.pattern);
  const path = posixSingleQuote(input.path);
  const glob = input.glob ? posixSingleQuote(input.glob) : undefined;
  const type = input.type ? posixSingleQuote(input.type) : undefined;
  if (!pattern || !path || (input.glob && !glob) || (input.type && !type)) return null;
  const flags = [
    input.caseInsensitive ? "--ignore-case" : undefined,
    glob ? `--glob ${glob}` : undefined,
    type ? `--type ${type}` : undefined,
    input.contextBefore !== undefined ? `-B ${input.contextBefore}` : undefined,
    input.contextAfter !== undefined ? `-A ${input.contextAfter}` : undefined,
    input.context !== undefined ? `-C ${input.context}` : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  // The chat summary is the first 160 characters, so rg and the pattern stay in front.
  // Bash, shell_command, and exec_command do not identify their shell. This text is POSIX
  // sh. A PowerShell host cannot be distinguished from those schemas; it fails closed
  // because this trailer never arrives. rg's own heading is passed through: a file name is
  // the first line or the line after a blank line, and the gateway counts the lines.
  const search = [
    "rg -n -H --heading --color=never",
    `--regexp ${pattern}`,
    "--sort=path",
    `--max-columns=${GREP_SHELL_MAX_COLUMNS}`,
    "--max-columns-preview",
    ...flags,
    `-- ${path}`,
  ].join(" ");
  const command = `${search} >"\${TMPDIR:-/tmp}/g$$.o" 2>"\${TMPDIR:-/tmp}/g$$.e"; rc=$?; o="\${TMPDIR:-/tmp}/g$$.o"; e="\${TMPDIR:-/tmp}/g$$.e"; if [ "$rc" -gt 1 ]; then m=$(tr '\\n' ' ' <"$e" | cut -c1-300); printf 'fleet-grep status=error rc=%s message=%s\\n' "$rc" "$m"; else b=$(wc -c <"$o" | tr -d '[:space:]'); head -c ${GREP_SHELL_BYTE_LIMIT} "$o"; printf '\\nfleet-grep status=ok rc=%s bytes=%s\\n' "$rc" "$b"; fi; rm -f "$o" "$e"`;
  return shellArguments(schema, command, undefined, undefined);
}

function posixSingleQuote(value: string): string | null {
  if (/[\0\r\n]/.test(value)) return null;
  return `'${value.replaceAll("'", "'\\''")}'`;
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
    if (cwdKey) {
      args[cwdKey] = cwd;
    } else {
      // Cursor's shell always names a working directory and Claude Code's Bash has no field for
      // it. Failing closed here sent every first shell command through a rejected native call
      // and a ToolSearch for Bash, which then advertised a second shell for the rest of the
      // session. State the directory in the command instead. `|| exit` rather than `&&` keeps a
      // failed `cd` from running any part of a multi-line, `||`, or `&` command elsewhere, and
      // the subshell keeps the caller's own working directory unchanged.
      const directory = posixSingleQuote(cwd);
      if (!directory) return null;
      args[commandKey] = `( cd -- ${directory} || exit\n${command}\n)`;
    }
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

interface GrepShellReceipt {
  readonly ok: true;
  readonly matches: readonly {
    readonly file: string;
    readonly lineNumber: number;
    readonly content: string;
    readonly contentTruncated: boolean;
    readonly isContextLine: boolean;
  }[];
  readonly totalFiles: number;
  readonly totalLines: number;
  readonly totalMatchedLines: number;
  readonly clientTruncated: boolean;
}

function parseGrepShellReceipt(
  output: string,
  expectedOutputMode: string,
): GrepShellReceipt | { readonly ok: false; readonly error: string } {
  if (expectedOutputMode !== "content") {
    return { ok: false, error: "The caller Bash result did not contain a complete Fleet Grep receipt." };
  }
  const split = splitGrepShellTrailer(output);
  if (!split?.trailer.startsWith("fleet-grep ")) {
    return { ok: false, error: "The caller Bash result did not contain a complete Fleet Grep receipt." };
  }
  const errorTrailer = /^fleet-grep status=error rc=(\d+) message=(.*)$/.exec(split.trailer);
  if (errorTrailer) {
    const message = errorTrailer[2]?.trim() || `rg failed with exit ${errorTrailer[1]}`;
    return { ok: false, error: message };
  }
  const okTrailer = /^fleet-grep status=ok rc=(\d+) bytes=(\d+)$/.exec(split.trailer);
  const exitCode = Number(okTrailer?.[1]);
  const originalBytes = Number(okTrailer?.[2]);
  if (
    !okTrailer
    || (exitCode !== 0 && exitCode !== 1)
    || !Number.isSafeInteger(originalBytes)
    || originalBytes < 0
  ) {
    return { ok: false, error: "The caller Bash result did not contain a complete Fleet Grep receipt." };
  }
  const clientTruncated = originalBytes > GREP_SHELL_BYTE_LIMIT;
  try {
    assertGrepShellByteCap(split.transmitted, originalBytes, clientTruncated);
    const parsed = parseGrepShellBody(grepShellBodyLines(split.transmitted, clientTruncated));
    return {
      ok: true,
      matches: parsed.matches,
      totalFiles: parsed.totalFiles,
      totalLines: parsed.totalLines,
      totalMatchedLines: parsed.totalMatchedLines,
      clientTruncated,
    };
  } catch (error) {
    return {
      ok: false,
      error: `The caller Bash result contained an invalid Fleet Grep receipt: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function splitGrepShellTrailer(
  output: string,
): { readonly transmitted: string; readonly trailer: string } | null {
  // A caller may trim what follows the trailer. Nothing after it belongs to the search, and the
  // body is left byte-for-byte as received so its size can be compared with the shell's count.
  const trimmed = output.replace(/\s+$/, "");
  const splitAt = trimmed.lastIndexOf("\n");
  return splitAt < 0
    ? { transmitted: "", trailer: trimmed }
    : { transmitted: trimmed.slice(0, splitAt), trailer: trimmed.slice(splitAt + 1) };
}

function assertGrepShellByteCap(
  transmitted: string,
  originalBytes: number,
  clientTruncated: boolean,
): void {
  const actual = Buffer.byteLength(transmitted, "utf8");
  if (!clientTruncated) {
    if (actual !== originalBytes) throw new Error("receipt bytes do not match the search output");
    return;
  }
  // head -c can cut a UTF-8 character; the caller then decodes the stub to U+FFFD, so the
  // received size may sit a few bytes either side of the limit.
  if (Math.abs(actual - GREP_SHELL_BYTE_LIMIT) > GREP_SHELL_BYTE_SLACK) {
    throw new Error("search output was cut before the trailer");
  }
}

function grepShellBodyLines(transmitted: string, clientTruncated: boolean): readonly string[] {
  const endsWithNewline = transmitted.endsWith("\n");
  const text = endsWithNewline ? transmitted.slice(0, -1) : transmitted;
  if (text.length === 0) return [];
  const lines = text.split("\n");
  // head -c can end inside a line. That partial line is not a result.
  if (clientTruncated && !endsWithNewline) lines.pop();
  return lines;
}

function parseGrepShellBody(lines: readonly string[]): {
  readonly matches: GrepShellReceipt["matches"];
  readonly totalFiles: number;
  readonly totalLines: number;
  readonly totalMatchedLines: number;
} {
  const matches: Array<GrepShellReceipt["matches"][number]> = [];
  let currentFile: string | undefined;
  let expectingFile = true;
  let totalFiles = 0;
  let totalLines = 0;
  let totalMatchedLines = 0;
  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.length === 0) {
      if (expectingFile) throw new Error("ambiguous search line");
      expectingFile = true;
      currentFile = undefined;
      continue;
    }
    if (expectingFile) {
      currentFile = line;
      totalFiles += 1;
      expectingFile = false;
      continue;
    }
    if (line === "--") continue;
    if (currentFile === undefined) throw new Error("search line has no file");
    const numbered = parseGrepShellNumberedLine(line);
    if (!numbered) throw new Error("ambiguous search line");
    matches.push({ file: currentFile, ...numbered });
    totalLines += 1;
    if (!numbered.isContextLine) totalMatchedLines += 1;
  }
  return { matches, totalFiles, totalLines, totalMatchedLines };
}

function parseGrepShellNumberedLine(line: string): {
  readonly lineNumber: number;
  readonly content: string;
  readonly contentTruncated: boolean;
  readonly isContextLine: boolean;
} | null {
  const match = /^(\d+):(.*)$/.exec(line);
  const context = match ? null : /^(\d+)-(.*)$/.exec(line);
  const parsed = match ?? context;
  if (!parsed?.[1]) return null;
  const lineNumber = Number(parsed[1]);
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) return null;
  let content = parsed[2] ?? "";
  const contentTruncated = content.endsWith(GREP_SHELL_COLUMN_SUFFIX);
  if (contentTruncated) content = content.slice(0, -GREP_SHELL_COLUMN_SUFFIX.length);
  return {
    lineNumber,
    content,
    contentTruncated,
    isContextLine: context !== null,
  };
}

function buildGrepReceiptSuccess(
  args: Readonly<Record<string, string>>,
  receipt: GrepShellReceipt,
): Record<string, unknown> {
  const path = args.path || ".";
  const byFile = new Map<string, Array<Record<string, unknown>>>();
  for (const match of receipt.matches) {
    const entries = byFile.get(match.file) ?? [];
    entries.push({
      lineNumber: match.lineNumber,
      content: match.content,
      contentTruncated: match.contentTruncated,
      isContextLine: match.isContextLine,
    });
    byFile.set(match.file, entries);
  }
  // Retained lines only. clientTruncated means the byte cap hid the rest, so these
  // totals are a lower bound and must not be read as the whole search.
  return {
    pattern: args.pattern ?? "",
    path,
    outputMode: "content",
    workspaceResults: {
      [path]: {
        content: {
          matches: [...byFile].map(([file, fileMatches]) => ({ file, matches: fileMatches })),
          totalLines: receipt.totalLines,
          totalMatchedLines: receipt.totalMatchedLines,
          clientTruncated: receipt.clientTruncated,
          ripgrepTruncated: false,
        },
      },
    },
  };
}

function buildGrepSuccess(
  args: Readonly<Record<string, string>>,
  output: string,
): Record<string, unknown> {
  const outputMode = normalizedGrepOutputMode(args.outputMode) ?? "content";
  const path = args.path || ".";
  let result: Record<string, unknown>;
  if (outputMode === "files_with_matches") {
    const listing = !args.pattern && Boolean(args.glob)
      ? callerGlobFiles(output)
      : callerGrepFiles(output);
    result = {
      files: {
        files: listing.files,
        totalFiles: listing.files.length,
        clientTruncated: listing.truncated,
        ripgrepTruncated: false,
        ...(args.offset === undefined ? {} : { offsetApplied: Number(args.offset) }),
      },
    };
  } else if (outputMode === "count") {
    const noticed = splitCallerTailNotice(callerRawLines(output), COUNT_TOTAL_NOTICE);
    const counts = noticed.body.flatMap((line) => {
      const parsed = parseCallerCountLine(line);
      return parsed ? [parsed] : [];
    });
    result = {
      count: {
        counts,
        totalFiles: counts.length,
        totalMatches: counts.reduce((sum, entry) => sum + entry.count, 0),
        clientTruncated: noticed.limited && counts.length > 0,
        ripgrepTruncated: false,
        ...(args.offset === undefined ? {} : { offsetApplied: Number(args.offset) }),
      },
    };
  } else {
    const noticed = splitCallerTailNotice(callerRawLines(output), CONTENT_PAGINATION_NOTICE);
    const byFile = new Map<string, Array<Record<string, unknown>>>();
    let totalMatchedLines = 0;
    for (const line of noticed.body) {
      const parsed = parseCallerContentLine(line);
      if (!parsed) continue;
      const entries = byFile.get(parsed.file) ?? [];
      entries.push({
        lineNumber: parsed.lineNumber,
        content: parsed.content,
        contentTruncated: false,
        isContextLine: parsed.isContextLine,
      });
      byFile.set(parsed.file, entries);
      if (!parsed.isContextLine) totalMatchedLines += 1;
    }
    const matches = [...byFile].map(([file, fileMatches]) => ({ file, matches: fileMatches }));
    result = {
      content: {
        matches,
        totalLines: matches.reduce((sum, entry) => sum + entry.matches.length, 0),
        totalMatchedLines,
        clientTruncated: noticed.limited && matches.length > 0,
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

/** Caller content and count lines. Only a leftover carriage return is removed. */
function callerRawLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function isCallerBlankLine(line: string): boolean {
  return line.trim().length === 0;
}

// Claude Code 2.1.292 appends these after a blank line, and only as the tail of the tool result.
// Content: `\n\n[Showing results with pagination = …]`. Count: `\n\nFound N total …` with
// ` with pagination = …` on that same line when the page was cut. A real row can carry the same
// words; they count as a notice only in this tail position.
const CONTENT_PAGINATION_NOTICE = /^\[Showing results with pagination = [^\]\n]*\]$/;
const COUNT_TOTAL_NOTICE = /^Found \d+ total occurrences? across \d+ files?\.(?: with pagination = .+)?$/;

interface CallerTail {
  readonly body: readonly string[];
  readonly limited: boolean;
}

/** Drops a tail notice separated from the body by a blank line. Anywhere else, the line stays. */
function splitCallerTailNotice(lines: readonly string[], notice: RegExp): CallerTail {
  let end = lines.length;
  while (end > 0 && isCallerBlankLine(lines[end - 1] ?? "")) end -= 1;
  if (end === 0) return { body: [], limited: false };
  const tail = (lines[end - 1] ?? "").trimEnd();
  let bodyEnd = end - 1;
  while (bodyEnd > 0 && isCallerBlankLine(lines[bodyEnd - 1] ?? "")) bodyEnd -= 1;
  if (bodyEnd === end - 1 || !notice.test(tail)) return { body: lines.slice(0, end), limited: false };
  // Claude Code prints `limit: N` only when more results remain past the page. An offset-only
  // tail (`pagination = offset: N`) still has rows, and those rows are the whole returned page.
  return { body: lines.slice(0, bodyEnd), limited: / limit: \d+/.test(tail) };
}

function parseCallerCountLine(line: string): { file: string; count: number } | null {
  if (isCallerBlankLine(line)) return null;
  const separator = line.lastIndexOf(":");
  if (separator < 1) return null;
  const countText = line.slice(separator + 1).trimEnd();
  if (!/^\d+$/.test(countText)) return null;
  return { file: line.slice(0, separator), count: Number(countText) };
}

/**
 * One content row: `path:line:text`, or a context row `path-line-text`. Claude Code 2.1.292
 * numbers Grep lines by default and this redirect does not forward `-n`, so an unnumbered
 * `path:text` row is not produced here. Names and text keep trailing spaces and Unicode form.
 */
function parseCallerContentLine(line: string): {
  readonly file: string;
  readonly lineNumber: number;
  readonly content: string;
  readonly isContextLine: boolean;
} | null {
  if (isCallerBlankLine(line)) return null;
  const matched = /^(.+?):(\d+):\s?(.*)$/.exec(line);
  const context = matched ? null : /^(.+?)-(\d+)-\s?(.*)$/.exec(line);
  const parsed = matched ?? context;
  if (!parsed?.[1] || !parsed[2] || parsed[3] === undefined) return null;
  const lineNumber = Number(parsed[2]);
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) return null;
  return {
    file: parsed[1],
    lineNumber,
    content: parsed[3],
    isContextLine: context !== null,
  };
}

interface CallerFileListing {
  readonly files: readonly string[];
  readonly truncated: boolean;
}

// Shapes Claude Code's Grep and Glob emit around a file list, measured on 2.1.292. A caller
// path is printed relative to its cwd, so a real file can be named exactly like any of these
// lines ("Found 3 files", "No files found"); they are recognised only by where they sit in the
// output or by matching the whole output, never by a line's leading text.
const GREP_FILES_HEADER = /^Found \d+ files?(?: (?:limit: \d+(?:, offset: \d+)?|offset: \d+))?$/;
const GREP_OFFSET_PAST_END = /^No entries at this offset\. \[Showing results with pagination = [^\]\n]*\]$/;
const NO_FILES_FOUND = "No files found";
const GLOB_TRUNCATION_NOTICES = [
  /^\(Results are truncated\. Consider using a more specific path or pattern\.\)$/,
  /^\(Showing \d+ of \d+ matching files; \d+ more are not listed\. Narrow the pattern or path to see the rest\.\)$/,
  /^\(Showing the first \d+ files; there are more than \d+ matches\. Narrow the pattern or path to see the rest\.\)$/,
];
// An oversized result is replaced by one of these wrappers; a persisted one carries a preview
// of the original output.
const OVERSIZE_WRAPPERS: ReadonlyMap<string, string> = new Map([
  ["<persisted-output>", "</persisted-output>"],
  ["<truncated-output>", "</truncated-output>"],
]);
// The notice line 2.1.292 puts under the opening tag: "Output too large (…). Full output saved
// to: …", "Output exceeded the … persist limit; …", or "Output too large (…). It could not be saved, …".
const OVERSIZE_NOTICE = /^Output (?:too large \(|exceeded the )/;
// Claude Code 2.1.292 cuts that preview at 2000 UTF-16 units, backing off to the last newline
// when it lies past unit 1000: shorter previews end on a whole line, full-length ones may not.
const OVERSIZE_PREVIEW_LIMIT = 2000;

/**
 * Non-blank lines of a caller's file list. A name keeps every character but a CRLF's carriage
 * return, trailing whitespace included; only the shape tests trim.
 */
function callerListingLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line) => line.trim().length > 0);
}

/** Grep `files_with_matches`: `Found N files[ limit/offset]` heads a non-empty list. */
function callerGrepFiles(output: string): CallerFileListing {
  const lines = callerListingLines(output);
  const whole = lines.map((line) => line.trimEnd()).join("\n");
  if (whole === NO_FILES_FOUND || GREP_OFFSET_PAST_END.test(whole)) return { files: [], truncated: false };
  const preview = oversizePreviewLines(output, lines);
  if (preview !== undefined) {
    if (!GREP_FILES_HEADER.test(preview[0]?.trimEnd() ?? "")) return { files: [], truncated: true };
    return { files: preview.slice(1), truncated: true };
  }
  const header = lines[0]?.trimEnd() ?? "";
  if (!GREP_FILES_HEADER.test(header)) return { files: lines, truncated: false };
  // Claude Code prints `limit: N` only when more results remain past the page.
  return { files: lines.slice(1), truncated: / limit: \d+/.test(header) };
}

/**
 * The whole lines of the preview an oversize wrapper carries — the only usable part of it, and
 * a partial list — or undefined when the output is not wrapped.
 */
function oversizePreviewLines(output: string, lines: readonly string[]): string[] | undefined {
  const closing = OVERSIZE_WRAPPERS.get(lines[0]?.trimEnd() ?? "");
  if (closing === undefined || lines.at(-1)?.trimEnd() !== closing) return undefined;
  // Real files can carry the tag names; the caller's notice line under the tag cannot be a path.
  if (!OVERSIZE_NOTICE.test(lines[1]?.trimEnd() ?? "")) return undefined;
  const preview = oversizePreview(output) ?? "";
  const previewLines = callerListingLines(preview);
  // A preview shorter than the limit ended at a newline; one that fills it may end mid-name.
  return preview.length < OVERSIZE_PREVIEW_LIMIT ? previewLines : previewLines.slice(0, -1);
}

/**
 * The preview text inside an oversize wrapper, exactly as the caller cut it: between the
 * `Preview (first …):` line and the closing tag, minus the `...` marker. Measured on the
 * LF-normalised output, because its length is what tells a newline cut from a hard cut.
 */
function oversizePreview(output: string): string | undefined {
  const text = output.replace(/\r\n/g, "\n");
  const start = /^Preview \(first [^\n]*\):[ \t]*\n/m.exec(text);
  if (!start) return undefined;
  const rest = text.slice(start.index + start[0].length);
  const end = /\n(?:\.\.\.[ \t]*\n)?[ \t]*<\/(?:persisted|truncated)-output>\s*$/.exec(rest);
  return end ? rest.slice(0, end.index) : undefined;
}

/** Glob: a bare list, with a truncation notice as its last line when it was cut. */
function callerGlobFiles(output: string): CallerFileListing {
  const lines = callerListingLines(output);
  if (lines.map((line) => line.trimEnd()).join("\n") === NO_FILES_FOUND) return { files: [], truncated: false };
  const preview = oversizePreviewLines(output, lines);
  const listed = preview ?? lines;
  const last = listed.at(-1)?.trimEnd() ?? "";
  if (GLOB_TRUNCATION_NOTICES.some((notice) => notice.test(last))) {
    return { files: listed.slice(0, -1), truncated: true };
  }
  return { files: listed, truncated: preview !== undefined };
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
