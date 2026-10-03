import type { ClientNavigateCapability } from "@fleet-console/sdk/navigation";
import { React } from "@fleet-console/sdk/plugin/browser";

import type { TerminalFileLinks } from "../terminal/shared/terminal-file-links.js";

interface CwdBase {
  readonly operationId: string;
  status: "idle" | "loading" | "done";
  relative: string | null;
  /** 실패한 조회를 다시 시도해도 되는 시각(ms, `Date.now()` 기준). hover마다 요청이 몰리지 않게 한다. */
  retryAt: number;
}

/** 실패한 cwd 조회를 다시 묻기까지의 최소 간격. */
const CWD_RETRY_MS = 2_000;

/**
 * Agent 터미널 출력의 파일 경로 링크. 상대 경로의 기준은 그 Operation의 cwd를 서버가 Theater 상대로
 * 바꿔 준 값이다(`GET /api/v1/terminal/cwd`). 그 값은 처음 링크를 찾을 때 한 번만 읽는다 — 출력 위에
 * 포인터를 올리지 않는 터미널은 요청을 하지 않는다. 받기 전이나 cwd가 Theater 밖이면 상대 경로 링크는
 * 세우지 않고 절대 경로만 남는다(다음 hover에서 다시 찾는다). 조회가 실패하면(네트워크·서버 오류)
 * 간격을 두고 다시 묻는다 — 일시적 실패 하나로 그 Operation의 상대 경로 링크가 영영 꺼지면 안 된다.
 * 성공 응답과 확정적인 404(없는 Operation)만 값을 굳힌다.
 */
export function useAgentTerminalFileLinks(operationId: string, theaterId: string, navigate: ClientNavigateCapability): TerminalFileLinks {
  const baseRef = React.useRef<CwdBase>({ operationId, status: "idle", relative: null, retryAt: 0 });
  if (baseRef.current.operationId !== operationId) baseRef.current = { operationId, status: "idle", relative: null, retryAt: 0 };
  return React.useMemo<TerminalFileLinks>(() => ({
    context: () => {
      const base = baseRef.current;
      if (base.status === "idle" && Date.now() >= base.retryAt) loadCwdBase(base);
      return { theaterId, cwdRelative: base.relative };
    },
    open: (target) => navigate.openFile({ ...target, source: "agent-terminal" }),
  }), [theaterId, navigate]);
}

function loadCwdBase(base: CwdBase): void {
  base.status = "loading";
  Promise.resolve()
    .then(() => fetch(`/api/v1/terminal/cwd?operationId=${encodeURIComponent(base.operationId)}`))
    .then(async (response) => {
      if (response?.status === 404) {
        base.relative = null;
        base.status = "done";
        return;
      }
      if (!response?.ok) throw new Error(`terminal_cwd_${response?.status ?? "unavailable"}`);
      const body: unknown = await response.json();
      const relative = (body as { readonly relative?: unknown } | null)?.relative;
      base.relative = typeof relative === "string" ? relative : null;
      base.status = "done";
    })
    .catch(() => {
      base.status = "idle";
      base.retryAt = Date.now() + CWD_RETRY_MS;
    });
}
