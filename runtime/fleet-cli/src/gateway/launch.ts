import { spawn } from "node:child_process";

import { resolveAiGatewaySelection } from "@dotobokuri/core-ai-gateway";
import {
  buildGatewaySystemPrompt,
  injectAgentCliProfile,
  prepareAiGatewayLaunchProfile,
  resolveAgentCliProfile,
} from "@dotobokuri/fleet-admiral";

import { withFleetMarketplaceLock } from "../runtime/host-hooks.js";
import type { FleetCliRuntime } from "../runtime/runtime.js";
import type { FleetCliGatewayServer } from "./server.js";

export interface LaunchClaudeGatewayOptions {
  readonly runtime: FleetCliRuntime;
  readonly gatewayServer: FleetCliGatewayServer;
  readonly passthroughArgs: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly dataDir: string;
}

export async function launchClaudeGateway(options: LaunchClaudeGatewayOptions): Promise<void> {
  const profileCleanups: Array<() => void | Promise<void>> = [];
  let resourcesCleaned = false;
  const cleanup = async () => {
    if (resourcesCleaned) return;
    resourcesCleaned = true;
    await cleanupResources(profileCleanups, options.gatewayServer, options.runtime);
  };
  try {
    let profile = await resolveAgentCliProfile(options.env, options.cwd, { cliId: "claude-gateway" });
    profile = { ...profile, args: [...profile.args, ...options.passthroughArgs] };
    const selection = resolveAiGatewaySelection(options.runtime.aiGatewayStore.read());
    const injected = await injectAgentCliProfile(profile, {
      buildSystemPrompt: () => buildGatewaySystemPrompt(),
      dataDir: options.dataDir,
      dedicatedMcpSession: options.runtime.dedicatedMcpSession,
      gatewayExposedModels: selection.models,
      gatewayEffortExposure: selection.effortExposure,
      withMarketplaceLock: withFleetMarketplaceLock,
      onCleanup: (cleanup) => profileCleanups.push(cleanup),
    });
    const launchProfile = prepareAiGatewayLaunchProfile(injected, {
      baseUrl: options.gatewayServer.origin() + options.gatewayServer.routePath,
      selection,
    });
    const child = spawn(launchProfile.bin, launchProfile.args, {
      cwd: launchProfile.cwd,
      env: launchProfile.env,
      stdio: "inherit",
    });

    // stdio inherit + 동일 포그라운드 프로세스 그룹: Ctrl+C의 SIGINT는 커널이 자식에게도
    // 직접 전달한다. 부모가 SIGINT를 재전달하면 자식이 이중 수신해 Claude Code의
    // "Ctrl+C 두 번 종료" 확인이 무력화되므로, 부모는 SIGINT를 무시하고 자식 종료만 기다린다.
    // SIGTERM/SIGHUP은 부모에게만 올 수 있으므로 1회 자식에게 전달한다.
    const ignoreSigint = () => {};
    const forwardedSignals = new Set<NodeJS.Signals>();
    const forwardSignal = (signal: NodeJS.Signals) => {
      if (forwardedSignals.has(signal)) return;
      forwardedSignals.add(signal);
      child.kill(signal);
    };
    const forwardSigterm = () => forwardSignal("SIGTERM");
    const forwardSighup = () => forwardSignal("SIGHUP");
    const removeSignalHandlers = () => {
      process.off("SIGINT", ignoreSigint);
      process.off("SIGTERM", forwardSigterm);
      process.off("SIGHUP", forwardSighup);
    };
    process.on("SIGINT", ignoreSigint);
    process.on("SIGTERM", forwardSigterm);
    process.on("SIGHUP", forwardSighup);

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        removeSignalHandlers();
        void cleanup().then(() => reject(error), reject);
      };
      child.once("error", onError);
      child.once("exit", async (code, signal) => {
        child.off("error", onError);
        removeSignalHandlers();
        try {
          await cleanup();
        } catch (error) {
          reject(error);
          return;
        }
        if (signal) {
          process.kill(process.pid, signal);
          return;
        }
        process.exit(code ?? 0);
        resolve();
      });
    });
  } catch (error) {
    try {
      await cleanup();
    } catch {
      // 시작 실패의 정리 오류는 원래 실패 원인을 덮지 않는다.
    }
    throw error;
  }
}

async function cleanupResources(
  profileCleanups: readonly (() => void | Promise<void>)[],
  gatewayServer: FleetCliGatewayServer,
  runtime: FleetCliRuntime,
): Promise<void> {
  let cleanupError: unknown;
  for (const cleanup of [...profileCleanups].reverse()) {
    try {
      await cleanup();
    } catch (error) {
      cleanupError ??= error;
    }
  }
  try {
    await gatewayServer.close();
  } catch (error) {
    cleanupError ??= error;
  }
  try {
    await runtime.cleanup();
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError !== undefined) throw cleanupError;
}
