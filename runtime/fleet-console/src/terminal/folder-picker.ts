import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

import { validateAbsoluteDirectory } from "./folder-grants.js";

export type FolderPickerErrorCode = "unsupported_platform" | "dialog_unavailable" | "dialog_timeout" | "invalid_folder";

export type FolderPickerResult =
  | { readonly kind: "selected"; readonly cwd: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "error"; readonly error: FolderPickerErrorCode };

export interface FolderPickerDeps {
  readonly platform?: NodeJS.Platform;
  readonly runCommand?: (bin: string, args: readonly string[]) => Promise<CommandResult>;
  readonly statSync?: typeof fs.statSync;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr?: string;
}

interface PickerCommand {
  readonly bin: string;
  readonly args: readonly string[];
}

const execFileAsync = promisify(execFile);
const DIALOG_TIMEOUT_MS = 30_000;

export function createNativeFolderPicker(deps: FolderPickerDeps = {}): () => Promise<FolderPickerResult> {
  const platform = deps.platform ?? process.platform;
  const runCommand = deps.runCommand ?? runNativeCommand;
  const statSync = deps.statSync ?? fs.statSync;

  return async () => {
    const commands = buildPickerCommands(platform);
    if (commands.length === 0) return { kind: "error", error: "unsupported_platform" };
    for (const command of commands) {
      const result = await runPickerCommand(runCommand, command);
      if ("kind" in result && result.kind === "unavailable") continue;
      if ("kind" in result && result.kind === "cancelled") return { kind: "cancelled" };
      if ("kind" in result && result.kind === "timeout") return { kind: "error", error: "dialog_timeout" };
      if ("kind" in result) continue;
      try {
        return { kind: "selected", cwd: validateAbsoluteDirectory(result.stdout.trim(), statSync) };
      } catch {
        return { kind: "error", error: "invalid_folder" };
      }
    }
    return { kind: "error", error: "dialog_unavailable" };
  };
}

function buildPickerCommands(platform: NodeJS.Platform): readonly PickerCommand[] {
  if (platform === "darwin") {
    return [{ bin: "osascript", args: ["-e", "POSIX path of (choose folder with prompt \"Choose a Fleet workspace\")"] }];
  }
  if (platform === "linux") {
    return [
      { bin: "zenity", args: ["--file-selection", "--directory", "--title=Choose a Fleet workspace"] },
      { bin: "kdialog", args: ["--getexistingdirectory", ".", "Choose a Fleet workspace"] },
    ];
  }
  if (platform === "win32") {
    return [{
      bin: "powershell.exe",
      args: [
        "-NoProfile",
        "-Sta",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath } else { exit 1 }",
      ],
    }];
  }
  return [];
}

async function runPickerCommand(runCommand: (bin: string, args: readonly string[]) => Promise<CommandResult>, command: PickerCommand): Promise<CommandResult | { readonly kind: "cancelled" | "timeout" | "unavailable" }> {
  try {
    return await runCommand(command.bin, command.args);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return { kind: "unavailable" };
    if (err.code === "ETIMEDOUT") return { kind: "timeout" };
    // 다이얼로그 바이너리가 실행된 뒤 경로 없이 비정상 종료하면 사용자 취소로 간주한다.
    // osascript의 취소 메시지는 로케일마다 달라 텍스트 매칭이 불가하지만 코드 -128로 종료하고,
    // zenity/kdialog/powershell 취소도 종료코드 1로 알린다. 따라서 텍스트가 아닌 종료 방식으로 판정한다.
    return { kind: "cancelled" };
  }
}

async function runNativeCommand(bin: string, args: readonly string[]): Promise<CommandResult> {
  const result = await execFileAsync(bin, [...args], { timeout: DIALOG_TIMEOUT_MS });
  return { stdout: result.stdout, stderr: result.stderr };
}
