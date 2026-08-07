import type { AdmiralDoctrine } from "./protocols/doctrine.js";

export const FLEET_MCP_SERVER_NAME = "fleet";

/** 해당 doctrine 호스트 세션이 이 도구를 받아야 하는지 판정한다. */
export function isHostSessionToolAllowed(toolId: string, doctrine: AdmiralDoctrine): boolean {
  // Native는 Admiral 프롬프트 없이 위키 MCP만 싣는다. gateway는 등록된 도구를 모두 받는다.
  return doctrine === "native" ? toolId.startsWith("wiki_") : true;
}
