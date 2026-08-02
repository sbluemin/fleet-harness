import type { AdmiralDoctrine } from "../../protocols/doctrine.js";
import type { CodexCommandResult, CodexPluginRegistrationCommand, FleetHookExec } from "../types.js";
export type { CodexCommandResult, CodexPluginRegistrationCommand } from "../types.js";

export interface AgentCliPluginMarketplaceLock {
  <T>(target: string, fn: () => T | Promise<T>): T | Promise<T>;
}

export interface CodexCommandRunner {
  (command: CodexPluginRegistrationCommand): CodexCommandResult;
}

export interface CreateAgentCliPluginOptions {
  readonly captureSessionHookExec?: FleetHookExec;
  readonly cliId: string;
  readonly doctrine?: AdmiralDoctrine;
  readonly codexCommandRunner?: CodexCommandRunner;
  readonly cwd: string;
  readonly dataDir?: string;
  // 턴 시작(UserPromptSubmit)·턴 종료(Stop) 신호를 호스트로 알리는 hook. host가 빌드해 주입한다.
  readonly turnStartHookExec?: FleetHookExec;
  readonly turnEndHookExec?: FleetHookExec;
  // 입력 대기(AskUserQuestion의 PreToolUse · permission/idle/elicitation Notification) 신호를 호스트로
  // 알리는 hook. AskUserQuestion은 Notification 훅을 발화하지 않으므로 두 이벤트 경로로 건다. Claude 전용.
  readonly inputWaitingHookExec?: FleetHookExec;
  // 작전명 자동 작명(UserPromptSubmit)을 위해 prompt를 호스트로 전달하는 hook. Claude/Codex 양쪽에 와이어링된다.
  readonly autoNameHookExec?: FleetHookExec;
  readonly onCleanup?: (cleanup: () => void) => void;
  readonly rootDir?: string;
  readonly withMarketplaceLock: AgentCliPluginMarketplaceLock;
}

export interface CodexPluginRegistration {
  readonly contentHash: string;
  readonly hashPath: string;
  readonly marketplaceDir: string;
  readonly marketplaceName: string;
  readonly pluginName: string;
  readonly pluginRoot: string;
}

export interface AgentCliPlugin {
  readonly cleanup: () => void;
  readonly codexRegistrations: readonly CodexPluginRegistration[];
  readonly pluginRoot: string;
  readonly pluginRoots: readonly string[];
}

export interface PluginBundleBase {
  readonly description: string;
  readonly directoryName: string;
  readonly displayName: string;
  readonly hashFileName: string;
  readonly name: string;
}

export interface AssetPluginBundle extends PluginBundleBase {
  readonly source: "asset";
}

export interface MarketplaceTarget {
  readonly name: string;
  readonly root: string;
}

export interface RenderablePluginBundle {
  readonly bundle: PluginBundle;
  readonly target: MarketplaceTarget;
}

export type PluginBundle = AssetPluginBundle;
