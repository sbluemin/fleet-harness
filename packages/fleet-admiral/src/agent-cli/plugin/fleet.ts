import { EMBEDDED_AGENT_CLI_HOOK_ASSETS } from "../assets.generated.js";
import { buildGatewayAgentFiles, FLEET_PLUGIN_NAME } from "../gateway-agents.js";
import type { FleetHookExec } from "../types.js";
import type { AssetPluginBundle, CreateAgentCliPluginOptions } from "../types.js";

export const assetBundle: AssetPluginBundle = {
  description: "Fleet gateway identities and lifecycle hooks",
  directoryName: "fleet-gateway",
  displayName: "Fleet",
  name: FLEET_PLUGIN_NAME,
  source: "asset",
};

const MODEL_GUARD_SCRIPT_NAME = "fleet-gateway-model-guard.mjs";
const COMPACT_EVENT_SCRIPT_NAME = "fleet-compact-event.mjs";

/** 스냅숏에 들어갈 파일 하나. relativePath는 `/` 구분의 스냅숏 루트 상대 경로다. */
export interface AssetPluginFile {
  readonly relativePath: string;
  readonly content: string;
}

/**
 * 플러그인 스냅숏의 전체 파일 집합을 메모리에서 조립한다. 디스크에는 아무것도 쓰지 않는다 —
 * 이 목록이 곧 스냅숏의 내용 정체성(해시 입력)이고, 발행 여부는 그 해시가 결정한다.
 */
export function buildAssetPluginFiles(
  bundle: AssetPluginBundle,
  options: CreateAgentCliPluginOptions,
  version: string,
): readonly AssetPluginFile[] {
  const files: AssetPluginFile[] = [];
  files.push({ relativePath: ".claude-plugin/plugin.json", content: toJsonContent(claudeManifest(bundle, version)) });
  const guardAsset = EMBEDDED_AGENT_CLI_HOOK_ASSETS.find((entry) => entry.relativePath === MODEL_GUARD_SCRIPT_NAME);
  if (!guardAsset) throw new Error(`Missing embedded ${MODEL_GUARD_SCRIPT_NAME} hook asset`);
  files.push({ relativePath: `hooks/${MODEL_GUARD_SCRIPT_NAME}`, content: guardAsset.content });
  const compactAsset = EMBEDDED_AGENT_CLI_HOOK_ASSETS.find((entry) => entry.relativePath === COMPACT_EVENT_SCRIPT_NAME);
  if (!compactAsset) throw new Error(`Missing embedded ${COMPACT_EVENT_SCRIPT_NAME} hook asset`);
  files.push({ relativePath: `hooks/${COMPACT_EVENT_SCRIPT_NAME}`, content: compactAsset.content });
  files.push({ relativePath: "hooks/hooks.json", content: toJsonContent(claudeHooks(options, version)) });
  for (const file of buildGatewayAgentFiles(options.gatewayDelegationModels ?? [], options.gatewayEffortExposure)) {
    files.push({ relativePath: `agents/${file.fileName}`, content: file.content });
  }
  return files;
}

function toJsonContent(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * 모델 가드 훅 실행 사양. 스냅숏은 내용 해시가 이름인 디렉터리로 발행되므로 절대 경로를
 * 남기지 않고 `${CLAUDE_PLUGIN_ROOT}` 플레이스홀더를 쓴다 — 훅 실행 시점에 그 세션이
 * 런치한 스냅숏 루트로 치환된다. command는 런처의 다른 훅과 동일하게 절대 node 경로다.
 */
function modelGuardHook(subcommand: string, ...args: readonly string[]): FleetHookExec {
  return {
    command: process.execPath,
    args: [`\${CLAUDE_PLUGIN_ROOT}/hooks/${MODEL_GUARD_SCRIPT_NAME}`, subcommand, ...args],
  };
}

function compactEventHook(): FleetHookExec {
  return {
    command: process.execPath,
    args: [`\${CLAUDE_PLUGIN_ROOT}/hooks/${COMPACT_EVENT_SCRIPT_NAME}`],
  };
}

function claudeHooks(options: CreateAgentCliPluginOptions, version: string): unknown {
  // 세션 캡처·턴 신호만 주입한다. 라우팅 지침은 Gateway MCP가 소유한다.
  const userPromptSubmitExecs = [
    options.captureSessionHookExec,
    options.turnStartHookExec,
    options.autoNameHookExec,
  ].filter((exec): exec is FleetHookExec => exec !== undefined);
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
  const preToolUse = inputWaitingExec
    ? [{ matcher: "AskUserQuestion", hooks: [claudeCommandHook(inputWaitingExec)] }]
    : [];
  const postToolUse = [{
    // 즉시 반환된 Workflow run id를 결과로 읽는 사고를 그 자리에서 막는다.
    matcher: "Workflow",
    hooks: [claudeCommandHook(modelGuardHook("workflow-receipt"))],
  }];
  return {
    hooks: {
      SessionStart: [{
        hooks: [claudeCommandHook(modelGuardHook("plugin-version", version))],
      }],
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
      PostToolUse: postToolUse,
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
      PreCompact: [{
        matcher: "manual|auto",
        hooks: [claudeCommandHook(compactEventHook())],
      }],
      PostCompact: [{
        matcher: "manual|auto",
        hooks: [claudeCommandHook(compactEventHook())],
      }],
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

function claudeManifest(bundle: AssetPluginBundle, version: string): unknown {
  return {
    name: bundle.name,
    version,
    description: bundle.description,
  };
}
