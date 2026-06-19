import { cancel, isCancel, select } from "@clack/prompts";
import {
  AUTH_COMMAND_CANCELLED_MESSAGE,
  AUTH_LIST_EMPTY_MESSAGE,
  AUTH_LOGOUT_PROVIDER_PROMPT_MESSAGE,
  CLI_TO_AUTH_PROVIDER_ID,
  formatAuthLogoutSuccessMessage,
  formatAuthMigrationNotice,
  migrateLegacyAuthStore,
} from "@dotobokuri/fleet-infra/auth";

import { getAuthCliOptions, parseAuthCliId, runAuthLoginFlow } from "./login-flow.js";
import type { AuthCommandDeps, AuthCommandIo } from "./types.js";

const AUTH_HELP_TEXT = `fleet auth — Authentication

Usage:
  fleet auth login [claude-zai|claude-kimi|claude-glm]
  fleet auth list
  fleet auth logout [claude-zai|claude-kimi|claude-glm]
`;

// [MEDIUM #6] authService는 Composition Root에서 주입받는다 — per-call createAuthService 제거
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
  if (command === "login") {
    return runAuthLoginFlow(argv.slice(2), io, deps);
  }
  if (command === "list") {
    return listAuthProviders(io, deps);
  }
  if (command === "logout") {
    return logoutAuthProvider(argv.slice(2), io, deps);
  }

  io.stderr.write(`Unknown fleet auth command: ${command}\n`);
  io.stdout.write(AUTH_HELP_TEXT);
  return 1;
}

async function listAuthProviders(io: AuthCommandIo, deps: AuthCommandDeps): Promise<number> {
  const migration = await migrateLegacyAuthStore();
  if (migration.shouldPrintNotice) {
    io.stdout.write(`${formatAuthMigrationNotice(migration)}\n`);
  }

  const providerIds = await deps.authService.listProviderIds();
  if (providerIds.length === 0) {
    io.stdout.write(`${AUTH_LIST_EMPTY_MESSAGE}\n`);
    return 0;
  }

  for (const providerId of providerIds) {
    io.stdout.write(`${providerId}\n`);
  }
  return 0;
}

async function logoutAuthProvider(
  argv: readonly string[],
  io: AuthCommandIo,
  deps: AuthCommandDeps,
): Promise<number> {
  const selectedCli = parseAuthCliId(argv[0]) ?? await promptForLogoutCli();
  if (!selectedCli) {
    cancel(AUTH_COMMAND_CANCELLED_MESSAGE);
    return 1;
  }

  const migration = await migrateLegacyAuthStore();
  if (migration.shouldPrintNotice) {
    io.stdout.write(`${formatAuthMigrationNotice(migration)}\n`);
  }

  const providerId = CLI_TO_AUTH_PROVIDER_ID[selectedCli];
  if (!providerId) {
    io.stderr.write(`Auth provider not found for cli '${selectedCli}'. Use \`fleet auth logout\` with a supported provider.\n`);
    return 1;
  }

  await deps.authService.deleteApiKey(providerId);
  io.stdout.write(`${formatAuthLogoutSuccessMessage(providerId)}\n`);
  return 0;
}

async function promptForLogoutCli(): Promise<ReturnType<typeof parseAuthCliId>> {
  const selected = await select({
    message: AUTH_LOGOUT_PROVIDER_PROMPT_MESSAGE,
    options: getAuthCliOptions().map((value) => ({ value, label: value })),
  });
  return isCancel(selected) ? undefined : parseAuthCliId(String(selected));
}
