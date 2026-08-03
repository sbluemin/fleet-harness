import { cancel, isCancel, select } from "@clack/prompts";

import { AUTH_CLI_DEFINITIONS, getAuthCliOptions, parseAuthCliId, runAuthLoginFlow } from "./login-flow.js";
import type { AuthCommandDeps, AuthCommandIo } from "./types.js";

const AUTH_HELP_TEXT = `fleet auth — Authentication

Usage:
  fleet auth login [kimi|opencode]
  fleet auth list
  fleet auth logout [kimi|opencode]
`;

export async function dispatchAuthCommand(
  argv: readonly string[],
  io: AuthCommandIo,
  deps: AuthCommandDeps,
): Promise<number> {
  const command = argv[1];
  if (!command || command === "--help" || command === "-h") {
    io.stdout.write(AUTH_HELP_TEXT);
    return 0;
  }
  if (command === "login") return runAuthLoginFlow(argv.slice(2), io, deps);
  if (command === "list") return listAuthProviders(io, deps);
  if (command === "logout") return logoutAuthProvider(argv.slice(2), io, deps);

  io.stderr.write(`Unknown fleet auth command: ${command}\n`);
  io.stdout.write(AUTH_HELP_TEXT);
  return 1;
}

async function listAuthProviders(io: AuthCommandIo, deps: AuthCommandDeps): Promise<number> {
  const providerIds = await deps.authService.listProviderIds();
  if (providerIds.length === 0) {
    io.stdout.write("No stored authentication providers.\n");
    return 0;
  }
  for (const providerId of providerIds) io.stdout.write(`${providerId}\n`);
  return 0;
}

async function logoutAuthProvider(
  argv: readonly string[],
  io: AuthCommandIo,
  deps: AuthCommandDeps,
): Promise<number> {
  const selectedCli = parseAuthCliId(argv[0]) ?? await promptForLogoutCli();
  if (!selectedCli) {
    cancel("Authentication cancelled.");
    return 1;
  }
  const definition = AUTH_CLI_DEFINITIONS[selectedCli];
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
