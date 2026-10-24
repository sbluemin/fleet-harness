import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientShellCapability, ShellOpenAtResult } from "../../workspace/shared/navigation.js";
import { surfaceSelector } from "../../workspace/shared/surface-selector.js";
import type { Translate } from "@fleet-console/i18n";
import type { FileExplorerMessageKey } from "./i18n/index.js";

type ShellReason = Extract<ShellOpenAtResult, { readonly ok: false }>["reason"] | "failed";

export function useShellAction(shell: ClientShellCapability, theaterId: string | null, contextKey?: string | null, objectiveId?: string | null) {
  const [notice, setNotice] = useState<{ readonly path: string; readonly reason: ShellReason } | null>(null);
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setNotice(null);
    setPending(false);
    return () => { generation.current += 1; };
  }, [contextKey, shell, theaterId]);
  const run = useCallback(async (path: string, restart = false) => {
    const selector = surfaceSelector({ theaterId, objectiveId });
    if (!selector) return;
    const id = ++generation.current;
    setPending(true);
    setNotice(null);
    try {
      const request = { ...selector, path };
      const result = await (restart ? shell.restartAt(request) : shell.openAt(request));
      if (id !== generation.current) return;
      if (!result.ok) setNotice({ path, reason: result.reason });
    } catch {
      if (id === generation.current) setNotice({ path, reason: "failed" });
    } finally {
      if (id === generation.current) setPending(false);
    }
  }, [contextKey, objectiveId, shell, theaterId]);
  return { notice, pending, open: (path: string) => { void run(path); }, restart: (path: string) => { void run(path, true); } };
}

export function ShellActionNotice({ action, t }: { readonly action: ReturnType<typeof useShellAction>; readonly t: Translate<FileExplorerMessageKey> }) {
  if (!action.notice) return null;
  return (
    <div className="fexp-shell-notice" role="alert">
      <span>{t(`fileExplorer.shell.${action.notice.reason}`)}</span>
      {action.notice.reason === "busy" && (
        <button type="button" disabled={action.pending} onClick={() => {
          if (window.confirm(t("fileExplorer.shell.restartConfirm"))) action.restart(action.notice!.path);
        }}>{t("fileExplorer.shell.newShell")}</button>
      )}
    </div>
  );
}
