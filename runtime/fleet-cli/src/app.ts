import { launchClaudeGateway } from "./gateway/launch.js";
import { startGatewayHttpServer } from "./gateway/server.js";
import { createFleetCliRuntime } from "./runtime/runtime.js";

export interface RunAppOptions {
  readonly passthroughArgs?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export async function runApp(options: RunAppOptions = {}): Promise<void> {
  const runtime = await createFleetCliRuntime();
  let gatewayServer;
  try {
    gatewayServer = await startGatewayHttpServer({
      store: runtime.aiGatewayStore,
      authService: runtime.infraServices.authService,
    });
  } catch (error) {
    await runtime.cleanup();
    throw error;
  }
  await launchClaudeGateway({
    runtime,
    gatewayServer,
    passthroughArgs: options.passthroughArgs ?? [],
    cwd: options.cwd ?? resolveInvocationCwd(),
    env: options.env ?? process.env,
    dataDir: runtime.dataDir,
  });
}

function resolveInvocationCwd(): string {
  return process.env.INIT_CWD || process.cwd();
}
