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

const AUTH_HELP_TEXT = `fleet gateway auth — AI Gateway provider authentication

Usage:
  fleet gateway auth login [opencode|typesafe]
  fleet gateway auth list
  fleet gateway auth logout [opencode|typesafe|kimi]

The retired kimi provider supports logout only to remove its stored key.

Codex, Cursor, and xAI use their own subscription credentials.
Run fleet gateway status to see whether each one was found.

TypeSafe holds no routable model: its key lets Console features ask Jev
for structured decisions, and signing out only disables those features.
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

  io.stderr.write(`Unknown fleet gateway auth command: ${command}\n`);
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
  // 제거된 공급자의 저장 키는 자동 삭제하지 않되 명시적 로그아웃은 유지한다.
  if (argv[0] === "kimi") {
    await deps.authService.deleteApiKey("Claude Code with Moonshot Kimi");
    io.stdout.write("Stored Moonshot-Kimi key removed.\n");
    return 0;
  }
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
