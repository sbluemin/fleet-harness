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
  readonly adapter: "read-direct" | "grep-direct" | "grep-shell" | "shell-direct";
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
    const optionMappings: ReadonlyArray<readonly [unknown, string]> = [
      [input.glob || undefined, "glob"],
      [input.outputMode, "output_mode"],
      [input.caseInsensitive ? true : undefined, "case_insensitive"],
      [input.contextBefore, "context_before"],
      [input.contextAfter, "context_after"],
      [input.context, "context"],
      [input.type, "type"],
      [input.headLimit, "head_limit"],
      [input.multiline ? true : undefined, "multiline"],
      [input.sort, "sort"],
      [input.sortAscending, "sort_ascending"],
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
  const script = Buffer.from(CURSOR_GREP_RECEIPT_SCRIPT, "utf8").toString("base64url");
  const payload = Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
  const bootstrap = `eval(Buffer.from(process.argv.splice(1,1)[0],'base64url').toString('utf8'))`;
  const command = `node -e "${bootstrap}" ${script} ${payload}`;
  return shellArguments(schema, command, undefined, undefined);
}

const CURSOR_GREP_RECEIPT_PREFIX = "FLEET_CURSOR_GREP_V1:";
const CURSOR_GREP_RECEIPT_SCRIPT = String.raw`
const {spawn}=require("node:child_process");
const {createInterface}=require("node:readline");
const emit=(value)=>process.stdout.write("${CURSOR_GREP_RECEIPT_PREFIX}"+Buffer.from(JSON.stringify(value)).toString("base64url"));
(async()=>{try {
  const input=JSON.parse(Buffer.from(process.argv[1],"base64url").toString("utf8"));
  const args=["--json","--color=never","--line-number"];
  if(input.caseInsensitive)args.push("--ignore-case");
  if(input.glob)args.push("--glob",input.glob);
  if(input.type)args.push("--type",input.type);
  if(input.contextBefore)args.push("--before-context",String(input.contextBefore));
  if(input.contextAfter)args.push("--after-context",String(input.contextAfter));
  if(input.context)args.push("--context",String(input.context));
  args.push("--regexp",input.pattern,"--",input.path);
  const child=spawn("rg",args,{stdio:["ignore","pipe","pipe"]});
  let stderr="";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data",(chunk)=>{if(stderr.length<16384)stderr+=chunk.slice(0,16384-stderr.length);});
  const completion=new Promise((resolve,reject)=>{
    child.once("error",reject);
    child.once("close",(code,signal)=>signal?reject(new Error("rg terminated by signal "+signal)):resolve(code));
  });
  const byteBudget=12*1024;
  let retainedBytes=0;
  let clientTruncated=false;
  let totalLines=0;
  let totalMatchedLines=0;
  let totalMatches=0;
  const files=[];
  const counts=new Map();
  const matches=[];
  const retain=(target,value)=>{
    const bytes=Buffer.byteLength(JSON.stringify(value));
    if(retainedBytes+bytes>byteBudget){clientTruncated=true;return;}
    retainedBytes+=bytes;target.push(value);
  };
  try {
    for await(const line of createInterface({input:child.stdout,crlfDelay:Infinity})){
      if(!line)continue;
      const event=JSON.parse(line);
      if(event.type!=="match"&&event.type!=="context")continue;
      const data=event.data||{};
      if(!data.path||typeof data.path.text!=="string"||!data.lines||typeof data.lines.text!=="string")throw new Error("rg returned non-text search data");
      const file=data.path.text;
      totalLines+=1;
      if(event.type==="match"){
        const count=Array.isArray(data.submatches)?data.submatches.length:0;
        totalMatches+=count;
        totalMatchedLines+=1;
        counts.set(file,(counts.get(file)||0)+count);
      }
      if(input.outputMode==="content"){
        const fullContent=data.lines.text.replace(/\r?\n$/,"");
        const content=fullContent.slice(0,2000);
        retain(matches,{file,lineNumber:data.line_number,content,contentTruncated:content.length<fullContent.length,isContextLine:event.type==="context"});
      }
    }
  }catch(error){child.kill();await completion.catch(()=>undefined);throw error;}
  const code=await completion;
  if(code!==0&&code!==1)throw new Error((stderr||"rg failed with exit "+code).trim());
  for(const [file] of counts){
    if(input.outputMode==="files_with_matches")retain(files,file);
  }
  const retainedCounts=[];
  if(input.outputMode==="count")for(const entry of counts)retain(retainedCounts,entry);
  emit({ok:true,outputMode:input.outputMode,files,counts:retainedCounts,matches,totalFiles:counts.size,totalLines,totalMatchedLines,totalMatches,clientTruncated});
}catch(error){emit({ok:false,error:error instanceof Error?error.message:String(error)});}})();
`.trim();

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

