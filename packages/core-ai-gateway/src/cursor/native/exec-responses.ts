import type { UnknownField } from "@bufbuild/protobuf";
import { BinaryReader, BinaryWriter, WireType } from "@bufbuild/protobuf/wire";

const NO_USER_FACING_BLOCK =
  "Do not tell the user access is blocked, disabled, or denied.";
const CLIENT_TOOL_RETRY =
  `${NO_USER_FACING_BLOCK} Silently retry with the matching client bridge tool from the current catalog.`;

type ExecMessage = Record<string, unknown>;

export interface CursorClientToolReference {
  readonly clientName: string;
  readonly wireName: string;
}

/**
 * Cursor can choose its built-in tools even when client tools are advertised. The gateway must
 * acknowledge those exec requests or Cursor leaves the agent turn open forever. Local execution
 * stays fail-closed: return the protobuf-shaped policy failure that Cursor expects, then let the
 * model retry through the caller-owned tool bridge.
 */
export function cursorNativeExecPolicyReplies(
  exec: ExecMessage,
  clientTools: readonly (string | CursorClientToolReference)[],
): readonly unknown[] | null {
  const readMessage = retryMessage(clientTools, [
    "Read",
    "Bash",
    "shell_command",
    "exec_command",
  ]);
  const listMessage = retryMessage(clientTools, [
    "Glob",
    "LS",
    "Read",
    "Bash",
    "shell_command",
    "exec_command",
  ]);
  const grepMessage = retryMessage(clientTools, [
    "Grep",
    "Bash",
    "shell_command",
    "exec_command",
    "Read",
  ]);
  const mutationMessage = `${retryMessage(clientTools, [
    "Edit",
    "Write",
    "apply_patch",
    "Bash",
    "shell_command",
    "exec_command",
  ])} No file was changed.`;
  const shellMessage = retryMessage(clientTools, ["Bash", "shell_command", "exec_command"]);
  const networkMessage = retryMessage(clientTools, [
    "WebFetch",
    "Fetch",
    "Bash",
    "shell_command",
    "exec_command",
  ]);

  if (isRecord(exec.readArgs)) {
    return [execReply(exec, "readResult", {
      error: { path: stringValue(exec.readArgs.path), error: readMessage },
    })];
  }
  if (isRecord(exec.writeArgs)) {
    return [execReply(exec, "writeResult", {
      rejected: { path: stringValue(exec.writeArgs.path), reason: mutationMessage },
    })];
  }
  if (isRecord(exec.deleteArgs)) {
    return [execReply(exec, "deleteResult", {
      rejected: { path: stringValue(exec.deleteArgs.path), reason: mutationMessage },
    })];
  }
  if (isRecord(exec.lsArgs)) {
    return [execReply(exec, "lsResult", {
      error: { path: stringValue(exec.lsArgs.path), error: listMessage },
    })];
  }
  if (isRecord(exec.grepArgs)) {
    return [execReply(exec, "grepResult", { error: { error: grepMessage } })];
  }
  if (isRecord(exec.shellArgs)) {
    return [execReply(exec, "shellResult", shellFailure(exec.shellArgs, shellMessage))];
  }
  if (isRecord(exec.shellStreamArgs)) {
    const args = exec.shellStreamArgs;
    const cwd = stringValue(args.workingDirectory);
    return [
      execReply(exec, "shellStream", {
        start: isRecord(args.requestedSandboxPolicy)
          ? { sandboxPolicy: args.requestedSandboxPolicy }
          : {},
      }),
      execReply(exec, "shellStream", { stderr: { data: shellMessage } }),
      execReply(exec, "shellStream", { exit: { code: 1, cwd, aborted: true } }),
      execReply(exec, "shellResult", shellFailure(args, shellMessage)),
      { execClientControlMessage: { streamClose: { id: numberValue(exec.id) } } },
    ];
  }
  if (isRecord(exec.backgroundShellSpawnArgs)) {
    const args = exec.backgroundShellSpawnArgs;
    return [execReply(exec, "backgroundShellSpawnResult", {
      error: {
        command: stringValue(args.command),
        workingDirectory: stringValue(args.workingDirectory),
        error: shellMessage,
      },
    })];
  }
  if (isRecord(exec.writeShellStdinArgs)) {
    return [execReply(exec, "writeShellStdinResult", { error: { error: shellMessage } })];
  }
  if (isRecord(exec.fetchArgs)) {
    return [execReply(exec, "fetchResult", {
      error: { url: stringValue(exec.fetchArgs.url), error: networkMessage },
    })];
  }
  if (isRecord(exec.diagnosticsArgs)) {
    return [execReply(exec, "diagnosticsResult", {
      error: {
        path: stringValue(exec.diagnosticsArgs.path),
        error: retryMessage(clientTools, ["ReadLints", "Read", "Grep"]),
      },
    })];
  }
  if (isRecord(exec.listMcpResourcesExecArgs)) {
    return [execReply(exec, "listMcpResourcesExecResult", {
      error: { error: retryMessage(clientTools, ["ListMcpResources", "list_mcp_resources"]) },
    })];
  }
  if (isRecord(exec.readMcpResourceExecArgs)) {
    return [execReply(exec, "readMcpResourceExecResult", {
      error: {
        uri: stringValue(exec.readMcpResourceExecArgs.uri),
        error: retryMessage(clientTools, ["ReadMcpResource", "read_mcp_resource"]),
      },
    })];
  }
  if (isRecord(exec.recordScreenArgs)) {
    return [execReply(exec, "recordScreenResult", {
      failure: { error: retryMessage(clientTools, ["record_screen", "computer_use"]) },
    })];
  }
  if (isRecord(exec.computerUseArgs)) {
    return [execReply(exec, "computerUseResult", {
      error: {
        error: retryMessage(clientTools, ["computer_use"]),
        actionCount: 0,
        durationMs: 0,
        log: "",
      },
    })];
  }
  if (isRecord(exec.mcpArgs)) {
    return [execReply(exec, "mcpResult", {
      error: { error: retryMessage(clientTools, []) },
    })];
  }
  return null;
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

function shellFailure(args: ExecMessage, message: string): unknown {
  return {
    failure: {
      command: stringValue(args.command),
      workingDirectory: stringValue(args.workingDirectory),
      exitCode: 1,
      signal: "",
      stdout: "",
      stderr: message,
      executionTime: 0,
      aborted: true,
    },
  };
}

function retryMessage(
  clientTools: readonly (string | CursorClientToolReference)[],
  candidates: readonly string[],
): string {
  const matches: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    for (const clientTool of clientTools) {
      const clientToolName = typeof clientTool === "string" ? clientTool : clientTool.clientName;
      const wireName = typeof clientTool === "string" ? clientTool : clientTool.wireName;
      if (seen.has(wireName)) continue;
      if (toolLeafName(clientToolName).toLowerCase() !== candidate.toLowerCase()) continue;
      seen.add(wireName);
      matches.push(wireName);
    }
  }
  if (matches.length > 0) {
    return `${CLIENT_TOOL_RETRY} Matching tools advertised for this turn: ${
      matches.map((name) => `\`${name}\``).join(", ")
    }.`;
  }
  // Naming nothing is what turned a rejection into a dead end. Claude Code defers most of its
  // catalog, so the replacement often is not advertised yet, and a model told only to "retry with
  // the matching client bridge tool" concluded none existed — then either gave up and told the
  // user it was blocked, or reached for the Cursor-native tool again and was rejected again.
  const toolSearch = toolSearchWireName(clientTools);
  if (toolSearch) {
    return `${NO_USER_FACING_BLOCK} The matching client bridge tool is deferred, not missing: call \`${toolSearch}\` to load it, then call the tool name that search returns.`;
  }
  if (clientTools.length === 0) {
    // Measured on Claude Code title-generation turns: tools:[] still carries the user prompt, so
    // Cursor reaches for natives and every reject previously said "continue with the advertised
    // client tools" — there were none, and the model kept retrying natives.
    return `${NO_USER_FACING_BLOCK} This turn advertises no client tools. Do not call any tool — answer in plain text only. This Cursor-native tool will be rejected again.`;
  }
  return `${NO_USER_FACING_BLOCK} No client bridge tool covers this action on this turn, and this Cursor-native tool will be rejected again — do not call it. Continue with the advertised client tools.`;
}

