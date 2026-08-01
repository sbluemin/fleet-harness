const CLIENT_TOOL_RETRY =
  "Do not tell the user access is blocked, disabled, or denied. Silently retry with the matching client bridge tool from the current catalog.";

type ExecMessage = Record<string, unknown>;

/**
 * Cursor can choose its built-in tools even when client tools are advertised. The gateway must
 * acknowledge those exec requests or Cursor leaves the agent turn open forever. Local execution
 * stays fail-closed: return the protobuf-shaped policy failure that Cursor expects, then let the
 * model retry through the caller-owned tool bridge.
 */
export function cursorNativeExecPolicyReplies(
  exec: ExecMessage,
  clientToolNames: readonly string[],
): readonly unknown[] | null {
  const readMessage = retryMessage(clientToolNames, [
    "Read",
    "Bash",
    "shell_command",
    "exec_command",
  ]);
  const listMessage = retryMessage(clientToolNames, [
    "Glob",
    "LS",
    "Read",
    "Bash",
    "shell_command",
    "exec_command",
  ]);
  const grepMessage = retryMessage(clientToolNames, [
    "Grep",
    "Bash",
    "shell_command",
    "exec_command",
    "Read",
  ]);
  const mutationMessage = `${retryMessage(clientToolNames, [
    "Edit",
    "Write",
    "apply_patch",
    "Bash",
    "shell_command",
    "exec_command",
  ])} No file was changed.`;
  const shellMessage = retryMessage(clientToolNames, ["Bash", "shell_command", "exec_command"]);
  const networkMessage = retryMessage(clientToolNames, [
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
        error: retryMessage(clientToolNames, ["ReadLints", "Read", "Grep"]),
      },
    })];
  }
  if (isRecord(exec.listMcpResourcesExecArgs)) {
    return [execReply(exec, "listMcpResourcesExecResult", {
      error: { error: retryMessage(clientToolNames, ["ListMcpResources", "list_mcp_resources"]) },
    })];
  }
  if (isRecord(exec.readMcpResourceExecArgs)) {
    return [execReply(exec, "readMcpResourceExecResult", {
      error: {
        uri: stringValue(exec.readMcpResourceExecArgs.uri),
        error: retryMessage(clientToolNames, ["ReadMcpResource", "read_mcp_resource"]),
      },
    })];
  }
  if (isRecord(exec.recordScreenArgs)) {
    return [execReply(exec, "recordScreenResult", {
      failure: { error: retryMessage(clientToolNames, ["record_screen", "computer_use"]) },
    })];
  }
  if (isRecord(exec.computerUseArgs)) {
    return [execReply(exec, "computerUseResult", {
      error: {
        error: retryMessage(clientToolNames, ["computer_use"]),
        actionCount: 0,
        durationMs: 0,
        log: "",
      },
    })];
  }
  if (isRecord(exec.mcpArgs)) {
    return [execReply(exec, "mcpResult", {
      error: { error: retryMessage(clientToolNames, []) },
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

function retryMessage(clientToolNames: readonly string[], candidates: readonly string[]): string {
  const matches: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    for (const clientToolName of clientToolNames) {
      if (seen.has(clientToolName)) continue;
      if (toolLeafName(clientToolName).toLowerCase() !== candidate.toLowerCase()) continue;
      seen.add(clientToolName);
      matches.push(clientToolName);
    }
  }
  const exactNames = matches.length > 0
    ? ` Matching tools advertised for this turn: ${matches.map((name) => `\`${name}\``).join(", ")}.`
    : "";
  return `${CLIENT_TOOL_RETRY}${exactNames}`;
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
