import type { OperationLaunchKind, OperationLaunchVariantGroup } from "@fleet-console/sdk/operations";
import {
  CLAUDE_COMPAT_CONTEXT_WINDOW,
  CLAUDE_DEFAULT_CONTEXT_WINDOW,
  type AiGatewaySelection,
} from "@fleet-console/ai-gateway";
import { NATIVE_CLAUDE_EFFORTS, NATIVE_CLAUDE_MODEL_ALIASES } from "@fleet-console/agent-runtime/fleet";

import { buildModelRoster, EFFORT_LABELS, modelRosterGroupId, ULTRACODE_LAUNCH_EFFORT } from "../../../ai-gateway/host/model-roster.js";
import type { AgentCliLaunchMetadata } from "./agent-cli-launch-metadata.js";

export { EFFORT_LABELS } from "../../../ai-gateway/host/model-roster.js";

/** 게이트 뒤에 숨는 apex 티어 — 일상 다이얼은 xhigh에서 닫고, 이 단들은 트랙의 확장 제스처가 연다. */
const APEX_EFFORTS = ["max", "ultra"] as const;

/** 런치 메뉴의 모델 어휘 원본 — 같은 세션을 두 표면이 다른 이름으로 부르지 않게 하는 자리다. */
export const NATIVE_MODEL_LABELS: Readonly<Record<(typeof NATIVE_CLAUDE_MODEL_ALIASES)[number], string>> = {
  // Claude Code's 1M coordinates stay under their plain menu labels.
  "fable[1m]": "Fable",
  "opus[1m]": "Opus",
  sonnet: "Sonnet",
};

export function buildAgentCliLaunchKinds(
  metadata: readonly AgentCliLaunchMetadata[],
  operationType: string,
  gatewaySelection?: AiGatewaySelection,
): OperationLaunchKind[] {
  return metadata
    .map((cli) => {
      const disabledReason = resolveDisabledReason(cli);
      return {
        id: cli.id,
        type: operationType,
        title: cli.label,
        ...(disabledReason
          ? { disabled: true, disabledReason }
          : cli.id === "claude"
            ? {
              variants: buildClaudeLaunchVariants(gatewaySelection),
              // 채팅으로 태어나는 길은 SDK 인수 계약 위에 서므로 Claude Gateway 종류에서만 열린다
              // (전환 경로의 `chat_unsupported`와 같은 판정). 다른 종류는 선언하지 않으므로
              // 컴포저의 시작 뷰 선택 자체가 서지 않는다.
              launchViews: ["terminal", "chat"] as const,
            }
            : {}),
      };
    });
}

function buildClaudeLaunchVariants(selection?: AiGatewaySelection): readonly OperationLaunchVariantGroup[] {
  const native: OperationLaunchVariantGroup = {
    id: "native",
    label: "Claude",
    rows: NATIVE_CLAUDE_MODEL_ALIASES.map((model) => ({
      id: model,
      label: NATIVE_MODEL_LABELS[model],
      launch: { model },
      // Claude Code의 두 좌표다 — `[1m]` 표기가 1M 창을 켠다.
      contextWindow: model.endsWith("[1m]") ? CLAUDE_COMPAT_CONTEXT_WINDOW : CLAUDE_DEFAULT_CONTEXT_WINDOW,
      effortAxis: EFFORT_AXIS,
      gatedEfforts: APEX_EFFORTS,
      // 네이티브 행은 max·ultra를 항상 노출한다 — ultracode는 모델 사다리의 단이 아니라
      // 하네스 능력(standing orchestration)이라 Claude native에서 모델 독립이다.
      // spawn은 launch factory가 `--effort ultracode`로 전달한다.
      chips: EFFORT_AXIS.map((effort) => ({
        id: effort,
        label: EFFORT_LABELS[effort]!,
        launch: { model, effort },
      })),
    })),
  };
  if (!selection || selection.models.length === 0) return [native];
  // Gateway 밴드는 모델 로스터의 launch 투영 그대로다. Claude 카탈로그는 위임 후보이며, 호스트에는 기존 네이티브 행만 노출한다.
  return [native, ...buildModelRoster(selection, "launch").filter((group) => group.id !== modelRosterGroupId("claude"))];
}

// 네이티브 행의 강도 축 — 일상 단 전부에 하네스 능력인 ultra가 끝에 선다.
const EFFORT_AXIS = [...NATIVE_CLAUDE_EFFORTS, ULTRACODE_LAUNCH_EFFORT] as const;

function resolveDisabledReason(cli: AgentCliLaunchMetadata): string | undefined {
  if (!cli.available) return "Not installed";
  if (!cli.signedIn) return "Sign in required";
  return undefined;
}
