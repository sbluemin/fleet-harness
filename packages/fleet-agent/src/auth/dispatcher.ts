import { cancel, isCancel, select } from "@clack/prompts";
import { infra } from "@sbluemin/fleet-core";

import { getAuthCliOptions, parseAuthCliId, runAuthLoginFlow } from "./login-flow.js";
import type { AuthCommandIo } from "./types.js";

export const AUTH_HELP_TEXT = `fleet auth — Fleet 인증 작전

Usage:
  fleet auth login [claude-zai|claude-kimi]
  fleet auth list
  fleet auth logout [claude-zai|claude-kimi]
`;

export async function dispatchAuthCommand(
  argv: readonly string[],
  io: AuthCommandIo,
): Promise<number> {
  const command = argv[1];
  if (!command || command === "--help" || command === "-h") {
    io.stdout.write(AUTH_HELP_TEXT);
    return 0;
  }
  if (command === "login") {
    return runAuthLoginFlow(argv.slice(2), io);
  }
  if (command === "list") {
    return listAuthProviders(io);
  }
  if (command === "logout") {
    return logoutAuthProvider(argv.slice(2), io);
  }

  io.stderr.write(`알 수 없는 fleet auth 명령입니다: ${command}\n`);
  io.stdout.write(AUTH_HELP_TEXT);
  return 1;
}

async function listAuthProviders(io: AuthCommandIo): Promise<number> {
  const migration = await infra.auth.migrateLegacyAuthStore();
  if (migration.shouldPrintNotice) {
    io.stdout.write(`${infra.auth.formatAuthMigrationNotice(migration)}\n`);
  }

  const providerIds = await infra.auth.createAuthService().listProviderIds();
  if (providerIds.length === 0) {
    io.stdout.write(`${infra.auth.AUTH_LIST_EMPTY_MESSAGE}\n`);
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
): Promise<number> {
  const selectedCli = parseAuthCliId(argv[0]) ?? await promptForLogoutCli();
  if (!selectedCli) {
    cancel(infra.auth.AUTH_COMMAND_CANCELLED_MESSAGE);
    return 1;
  }

  const migration = await infra.auth.migrateLegacyAuthStore();
  if (migration.shouldPrintNotice) {
    io.stdout.write(`${infra.auth.formatAuthMigrationNotice(migration)}\n`);
  }

  const providerId = infra.auth.CLI_TO_AUTH_PROVIDER_ID[selectedCli];
  if (!providerId) {
    io.stderr.write("해당 기함 인증 항로를 찾을 수 없습니다.\n");
    return 1;
  }

  await infra.auth.createAuthService().deleteApiKey(providerId);
  io.stdout.write(`${infra.auth.formatAuthLogoutSuccessMessage(providerId)}\n`);
  return 0;
}

async function promptForLogoutCli(): Promise<ReturnType<typeof parseAuthCliId>> {
  const selected = await select({
    message: infra.auth.AUTH_LOGOUT_PROVIDER_PROMPT_MESSAGE,
    options: getAuthCliOptions().map((value) => ({ value, label: value })),
  });
  return isCancel(selected) ? undefined : parseAuthCliId(String(selected));
}
