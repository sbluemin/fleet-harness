/**
 * protocols/index — Protocol 레지스트리
 *
 * 등록된 모든 Protocol을 관리하고, 활성 프로토콜 상태를 제어한다.
 * 새 Protocol 추가 시 여기에 import 1줄 + PROTOCOLS 배열에 1줄만 추가하면 된다.
 */

import type { AdmiralProtocol } from "./types.js";

import { getSettingsService } from "@sbluemin/fleet-infra/settings";
import { FLEET_ACTION } from "./fleet-action.js";
import * as standingOrders from "./standing-orders/index.js";
export { standingOrders };
export {
  buildCompletionReportRequestPrompt,
  COMPLETION_REPORT_REQUEST_PROMPT,
} from "./completion-report.js";

// ─────────────────────────────────────────────────────────
// 타입
// ─────────────────────────────────────────────────────────

/** admiral 프로토콜 설정 */
interface ProtocolSettings {
  activeProtocol?: string;
}

// ─────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────

/** 등록된 Protocols — slot 순서대로 나열 */
const PROTOCOLS: readonly AdmiralProtocol[] = [
  FLEET_ACTION,
];

/** 초기 부팅 시 기본 활성 프로토콜 ID */
const DEFAULT_ACTIVE_PROTOCOL_ID = "fleet-action";

export const protocols = {
  standingOrders,
  getAllProtocols,
  getActiveProtocol,
  setActiveProtocol,
};

// ─────────────────────────────────────────────────────────
// 함수
// ─────────────────────────────────────────────────────────

/** 등록된 모든 Protocol을 slot 순서대로 반환한다. */
export function getAllProtocols(): readonly AdmiralProtocol[] {
  return PROTOCOLS;
}

/** 현재 활성 프로토콜을 반환한다. 항상 유효한 프로토콜을 반환한다. */
export function getActiveProtocol(): AdmiralProtocol {
  const api = getSettingsService();
  if (!api) return getProtocolById(DEFAULT_ACTIVE_PROTOCOL_ID) ?? FLEET_ACTION;

  const cfg = api.load<ProtocolSettings>("admiral");
  const id = cfg.activeProtocol ?? DEFAULT_ACTIVE_PROTOCOL_ID;
  return getProtocolById(id) ?? FLEET_ACTION;
}

/** 활성 프로토콜을 변경한다. */
export function setActiveProtocol(protocolId: string): void {
  const api = getSettingsService();
  if (!api) return;
  const cfg = api.load<ProtocolSettings>("admiral");
  api.save("admiral", { ...cfg, activeProtocol: protocolId });
}

/** ID로 Protocol을 조회한다. */
function getProtocolById(id: string): AdmiralProtocol | undefined {
  return PROTOCOLS.find((p) => p.id === id);
}
