import type { ExpandedSurfaceContext, ExpandedSurfaceDescriptor } from "@fleet-console/sdk/expanded-surface";

import { getT } from "./i18n/index.js";
import { RepositoryPanel } from "./rail-panel.js";
import { REPOSITORY_SURFACE_ID } from "./repository-context.js";

/**
 * 저장소 작업면 — 캔버스에 서는 한 덩어리.
 *
 * 레일 아이콘이 이 표면을 직접 여닫는다. 그래서 슬롯 머리의 닫기가 곧 아이콘을 다시 누른
 * 것과 같고, 그 사이 화면은 예전 레일 패널과 **같은 배치**를 유지한다 — 동사 줄 하나 위에
 * 소스 트리와 작업면 두 열, 그리고 그 둘 사이의 분할선.
 */
export const repositorySurface: ExpandedSurfaceDescriptor = {
  id: REPOSITORY_SURFACE_ID,
  title: (ctx) => getT(ctx.language ?? "en")("repository.panel.title"),
  // 트리 기본 폭(222px)과 작업면 독의 좌우 분할 최소치가 함께 들어가는 폭. 그보다 좁으면
  // 두 열이 아니라 한 줄이 되므로 분할선이 여기서 멈춘다.
  minSlotWidth: 620,
  render: (ctx) => <RepositorySurfaceBody ctx={ctx} />,
};

/**
 * 슬롯 본문은 가로 flex다 — 아무 말도 하지 않으면 이 화면이 내용 폭으로 서서 슬롯을 다 쓰지
 * 못한다. 자리를 채우는 규칙은 화면 자신이 아니라 그 화면을 슬롯에 앉히는 이 껍데기가 진다.
 */
function RepositorySurfaceBody({ ctx }: { readonly ctx: ExpandedSurfaceContext }) {
  return (
    <div className="repository-surface-body">
      <RepositoryPanel ctx={ctx} />
    </div>
  );
}
