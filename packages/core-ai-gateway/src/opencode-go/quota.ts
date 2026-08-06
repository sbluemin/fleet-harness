import type { ProviderResult } from "../quota/types.js";
import type { ProviderDeps } from "../quota/windows.js";
import { scanOpencodeGoWindows } from "./usage-scan.js";
import { OPENCODE_AUTH_PROVIDER_ID } from "./index.js";

/**
 * OpenCode Go는 API 키로 접근 가능한 사용량 엔드포인트를 노출하지 않는다(2026-08-03
 * 확정 — `/zen/go/v1` 라우트 소스의 표면은 models/messages/responses/chat뿐이고 usage
 * 후보 경로는 전부 SPA 폴백). 따라서 OpenUsage와 같은 방식으로 opencode CLI의 로컬
 * SQLite 로그에서 관측 스펜딩을 합산해 플랜 캡 대비 창을 만든다(opencode-go/usage-scan.ts).
 * 로컬 데이터가 없거나 읽기 실패하면 창 없는 ok로 강등하고, 클라이언트가 그 상태를
 * 안내로 그린다. 가짜 창은 합성하지 않는다.
 */
export async function fetchOpencodeUsage(deps: ProviderDeps = {}): Promise<ProviderResult> {
  if (deps.authService === undefined) {
    throw new Error("authService is required to probe OpenCode Go usage; pass it via createAiGatewayQuotaCollectors");
  }
  const apiKey = await deps.authService.getApiKey(OPENCODE_AUTH_PROVIDER_ID);
  if (!apiKey) return { status: "signed_out" };
  const now = deps.now ?? Date.now;
  try {
    const scan = await (deps.scanOpencodeGoWindows ?? (() => scanOpencodeGoWindows({ now })))();
    if (scan !== null) {
      return {
        status: "ok",
        plan: "Go",
        cycleDays: scan.cycleDays,
        windows: scan.windows,
        fetchedAt: now(),
      };
    }
  } catch {
    // DB가 존재하는데 읽지 못했다 — 0 사용량으로 오독하느니 창 없는 상태로 강등한다.
  }
  return {
    status: "ok",
    plan: "Go",
    windows: [],
    fetchedAt: now(),
  };
}
