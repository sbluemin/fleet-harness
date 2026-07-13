export interface ConsoleConflictDialogOptions {
  readonly buttons: string[];
  readonly cancelId: number;
  readonly defaultId: number;
  readonly detail: string;
  readonly message: string;
  readonly title: string;
  readonly type: "warning" | "error";
}

export interface ConsoleConflictHandlerDependencies {
  readonly quit: () => void;
  readonly showMessageBox: (options: ConsoleConflictDialogOptions) => Promise<unknown>;
}

const CONSOLE_CONFLICT_ERRORS = new Set(["console_lock_foreign_process_appeared", "console_lock_foreign_process_unhealthy"]);
const CONSOLE_PAIRING_IDENTITY_ERRORS = new Set(["console_pairing_identity_unavailable"]);
const CONSOLE_CONFLICT_DIALOG: ConsoleConflictDialogOptions = {
  type: "warning",
  title: "Fleet Console is already running",
  message: "Fleet Console is already running.",
  detail: "Stop or quit the running Fleet Console before opening Fleet Console Desktop again.",
  buttons: ["OK"],
  defaultId: 0,
  cancelId: 0,
};

export function isConsoleConflict(error: unknown): boolean {
  return error instanceof Error && CONSOLE_CONFLICT_ERRORS.has(error.message);
}

export function isConsolePairingIdentityUnavailable(error: unknown): boolean {
  return error instanceof Error && CONSOLE_PAIRING_IDENTITY_ERRORS.has(error.message);
}

export async function showConsoleConflictAndQuit(dependencies: ConsoleConflictHandlerDependencies): Promise<void> {
  try {
    await dependencies.showMessageBox(CONSOLE_CONFLICT_DIALOG);
  } catch {
    // The Desktop must still quit if Electron cannot display the acknowledgement dialog.
  } finally {
    dependencies.quit();
  }
}

export async function showConsolePairingIdentityUnavailableAndQuit(dependencies: ConsoleConflictHandlerDependencies): Promise<void> {
  try {
    await dependencies.showMessageBox({
      type: "error",
      title: "Could not connect to Fleet Console",
      message: "The running Fleet Console could not be verified.",
      detail: "Its pairing identity is unavailable or incompatible. Fleet Console Desktop left the running Console unchanged.",
      buttons: ["OK"],
      defaultId: 0,
      cancelId: 0,
    });
  } catch {
    // The foreign Console is never affected when native feedback is unavailable.
  } finally {
    dependencies.quit();
  }
}
