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
  return ["grep", "glob", "bash", "shellcommand", "execcommand"].includes(leaf);
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
): CursorNativeExecRedirect | null {
  const messageId = numberValue(exec.id ?? 0);
  const execId = stringValue(exec.execId) || `redirect-${messageId}`;

  if (isRecord(exec.readArgs)) {
    const path = stringValue(exec.readArgs.path);
    if (!path) return null;
    if ([exec.readArgs.offset, exec.readArgs.limit].some((value) => (
      typeof value === "number" && value < 0
    ))) return null;
    const offset = positiveNumber(exec.readArgs.offset);
    const limit = positiveNumber(exec.readArgs.limit);
    if (offset !== undefined || limit !== undefined) return null;
    const mapped = tools
      .filter((tool) => matchesLeaf(tool, READ_CANDIDATES))
      .map((tool) => ({ tool, args: readArguments(tool.inputSchemaValue, path) }))
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
      { path },
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
      // Claude Code keeps truncation metadata in a transcript-only attachment that is absent from
      // the Anthropic request. Preserve caller execution and same-Run continuation, but never claim
      // partial text is a complete Cursor ReadSuccess with invented whole-file metadata.
      return [execReply(exec, "readResult", {
        error: {
          path: args.path ?? "",
          error: `The caller Read tool completed, but Fleet cannot verify whether this text is the complete file. Use the caller Read tool for authoritative paging. Caller output:\n${output}`,
        },
      })];
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
): Record<string, unknown> | null {
  const pathKey = firstSchemaProperty(schema, ["file_path", "path"]);
  return pathKey ? { [pathKey]: path } : null;
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
  const globOnly = !args.pattern && Boolean(args.glob);
  let globTruncated = false;
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !line.startsWith("[") && !/^no matches/i.test(line))
    .filter((line) => {
      if (!globOnly) return true;
      // The caller's Glob reports an empty search and a cut-off list in prose, not as paths.
      if (/^no files found\b/i.test(line)) return false;
      if (/^\(results are truncated\b/i.test(line)) {
        globTruncated = true;
        return false;
      }
      return true;
    });
  const path = args.path || ".";
  let result: Record<string, unknown>;
  if (outputMode === "files_with_matches") {
    result = {
      files: {
        files: lines,
        totalFiles: lines.length,
        clientTruncated: globTruncated,
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
