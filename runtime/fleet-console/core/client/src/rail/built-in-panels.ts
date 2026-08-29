import type { RailPanelDescriptor } from "@fleet-console/sdk/rail";

// Codex가 플러그인으로 나가면서 코어가 소유한 rail 패널은 없다. 목록은 남긴다 —
// 코어가 다시 패널을 갖게 될 때 합성 순서(코어 먼저)가 이미 자리를 잡고 있어야 한다.
export const BUILT_IN_RAIL_PANELS: readonly RailPanelDescriptor[] = [];
