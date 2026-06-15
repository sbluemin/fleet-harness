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
  readonly readProcVersion?: () => string;
  readonly env?: NodeJS.ProcessEnv;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr?: string;
}

interface PickerCommand {
  readonly bin: string;
  readonly args: readonly string[];
  readonly postProcess?: "wslpath";
}

const execFileAsync = promisify(execFile);
const DIALOG_TIMEOUT_MS = 30_000;

// win32·WSL 공용 PowerShell 폴더 선택기의 C# 본문(Add-Type TypeDefinition).
// 구식 FolderBrowserDialog(.NET Framework의 축소 트리뷰)는 주소창·검색·경로 붙여넣기가 없어,
// Windows 10/11 내장 IFileOpenDialog(FOS_PICKFOLDERS)를 COM으로 직접 호출해 최신 탐색기 스타일
// 폴더 선택창을 띄운다. pwsh 설치 여부와 무관하게 powershell.exe(5.1)에서 동작한다.
// FOS_FORCEFILESYSTEM은 의도적으로 빼는데, 이 플래그가 좌측 트리에서 파일시스템 속성이 없는
// "Linux"(\\wsl.localhost) 가상 루트 노드를 잘라내 WSL 경로 탐색을 막기 때문이다. 대신 Pick은
// 시작 경로(initialPath)를 받아 SetFolder/AddPlace로 WSL 위치를 시작점·좌측 고정으로 노출한다.
// FORCEFILESYSTEM을 뺀 만큼 비 파일시스템 선택 가능성이 생기므로 GetDisplayName(FILESYSPATH)
// 실패를 null로 가드한다. COM 미사용 메서드는 vtable 슬롯만 차지하므로 인자 없는 stub로 둔다.
const POWERSHELL_FOLDER_PICKER_CSHARP = `
using System;
using System.Runtime.InteropServices;
namespace FleetPicker {
  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItem {
    void BindToHandler();
    void GetParent();
    [PreserveSig] int GetDisplayName(int sigdn, out IntPtr ppszName);
    void GetAttributes();
    void Compare();
  }
  [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(); void SetFileTypeIndex(); void GetFileTypeIndex();
    void Advise(); void Unadvise();
    [PreserveSig] int SetOptions(uint fos);
    [PreserveSig] int GetOptions(out uint pfos);
    void SetDefaultFolder();
    void SetFolder(IShellItem psi);
    void GetFolder(); void GetCurrentSelection();
    void SetFileName(); void GetFileName(); void SetTitle(); void SetOkButtonLabel(); void SetFileNameLabel();
    [PreserveSig] int GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, int fdap);
    void SetDefaultExtension(); void Close(); void SetClientGuid(); void ClearClientData(); void SetFilter();
    void GetResults(); void GetSelectedItems();
  }
  [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")] public class FileOpenDialog { }
  public static class Picker {
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
    static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);
    static IShellItem ItemFromPath(string path) {
      Guid iid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
      IShellItem it; SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out it); return it;
    }
    public static string Pick(string initialPath) {
      var dlg = (IFileOpenDialog)(new FileOpenDialog());
      uint opts; dlg.GetOptions(out opts);
      dlg.SetOptions(opts | 0x20); // FOS_PICKFOLDERS
      if (!string.IsNullOrEmpty(initialPath)) {
        // 시작 폴더를 WSL 위치로 지정하고 좌측에 고정(FDAP_TOP). 실패해도 기본 위치로 진행한다.
        try { IShellItem s = ItemFromPath(initialPath); dlg.AddPlace(s, 1); dlg.SetFolder(s); } catch { }
      }
      if (dlg.Show(IntPtr.Zero) != 0) return null; // 취소/실패 시 null
      IShellItem item; dlg.GetResult(out item);
      IntPtr ptr; if (item.GetDisplayName(unchecked((int)0x80058000), out ptr) != 0) return null; // SIGDN_FILESYSPATH; 비 파일시스템 선택 가드
      string path = Marshal.PtrToStringAuto(ptr);
      Marshal.FreeCoTaskMem(ptr);
      return path;
    }
  }
}`;

export function createNativeFolderPicker(deps: FolderPickerDeps = {}): () => Promise<FolderPickerResult> {
  const platform = deps.platform ?? process.platform;
  const runCommand = deps.runCommand ?? runNativeCommand;
  const statSync = deps.statSync ?? fs.statSync;
  const readProcVersion = deps.readProcVersion ?? defaultReadProcVersion;
  const env = deps.env ?? process.env;

  return async () => {
    const isWsl = platform === "linux" && detectWsl(readProcVersion, env);
    const wslStartPath = isWsl ? wslStartFolderUnc(env) : "";
    const commands = buildPickerCommands(platform, isWsl, wslStartPath);
    if (commands.length === 0) return { kind: "error", error: "unsupported_platform" };
    for (const command of commands) {
      const result = await runPickerCommand(runCommand, command);
      if ("kind" in result && result.kind === "unavailable") continue;
      if ("kind" in result && result.kind === "cancelled") return { kind: "cancelled" };
      if ("kind" in result && result.kind === "timeout") return { kind: "error", error: "dialog_timeout" };
      if ("kind" in result) continue;
      let resolvedPath = result.stdout.trim();
      if (command.postProcess === "wslpath") {
        // wslpath 변환은 별도 try/catch로 감싸야 한다. rc=1(변환 불가)은 취소가 아닌 invalid_folder다.
        try {
          const wslResult = await runCommand("wslpath", ["-u", resolvedPath]);
          resolvedPath = wslResult.stdout.trim();
        } catch {
          return { kind: "error", error: "invalid_folder" };
        }
      }
      try {
        return { kind: "selected", cwd: validateAbsoluteDirectory(resolvedPath, statSync) };
      } catch {
        return { kind: "error", error: "invalid_folder" };
      }
    }
    return { kind: "error", error: "dialog_unavailable" };
  };
}

