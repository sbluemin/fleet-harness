import { useConsoleLocale } from "../../../core/client/src/i18n/index.js";
import { registerContextRailProvider, type ContextRailProvider } from "../../workspace/client/conversation/context-rail/registry.js";
import type { ContextRailMeasure } from "../../workspace/shared/context-rail.js";
import type { CommodoreRunStatus } from "../shared/contracts/types.js";
import { COMMODORE_SURFACE_ID } from "./commodore-conversation.js";
import { useCommodoreName } from "./commodore-name.js";
import { useCommodore } from "./commodore-state.js";
import { getT } from "./i18n/index.js";

/**
 * 사령관 대화의 컨텍스트 레일 제공자. 사령관 상주 세션의 카드 한 장이고, 내용은 지휘관·구성원 원장과 같은 컨텍스트 창이다.
 * 사령관의 75% 요약·이어 가기 같은 내부 정책은 호스트가 그대로 쥐고 있고, 여기는 보이는 방식만 통일한다. 사령관 기록을 읽기 전용으로
 * 보는 목표 화면에서는 그리지 않는다.
 */
const CommodoreContextRail: ContextRailProvider = ({ scope, children }) => {
  const language = useConsoleLocale() === "ko" ? "ko" : "en";
  const commodoreId = scope.kind === "surface" && scope.surfaceId === COMMODORE_SURFACE_ID && scope.params.readOnly !== true && typeof scope.params.commodoreId === "string"
    ? scope.params.commodoreId
    : null;
  const { view } = useCommodore(commodoreId);
  const name = useCommodoreName(commodoreId ?? "", getT(language));
  if (commodoreId === null) return null;
  const measure = measureOf(view?.run?.context);
  // 사령관은 대화가 창의 일정 비율에 닿으면 요약해 같은 세션에서 이어 간다 — 그 정책은 그대로이고 꼬리 문구가 말한다.
  const footnote = measure?.compactAt !== undefined ? getT(language)("commodore.context.foot", { percent: Math.round((measure.compactAt / measure.max) * 100) }) : undefined;
  return <>{children([{ id: commodoreId, name, role: "commodore", measure, focus: true, ...(footnote ? { footnote } : {}) }])}</>;
};

/** 호스트가 알려 준 컨텍스트를 레일 카드의 측정으로. 내역을 얻지 못한 세션(Gateway 모델 등)은 총량만 그린다. */
export function measureOf(context: CommodoreRunStatus["context"]): ContextRailMeasure | null {
  if (!context || context.window <= 0 || context.inputTokens <= 0) return null;
  const detail = context.detail;
  return {
    occupied: context.inputTokens,
    max: context.window,
    ...(context.compactAt !== undefined ? { compactAt: context.compactAt } : {}),
    ...(detail?.reserved !== undefined ? { reserved: detail.reserved } : {}),
    slices: detail?.slices ?? [],
    memoryFiles: detail?.memoryFiles ?? [],
    mcpTools: detail?.mcpTools ?? [],
  };
}

export function registerCommodoreContextRail(): () => void {
  return registerContextRailProvider(CommodoreContextRail);
}
