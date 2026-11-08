import { cancel, isCancel, select } from "@clack/prompts";

import {
  AUTH_CLI_DEFINITIONS,
  getAuthCliOptions,
  parseAuthCliId,
  resolveAuthCliId,
  runAuthLoginFlow,
  type AuthCommandDeps,
  type AuthCommandIo,
} from "./login-flow.js";

export async function dispatchAuthCommand(
  argv: readonly string[],
  io: AuthCommandIo,
  deps: AuthCommandDeps,
): Promise<number> {
  const command = argv[1];
  if (command === "login") return runAuthLoginFlow(argv.slice(2), io, deps);
  if (command === "logout") return logoutAuthProvider(argv.slice(2), io, deps);

  io.stderr.write(`Unknown authentication command: ${command ?? ""}\n`);
  return 1;
}

async function logoutAuthProvider(
  argv: readonly string[],
  io: AuthCommandIo,
  deps: AuthCommandDeps,
): Promise<number> {
  const selectedCli = resolveAuthCliId(argv[0], io);
  if (selectedCli === "invalid") return 1;
  const chosen = selectedCli ?? await promptForLogoutCli();
  if (!chosen) {
    cancel("Authentication cancelled.");
    return 1;
  }
  const definition = AUTH_CLI_DEFINITIONS[chosen];
  await deps.authService.deleteApiKey(definition.providerId);
  io.stdout.write(`${definition.label} signed out.\n`);
  return 0;
}

async function promptForLogoutCli(): Promise<ReturnType<typeof parseAuthCliId>> {
  const selected = await select({
    message: "Select an authentication provider",
    options: getAuthCliOptions().map((value) => ({ value, label: AUTH_CLI_DEFINITIONS[value].label })),
  });
  return isCancel(selected) ? undefined : parseAuthCliId(String(selected));
}