function toolSearchWireName(
  clientTools: readonly (string | CursorClientToolReference)[],
): string | undefined {
  for (const clientTool of clientTools) {
    const clientToolName = typeof clientTool === "string" ? clientTool : clientTool.clientName;
    if (toolLeafName(clientToolName).replace(/[_-]/g, "").toLowerCase() !== "toolsearch") continue;
    return typeof clientTool === "string" ? clientTool : clientTool.wireName;
  }
  return undefined;
}

function toolLeafName(name: string): string {
  return name.split("__").at(-1) ?? name;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const EXECUTE_HOOK_FIELD_NUMBER = 27;
const EXEC_CLIENT_MESSAGE_FIELD_NUMBER = 2;
const EXEC_CLIENT_CONTROL_MESSAGE_FIELD_NUMBER = 5;
const SUPPORTED_HOOK_CASES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11]);

export interface CursorUnknownExecReply {
  readonly payloads: readonly Uint8Array[];
  readonly replyKind: string;
}

/**
 * Cursor adds native exec variants independently of the vendored protobuf descriptor cadence.
 * Unknown protobuf fields retain their wire bytes, which lets the gateway acknowledge lifecycle
 * hooks without executing them and reject every other future variant through Cursor's control
 * channel instead of leaving the server waiting forever.
 */
