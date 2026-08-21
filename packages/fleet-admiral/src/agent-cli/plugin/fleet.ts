import path from "node:path";

import { EMBEDDED_AGENT_CLI_HOOK_ASSETS, EMBEDDED_AGENT_CLI_SKILL_ASSETS } from "../assets.generated.js";
import { buildGatewayAgentFiles, FLEET_PLUGIN_NAME } from "../gateway-agents.js";
import { writePrivateFile, writePrivateJson } from "./fs.js";
import type { FleetHookExec } from "../types.js";
import type { AssetPluginBundle, CreateAgentCliPluginOptions } from "../types.js";

export const ASSET_PLUGIN_DIRECTORY_NAMES = ["fleet-gateway"] as const;

export const assetBundle: AssetPluginBundle = {
  description: "Fleet gateway identities, on-demand skills, and delegation policy hooks",
  directoryName: "fleet-gateway",
  displayName: "Fleet",
  name: FLEET_PLUGIN_NAME,
  source: "asset",
};

const MODEL_GUARD_SCRIPT_NAME = "fleet-gateway-model-guard.mjs";

export function resolveAssetPluginDirectoryName(): string {
  return "fleet-gateway";
}

export function renderAssetPluginRoot(
  pluginRoot: string,
  bundle: AssetPluginBundle,
  options: CreateAgentCliPluginOptions,
): void {
  renderEmbeddedSkillAssets(pluginRoot);
  const modelGuardScriptPath = writeModelGuardScript(pluginRoot);
  writePrivateJson(path.join(pluginRoot, "hooks", "hooks.json"), claudeHooks(options, modelGuardScriptPath), pluginRoot);
  // 게이트웨이 정체성과 온디맨드 스킬은 이 플러그인이 싣는다. 렌더는 스테이징
  // 디렉터리에 전부 쓰고 한 번에 rename하므로, 노출 목록이 줄어든 세션에서 옛 자산이
  // 남을 수 없다.
  renderGatewayAgentAssets(pluginRoot, options);
}

function renderEmbeddedSkillAssets(pluginRoot: string): void {
  for (const asset of EMBEDDED_AGENT_CLI_SKILL_ASSETS) {
    writePrivateFile(path.join(pluginRoot, "skills", asset.relativePath), asset.content, pluginRoot);
  }
}

function renderGatewayAgentAssets(pluginRoot: string, options: CreateAgentCliPluginOptions): void {
  for (const file of buildGatewayAgentFiles(options.gatewayDelegationModels ?? [], options.gatewayEffortExposure)) {
    writePrivateFile(path.join(pluginRoot, "agents", file.fileName), file.content, pluginRoot);
  }
}

function writeModelGuardScript(pluginRoot: string): string {
  const asset = EMBEDDED_AGENT_CLI_HOOK_ASSETS.find((entry) => entry.relativePath === MODEL_GUARD_SCRIPT_NAME);
  if (!asset) throw new Error(`Missing embedded ${MODEL_GUARD_SCRIPT_NAME} hook asset`);
  const scriptPath = path.join(pluginRoot, "hooks", MODEL_GUARD_SCRIPT_NAME);
  writePrivateFile(scriptPath, asset.content, pluginRoot);
  return scriptPath;
}

/**
 * 모델 가드 훅 실행 사양. 플러그인 루트는 렌더 시 스테이징 디렉터리에 쓰였다가 rename되므로
 * 절대 경로를 남기지 않고 `${CLAUDE_PLUGIN_ROOT}` 플레이스홀더를 쓴다 — 훅 실행 시점에 실제
 * 루트로 치환된다. command는 런처의 다른 훅과 동일하게 절대 node 경로다.
 */
function modelGuardHook(subcommand: string, routingNonce?: string): FleetHookExec {
  return {
    command: process.execPath,
    args: [
      `\${CLAUDE_PLUGIN_ROOT}/hooks/${MODEL_GUARD_SCRIPT_NAME}`,
      subcommand,
      ...(routingNonce ? [routingNonce] : []),
    ],
  };
}