function defaultReadProcVersion(): string {
  try {
    return fs.readFileSync("/proc/version", "utf8");
  } catch {
    return "";
  }
}

function detectWsl(readProcVersion: () => string, env: NodeJS.ProcessEnv): boolean {
  if (env.WSL_INTEROP !== undefined || env.WSL_DISTRO_NAME !== undefined) return true;
  return /microsoft|wsl/i.test(readProcVersion());
}

function buildPickerCommands(platform: NodeJS.Platform, isWsl = false, wslStartPath = ""): readonly PickerCommand[] {
  if (platform === "darwin") {
    return [{ bin: "osascript", args: ["-e", "POSIX path of (choose folder with prompt \"Choose a Fleet workspace\")"] }];
  }
  if (platform === "linux") {
    const commands: PickerCommand[] = [];
    if (isWsl) {
      // WSL 환경: Windows 폴더 선택 다이얼로그(IFileOpenDialog)를 우선 시도하고 wslpath로 Linux 경로로 변환한다.
      // 시작 경로로 WSL 위치를 넘겨 좌측에서 바로 Linux 파일시스템을 탐색하게 한다.
      // WSLg 사용자용 zenity/kdialog는 폴백으로 유지한다.
      commands.push({ bin: "powershell.exe", args: buildPowerShellPickerArgs(wslStartPath), postProcess: "wslpath" });
    }
    commands.push(
      { bin: "zenity", args: ["--file-selection", "--directory", "--title=Choose a Fleet workspace"] },
      { bin: "kdialog", args: ["--getexistingdirectory", ".", "Choose a Fleet workspace"] },
    );
    return commands;
  }
  if (platform === "win32") {
    return [{ bin: "powershell.exe", args: buildPowerShellPickerArgs("") }];
  }
  return [];
}

// IFileOpenDialog 폴더 선택 스크립트를 powershell.exe 인자로 조립한다. initialWindowsPath가 있으면
// 그 위치에서 다이얼로그를 연다(빈 문자열이면 기본 위치). UTF-8 출력으로 비 ASCII 경로 보존,
// 취소/실패 시 exit 1로 종료해 상위 취소 판정(runPickerCommand의 비-ENOENT 예외 → cancelled)을 유지한다.
function buildPowerShellPickerArgs(initialWindowsPath: string): readonly string[] {
  const escaped = initialWindowsPath.replace(/'/g, "''"); // PowerShell 단일 인용 문자열 이스케이프
  const script = [
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
    `Add-Type -TypeDefinition '${POWERSHELL_FOLDER_PICKER_CSHARP}'`,
    `$selection = [FleetPicker.Picker]::Pick('${escaped}')`,
    "if ([string]::IsNullOrEmpty($selection)) { exit 1 }",
    "[Console]::Out.Write($selection)",
  ].join("\n");
  return ["-NoProfile", "-Sta", "-Command", script];
}

// WSL 배포판 내부 경로를 IFileOpenDialog 시작 폴더용 UNC(\\wsl.localhost\<distro>\...)로 만든다.
// HOME이 배포판 내부(/...이며 /mnt/* 아님)면 홈을, 아니면 배포판 루트를 시작점으로 쓴다.
function wslStartFolderUnc(env: NodeJS.ProcessEnv): string {
  const distro = env.WSL_DISTRO_NAME;
  if (!distro) return "";
  const home = env.HOME;
  if (home && home.startsWith("/") && !home.startsWith("/mnt/")) {
    return `\\\\wsl.localhost\\${distro}${home.replace(/\//g, "\\")}`;
  }
  return `\\\\wsl.localhost\\${distro}`;
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
  // windowsHide: true가 없으면 powershell.exe가 콘솔 창을 새로 띄워 파일 탐색기와 함께 깜빡인다.
  // 이 플래그는 자식 프로세스의 콘솔 창만 숨길 뿐, COM으로 띄우는 IFileOpenDialog(별도 GUI 창)는
  // 그대로 표시되므로 폴더 선택 다이얼로그는 정상 노출된다.
  const result = await execFileAsync(bin, [...args], { timeout: DIALOG_TIMEOUT_MS, windowsHide: true });
  return { stdout: result.stdout, stderr: result.stderr };
}
