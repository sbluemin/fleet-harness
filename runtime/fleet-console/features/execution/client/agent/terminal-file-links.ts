import type { ClientNavigateCapability } from "@fleet-console/sdk/navigation";
import { React } from "@fleet-console/sdk/plugin/browser";

import type { TerminalFileLinks } from "../terminal/shared/terminal-file-links.js";

interface CwdBase {
  readonly operationId: string;
  status: "idle" | "loading" | "done";
  relative: string | null;
}

/**
 * Agent 터미널 출력의 파일 경로 링크. 상대 경로의 기준은 그 Operation의 cwd를 서버가 Theater 상대로
 * 바꿔 준 값이다(`GET /api/v1/terminal/cwd`). 그 값은 처음 링크를 찾을 때 한 번만 읽는다 — 출력 위에
 * 포인터를 올리지 않는 터미널은 요청을 하지 않는다. 받기 전이나 cwd가 Theater 밖이면 상대 경로 링크는
 * 세우지 않고 절대 경로만 남는다(다음 hover에서 다시 찾는다).
 */
export function useAgentTerminalFileLinks(operationId: string, theaterId: string, navigate: ClientNavigateCapability): TerminalFileLinks {
  const baseRef = React.useRef<CwdBase>({ operationId, status: "idle", relative: null });
  if (baseRef.current.operationId !== operationId) baseRef.current = { operationId, status: "idle", relative: null };
  return React.useMemo<TerminalFileLinks>(() => ({
    context: () => {
      const base = baseRef.current;
      if (base.status === "idle") loadCwdBase(base);
      return { theaterId, cwdRelative: base.relative };
    },
    open: (target) => navigate.openFile({ ...target, source: "agent-terminal" }),
  }), [theaterId, navigate]);
}

function loadCwdBase(base: CwdBase): void {
  base.status = "loading";
  Promise.resolve()
    .then(() => fetch(`/api/v1/terminal/cwd?operationId=${encodeURIComponent(base.operationId)}`))
    .then((response) => (response?.ok ? response.json() : null))
    .then((body: unknown) => {
      const relative = (body as { readonly relative?: unknown } | null)?.relative;
      base.relative = typeof relative === "string" ? relative : null;
      base.status = "done";
    })
    .catch(() => {
      base.status = "done";
    });
}