function claudeHooks(options: CreateAgentCliPluginOptions, modelGuardScriptPath?: string): unknown {
  // UserPromptSubmit: 세션 캡처 → 턴 시작 → 자동 작명 순서로 같은 이벤트에 렌더하고,
  // 위임·병렬 작업을 orchestration 스킬로 보내는 트립와이어를 그 뒤에 붙인다. 스킬은
  // 의미 정책만 소유하고, 완료 뒤 PostToolUse가 실시간 로스터와 핀 문법을 별도 주입한다.
  const userPromptSubmitExecs = [options.captureSessionHookExec, options.turnStartHookExec, options.autoNameHookExec]
    .filter((exec): exec is FleetHookExec => exec !== undefined);
  if (modelGuardScriptPath) userPromptSubmitExecs.push(modelGuardHook("remind"));
  // Stop: 턴 종료 신호. 살아 있는 백그라운드 작업 목록은 같은 payload에 실려 오므로 별도 hook을 걸지 않고
  // 턴 종료 hook이 함께 실어 나른다 — 한 이벤트에 두 hook을 걸면 둘이 병렬로 떠서 턴 종료가 먼저 도착하고,
  // 그 찰나에 세션이 거짓 유휴로 보여 종료 알림과 도착 표시가 튄다.
  const stopExecs = [options.turnEndHookExec]
    .filter((exec): exec is FleetHookExec => exec !== undefined);
  // 입력 대기 신호: AskUserQuestion은 PreToolUse(matcher=AskUserQuestion)와
  // permission_prompt Notification을 모두 발화한다. 그 외 입력 대기도 Notification의 입력 대기 타입만 |-구분 정확 매처로 거른다
  // (idle_prompt(정상 유휴 대기, 차단 아님)·auth_success·elicitation_complete/response 등 비대기 타입 제외).
  // 한 번의 대기가 PreToolUse와 Notification 두 경로로 동시에 들어올 수 있어, 최종 중복 제거는 클라이언트(store)에서 세션별로 한다.
  const inputWaitingExec = options.inputWaitingHookExec;
  const routingNonce = options.gatewayRoutingNonce;
  const preToolUse = [
    ...(inputWaitingExec
      ? [{ matcher: "AskUserQuestion", hooks: [claudeCommandHook(inputWaitingExec)] }]
      : []),
    ...(modelGuardScriptPath
      ? [
          {
            // 같은 prompt에서 orchestration을 다시 실행하면 앞선 성공 receipt를 먼저 폐기한다.
            // 그래야 두 번째 MCP refresh 실패가 첫 로스터로 조용히 열리지 않는다.
            matcher: "Skill",
            hooks: [{
              ...claudeCommandHook(modelGuardHook("begin-orchestration", routingNonce)),
              if: "Skill(fleet:orchestration)",
            }],
          },
          {
            // 위임 게이트: 백그라운드 카운팅 신호가 아니라 정책 게이트다. 핀되지 않은 위임을
            // 실행 전에 차단하고, 어떻게 핀하는지를 차단 사유로 알린다. 호스트로는 어떤 신호도
            // 보내지 않는다.
            matcher: "Agent|Workflow",
            hooks: [claudeCommandHook(modelGuardHook("gate-delegation", routingNonce))],
          },
        ]
      : []),
  ];
  // orchestration은 의미 정책만 싣는다. 성공 직후 이미 연결된 Fleet MCP에서 로스터를 다시 읽어
  // Fleet 전용 핀 문법과 함께 문맥에 넣고, 같은 성공 응답만 private receipt를 만든다. MCP 오류는
  // Claude Code에서 non-blocking이므로 PreToolUse는 receipt 없이는 gateway 위임을 fail-closed한다.
  const postToolUse = modelGuardScriptPath
    ? [
        {
          matcher: "Skill",
          hooks: [{
            type: "mcp_tool",
            if: "Skill(fleet:orchestration)",
            server: "fleet",
            tool: "gateway_models",
            input: {
              hookEventName: "PostToolUse",
              sessionId: "${session_id}",
              promptId: "${prompt_id}",
              ...(routingNonce ? { routingNonce } : {}),
            },
            statusMessage: "Refreshing Fleet routing context",
          }],
        },
        {
          // 즉시 반환된 Workflow run id를 결과로 읽는 사고를 그 자리에서 막는다.
          matcher: "Workflow",
          hooks: [claudeCommandHook(modelGuardHook("workflow-receipt"))],
        },
      ]
    : [];
  const postToolUseFailure = modelGuardScriptPath
    ? [{
        matcher: "Skill",
        hooks: [{
          ...claudeCommandHook(modelGuardHook("orchestration-failed")),
          if: "Skill(fleet:orchestration)",
        }],
      }]
    : [];
  return {
    hooks: {
      ...(userPromptSubmitExecs.length > 0 ? {
        UserPromptSubmit: [{
          hooks: userPromptSubmitExecs.map(claudeCommandHook),
        }],
      } : {}),
      ...(stopExecs.length > 0 ? {
        Stop: [{
          hooks: stopExecs.map(claudeCommandHook),
        }],
      } : {}),
      ...(preToolUse.length > 0 ? { PreToolUse: preToolUse } : {}),
      ...(postToolUse.length > 0 ? { PostToolUse: postToolUse } : {}),
      ...(postToolUseFailure.length > 0 ? { PostToolUseFailure: postToolUseFailure } : {}),
      ...(modelGuardScriptPath && routingNonce ? {
        SessionEnd: [{
          hooks: [claudeCommandHook(modelGuardHook("cleanup-routing", routingNonce))],
        }],
      } : {}),
      ...(inputWaitingExec ? {
        Notification: [{
          matcher: "permission_prompt|elicitation_dialog",
          hooks: [claudeCommandHook(inputWaitingExec)],
        }],
      } : {}),
      ...(options.backgroundReportHookExec ? {
        SubagentStop: [{
          hooks: [claudeCommandHook(options.backgroundReportHookExec)],
        }],
      } : {}),
    },
  };
}

function claudeCommandHook(hookExec: FleetHookExec): {
  readonly args: string[];
  readonly command: string;
  readonly type: "command";
} {
  return {
    // exec 형식: command는 직접 spawn되는 실행 파일, args는 셸 토크나이징 없이 그대로 전달된다.
    // Windows cmd/powershell의 따옴표 규칙과 무관하게 동작하며 공백 포함 경로도 안전하다.
    args: [...hookExec.args],
    command: hookExec.command,
    type: "command",
  };
}