export function cursorUnknownExecReply(
  exec: ExecMessage,
  unknownFields: readonly UnknownField[],
): CursorUnknownExecReply {
  const executeHook = unknownFields.find(
    (field) => field.no === EXECUTE_HOOK_FIELD_NUMBER
      && field.wireType === WireType.LengthDelimited,
  );
  if (executeHook) {
    const hookCase = executeHookRequestCase(executeHook);
    if (hookCase !== undefined && SUPPORTED_HOOK_CASES.has(hookCase)) {
      return {
        payloads: [executeHookReply(exec, hookCase)],
        replyKind: "exec.policy.executeHookArgs",
      };
    }
  }

  const caseName = cursorUnknownExecCaseName(unknownFields);
  return {
    payloads: unsupportedExecReplies(
      exec,
      `Fleet AI Gateway cannot handle Cursor native exec ${caseName}; retry with an advertised client tool.`,
    ),
    replyKind: `exec.control.${caseName}`,
  };
}

/** Payload-free label used by diagnostics. */
export function cursorUnknownExecCaseName(unknownFields: readonly UnknownField[]): string {
  const fieldNumbers = [...new Set(
    unknownFields
      .filter((field) => field.wireType === WireType.LengthDelimited)
      .map((field) => field.no),
  )].sort((left, right) => left - right);
  if (fieldNumbers.includes(EXECUTE_HOOK_FIELD_NUMBER)) return "executeHookArgs";
  return fieldNumbers.length > 0 ? `unknownField${fieldNumbers.join("-")}` : "unknown";
}

function executeHookRequestCase(field: UnknownField): number | undefined {
  const args = lengthDelimitedPayload(field);
  if (!args) return undefined;
  const request = embeddedMessage(args, 1);
  if (!request) return undefined;

  try {
    const reader = new BinaryReader(request);
    while (reader.pos < reader.len) {
      const [fieldNumber, wireType] = reader.tag();
      if (wireType === WireType.LengthDelimited) return fieldNumber;
      reader.skip(wireType, fieldNumber);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function lengthDelimitedPayload(field: UnknownField): Uint8Array | undefined {
  try {
    const reader = new BinaryReader(field.data);
    const payload = reader.bytes();
    return reader.pos === reader.len ? payload : undefined;
  } catch {
    return undefined;
  }
}

function embeddedMessage(message: Uint8Array, wantedFieldNumber: number): Uint8Array | undefined {
  try {
    const reader = new BinaryReader(message);
    while (reader.pos < reader.len) {
      const [fieldNumber, wireType] = reader.tag();
      if (fieldNumber === wantedFieldNumber && wireType === WireType.LengthDelimited) {
        return reader.bytes();
      }
      reader.skip(wireType, fieldNumber);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function executeHookReply(exec: ExecMessage, hookCase: number): Uint8Array {
  const response = encodeMessage((writer) => {
    writer.tag(hookCase, WireType.LengthDelimited).bytes(new Uint8Array());
  });
  const result = encodeMessage((writer) => {
    writer.tag(1, WireType.LengthDelimited).bytes(response);
  });
  const execClientMessage = encodeMessage((writer) => {
    writer.tag(1, WireType.Varint).uint32(unknownExecUint32Value(exec.id));
    const execId = unknownExecStringValue(exec.execId);
    if (execId) writer.tag(15, WireType.LengthDelimited).string(execId);
    writer.tag(EXECUTE_HOOK_FIELD_NUMBER, WireType.LengthDelimited).bytes(result);
  });
  return encodeMessage((writer) => {
    writer.tag(EXEC_CLIENT_MESSAGE_FIELD_NUMBER, WireType.LengthDelimited).bytes(execClientMessage);
  });
}

function unsupportedExecReplies(exec: ExecMessage, error: string): readonly Uint8Array[] {
  const id = unknownExecUint32Value(exec.id);
  const execThrow = encodeMessage((writer) => {
    writer.tag(1, WireType.Varint).uint32(id);
    writer.tag(2, WireType.LengthDelimited).string(error);
  });
  const streamClose = encodeMessage((writer) => {
    writer.tag(1, WireType.Varint).uint32(id);
  });
  return [
    encodeControlMessage(2, execThrow),
    encodeControlMessage(1, streamClose),
  ];
}

function encodeControlMessage(caseNumber: number, value: Uint8Array): Uint8Array {
  const control = encodeMessage((writer) => {
    writer.tag(caseNumber, WireType.LengthDelimited).bytes(value);
  });
  return encodeMessage((writer) => {
    writer.tag(EXEC_CLIENT_CONTROL_MESSAGE_FIELD_NUMBER, WireType.LengthDelimited).bytes(control);
  });
}

function encodeMessage(write: (writer: BinaryWriter) => void): Uint8Array {
  const writer = new BinaryWriter();
  write(writer);
  return writer.finish();
}

function unknownExecUint32Value(value: unknown): number {
  if (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 0xffff_ffff
  ) {
    return value;
  }
  return 0;
}

function unknownExecStringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
