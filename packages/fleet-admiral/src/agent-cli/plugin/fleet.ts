import path from "node:path";

import { resolveDoctrineFromCliId, type AdmiralDoctrine } from "../../protocols/doctrine.js";
import { EMBEDDED_AGENT_CLI_SKILL_ASSETS } from "../assets.generated.js";
import { writePrivateFile, writePrivateJson } from "./fs.js";
import type { FleetHookExec } from "../types.js";
import type { AssetPluginBundle, CreateAgentCliPluginOptions } from "../types.js";

/** Gateway and native asset roots must coexist under the same marketplace. */
export const ASSET_PLUGIN_DIRECTORY_NAMES = ["fleet-gateway", "fleet-native"] as const;

export const assetBundle: AssetPluginBundle = {
  description: "Fleet workflow orchestration and wiki evidence plugin",
  directoryName: "fleet-gateway",
  displayName: "Fleet",
  name: "fleet",
  source: "asset",
};

export function resolveAssetPluginDirectoryName(doctrine: AdmiralDoctrine): string {
  return doctrine === "native" ? "fleet-native" : "fleet-gateway";
}

export function renderAssetPluginRoot(
  pluginRoot: string,
  bundle: AssetPluginBundle,
  options: CreateAgentCliPluginOptions,
): void {
  const doctrine = options.doctrine ?? resolveDoctrineFromCliId(options.cliId);
  renderEmbeddedSkillAssets(pluginRoot, doctrine);
  if (options.cliId === "claude-native" || options.cliId === "claude-gateway") {
    writePrivateJson(path.join(pluginRoot, "hooks", "hooks.json"), claudeHooks(options), pluginRoot);
  }
}

function claudeHooks(options: CreateAgentCliPluginOptions): unknown {
  // UserPromptSubmit: 세션 캡처 → 턴 시작 → 자동 작명 순서로 같은 이벤트에 렌더한다.
  const userPromptSubmitExecs = [options.captureSessionHookExec, options.turnStartHookExec, options.autoNameHookExec]
    .filter((exec): exec is FleetHookExec => exec !== undefined);
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

function claudeCommandHook(hookExec: FleetHookExec): unknown {
  return {
    // exec 형식: command는 직접 spawn되는 실행 파일, args는 셸 토크나이징 없이 그대로 전달된다.
    // Windows cmd/powershell의 따옴표 규칙과 무관하게 동작하며 공백 포함 경로도 안전하다.
    args: [...hookExec.args],
    command: hookExec.command,
    type: "command",
  };
}

function renderEmbeddedSkillAssets(pluginRoot: string, doctrine: AdmiralDoctrine): void {
  for (const asset of selectSkillAssetsForDoctrine(doctrine)) {
    writePrivateFile(path.join(pluginRoot, "skills", asset.relativePath), asset.content, pluginRoot);
  }
}

function selectSkillAssetsForDoctrine(
  doctrine: AdmiralDoctrine,
): ReadonlyArray<{ readonly relativePath: string; readonly content: string }> {
  if (doctrine === "native") {
    // native는 wiki-operations만 렌더한다. Console 훅은 별도로 유지된다.
    return EMBEDDED_AGENT_CLI_SKILL_ASSETS.filter(
      (asset) => asset.relativePath.startsWith("wiki-operations/"),
    );
  }

  // gateway/<name>/SKILL.md는 접두를 벗겨 동일 이름의 base 자산을 대체한다.
  {
    const overlays = new Map<string, string>();
    for (const asset of EMBEDDED_AGENT_CLI_SKILL_ASSETS) {
      if (!asset.relativePath.startsWith("gateway/")) continue;
      overlays.set(asset.relativePath.slice("gateway/".length), asset.content);
    }
    const rendered: Array<{ relativePath: string; content: string }> = [];
    for (const asset of EMBEDDED_AGENT_CLI_SKILL_ASSETS) {
      if (asset.relativePath.startsWith("gateway/")) continue;
      rendered.push({
        relativePath: asset.relativePath,
        content: overlays.get(asset.relativePath) ?? asset.content,
      });
      overlays.delete(asset.relativePath);
    }
    for (const [relativePath, content] of overlays) {
      rendered.push({ content, relativePath });
    }
    return rendered;
  }
}