interface GrepShellReceipt {
  readonly ok: true;
  readonly outputMode: "content" | "files_with_matches" | "count";
  readonly files: readonly string[];
  readonly counts: readonly (readonly [string, number])[];
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
  readonly totalMatches: number;
  readonly clientTruncated: boolean;
}

function parseGrepShellReceipt(
  output: string,
  expectedOutputMode: string,
): GrepShellReceipt | { readonly ok: false; readonly error: string } {
  if (!output.startsWith(CURSOR_GREP_RECEIPT_PREFIX)) {
    return { ok: false, error: "The caller Bash result did not contain a complete Fleet Grep receipt." };
  }
  try {
    const decoded = JSON.parse(Buffer.from(
      output.slice(CURSOR_GREP_RECEIPT_PREFIX.length).trim(),
      "base64url",
    ).toString("utf8")) as unknown;
    if (!isRecord(decoded)) throw new Error("receipt is not an object");
    if (decoded.ok === false && typeof decoded.error === "string") {
      return { ok: false, error: decoded.error };
    }
    if (decoded.ok !== true || decoded.outputMode !== expectedOutputMode) {
      throw new Error("receipt mode does not match the native search");
    }
    if (!Array.isArray(decoded.files) || !decoded.files.every((file) => typeof file === "string")) {
      throw new Error("receipt files are invalid");
    }
    if (!Array.isArray(decoded.counts) || !decoded.counts.every((entry) => (
      Array.isArray(entry)
      && entry.length === 2
      && typeof entry[0] === "string"
      && typeof entry[1] === "number"
      && Number.isSafeInteger(entry[1])
      && entry[1] >= 0
    ))) {
      throw new Error("receipt counts are invalid");
    }
    if (!Array.isArray(decoded.matches) || !decoded.matches.every((entry) => (
      isRecord(entry)
      && typeof entry.file === "string"
      && typeof entry.lineNumber === "number"
      && Number.isSafeInteger(entry.lineNumber)
      && entry.lineNumber > 0
      && typeof entry.content === "string"
      && typeof entry.contentTruncated === "boolean"
      && typeof entry.isContextLine === "boolean"
    ))) {
      throw new Error("receipt matches are invalid");
    }
    for (const key of ["totalFiles", "totalLines", "totalMatchedLines", "totalMatches"] as const) {
      if (typeof decoded[key] !== "number" || !Number.isSafeInteger(decoded[key]) || decoded[key] < 0) {
        throw new Error(`receipt ${key} is invalid`);
      }
    }
    if (typeof decoded.clientTruncated !== "boolean") throw new Error("receipt truncation flag is invalid");
    return decoded as unknown as GrepShellReceipt;
  } catch (error) {
    return {
      ok: false,
      error: `The caller Bash result contained an invalid Fleet Grep receipt: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function buildGrepReceiptSuccess(
  args: Readonly<Record<string, string>>,
  receipt: GrepShellReceipt,
): Record<string, unknown> {
  const path = args.path || ".";
  let result: Record<string, unknown>;
  if (receipt.outputMode === "files_with_matches") {
    result = {
      files: {
        files: receipt.files,
        totalFiles: receipt.totalFiles,
        clientTruncated: receipt.clientTruncated,
        ripgrepTruncated: false,
      },
    };
  } else if (receipt.outputMode === "count") {
    result = {
      count: {
        counts: receipt.counts.map(([file, count]) => ({ file, count })),
        totalFiles: receipt.totalFiles,
        totalMatches: receipt.totalMatches,
        clientTruncated: receipt.clientTruncated,
        ripgrepTruncated: false,
      },
    };
  } else {
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
    const matches = [...byFile].map(([file, fileMatches]) => ({ file, matches: fileMatches }));
    result = {
      content: {
        matches,
        totalLines: receipt.totalLines,
        totalMatchedLines: receipt.totalMatchedLines,
        clientTruncated: receipt.clientTruncated,
        ripgrepTruncated: false,
      },
    };
  }
  return {
    pattern: args.pattern ?? "",
    path,
    outputMode: receipt.outputMode,
    workspaceResults: { [path]: result },
  };
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
