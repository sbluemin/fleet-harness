import { EMBEDDED_AGENT_CLI_HOOK_ASSETS } from "../assets.generated.js";
import { EXECUTION_CONTRACT_PLACEHOLDER, FLEET_EXECUTION_CONTRACT } from "../execution-contract.js";
import { FLEET_PLUGIN_NAME } from "../types.js";
import type { FleetHookExec } from "../types.js";
import type { AssetPluginBundle, CreateAgentCliPluginOptions } from "../types.js";

export const assetBundle: AssetPluginBundle = {
  description: "Fleet gateway identities and lifecycle hooks",
  directoryName: "fleet-gateway",
  displayName: "Fleet",
  name: FLEET_PLUGIN_NAME,
  source: "asset",
};

const COMPACT_EVENT_SCRIPT_NAME = "fleet-compact-event.mjs";
/**
 * 라우팅 Mod. hooks.json의 `modules`가 이 파일을 지목하면 Claude Code가 함수 훅 모듈로
 * 싣는다. 명령 훅(.mjs)과 달리 세션 안에서 돌며 `agent.spawn`을 가로채고 판을 그린다.
 */
const ROUTING_MOD_SCRIPT_NAME = "fleet-routing-mod.tsx";

/** zip에 들어갈 파일 하나. relativePath는 `/` 구분의 플러그인 루트 상대 경로다. */
export interface AssetPluginFile {
  readonly relativePath: string;
  readonly content: string;
}

/**
 * 플러그인의 전체 파일 집합을 메모리에서 조립한다. 디스크에는 아무것도 쓰지 않는다 —
 * 호스트가 이 목록을 기동에 한 번 zip으로 묶어 루프백으로 내준다.
 */
export function buildAssetPluginFiles(
  bundle: AssetPluginBundle,
  options: CreateAgentCliPluginOptions,
  version: string,
): readonly AssetPluginFile[] {
  const files: AssetPluginFile[] = [];
  files.push({ relativePath: ".claude-plugin/plugin.json", content: toJsonContent(claudeManifest(bundle, version)) });
  const compactAsset = EMBEDDED_AGENT_CLI_HOOK_ASSETS.find((entry) => entry.relativePath === COMPACT_EVENT_SCRIPT_NAME);
  if (!compactAsset) throw new Error(`Missing embedded ${COMPACT_EVENT_SCRIPT_NAME} hook asset`);
  files.push({ relativePath: `hooks/${COMPACT_EVENT_SCRIPT_NAME}`, content: compactAsset.content });
  files.push({ relativePath: `hooks/${ROUTING_MOD_SCRIPT_NAME}`, content: routingModSource() });
  files.push({ relativePath: "hooks/hooks.json", content: toJsonContent(claudeHooks(options, version)) });
  return files;
}

function toJsonContent(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * 라우팅 Mod 원본. 치환하는 것은 **실행 계약 하나뿐**이다.
 *
 * zip은 호스트 기동에 한 번 묶이고, 세션은 시작할 때 받아 둔 사본으로 끝까지 돈다. 그래서
 * 노출 목록이나 배정 판정처럼 세션 중에 변하는 것은 절대 굽지 않는다 — 구우면 세션 수명 내내
 * 낡은 값이 남는다. 그쪽은 Mod가 배정할 때마다 Console에 묻는다.
 *
 * 실행 계약은 반대다. Fleet 버전당 상수라 릴리스에서만 바뀌고, 그때는 어차피 호스트가 새로
 * 떠서 zip을 다시 묶는다. 굽는 비용이 없으므로 세션마다 물어볼 이유도 없다.
 */
function routingModSource(): string {
  const asset = EMBEDDED_AGENT_CLI_HOOK_ASSETS.find((entry) => entry.relativePath === ROUTING_MOD_SCRIPT_NAME);
  if (!asset) throw new Error(`Missing embedded ${ROUTING_MOD_SCRIPT_NAME} hook asset`);
  const placeholder = JSON.stringify(EXECUTION_CONTRACT_PLACEHOLDER);
  if (!asset.content.includes(placeholder)) {
    throw new Error(`${ROUTING_MOD_SCRIPT_NAME} carries no execution contract placeholder`);
  }
  return asset.content.replace(placeholder, JSON.stringify(FLEET_EXECUTION_CONTRACT));
}

/**
 * 세션 시작에 렌더된 플러그인 버전을 문맥으로 올리는 훅. 스크립트 자산을 렌더하지 않고
 * hooks.json이 답을 직접 들고 있다 — 판정할 입력이 없고 출력이 렌더 시점에 이미 정해진
 * 상수라, 파일 하나를 zip에 싣고 그것을 읽어 실행할 이유가 없다.
 *
 * 응답 본문은 인자로 넘긴다. `-e` 코드에 끼워 넣으면 버전 문자열이 JS 소스가 되므로,
 * 코드는 고정하고 페이로드는 argv로만 흐르게 한다. exec 형식이라 셸 토크나이징도 없다.
 */
function pluginVersionHook(version: string): FleetHookExec {
  const response = JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `Fleet plugin version: ${version}` },
  });
  return {
    command: process.execPath,
    args: ["-e", "process.stdout.write(process.argv[1])", response],
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
  return {
    // 함수 훅 모듈(Mod). 명령 훅과 같은 파일이 선언하지만 다른 표면이다 — 이쪽은 세션
    // 안에서 돌며 이벤트를 가로채고 화면을 그린다.
    modules: [`./${ROUTING_MOD_SCRIPT_NAME}`],
    hooks: {
      SessionStart: [{
        hooks: [claudeCommandHook(pluginVersionHook(version))],
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
