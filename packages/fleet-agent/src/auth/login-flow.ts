import { cancel, isCancel, password, select } from "@clack/prompts";
import {
  AUTH_COMMAND_CANCELLED_MESSAGE,
  AUTH_LOGIN_PROVIDER_PROMPT_MESSAGE,
  AUTH_LOGIN_SECRET_PROMPT_MESSAGE,
  CLI_TO_AUTH_PROVIDER_ID,
  createAuthService,
  formatAuthLoginSuccessMessage,
  formatAuthMigrationNotice,
  formatAuthValidationFailureMessage,
  migrateLegacyAuthStore,
  validateAuthKeyForCli,
} from "@sbluemin/fleet-infra/auth";

import type { AuthCliId, AuthCommandIo } from "./types.js";

const AUTH_CLI_OPTIONS: Array<{ value: AuthCliId; label: string }> = [
  { value: "claude-zai", label: "Claude Code with Z.AI GLM" },
  { value: "claude-kimi", label: "Claude Code with Moonshot Kimi" },
];

export async function runAuthLoginFlow(
  argv: readonly string[],
  io: AuthCommandIo,
): Promise<number> {
  const selectedCli = parseAuthCliId(argv[0]) ?? await promptForCli();
  if (!selectedCli) return cancelAuthCommand();

  const apiKey = await password({
    message: AUTH_LOGIN_SECRET_PROMPT_MESSAGE,
    mask: "*",
  });
  if (isCancel(apiKey) || typeof apiKey !== "string" || apiKey.trim().length === 0) {
    return cancelAuthCommand();
  }

  const migration = await migrateLegacyAuthStore();
  if (migration.shouldPrintNotice) {
    io.stdout.write(`${formatAuthMigrationNotice(migration)}\n`);
  }

  const validation = await validateAuthKeyForCli(selectedCli, apiKey.trim());
  if (validation.status !== "success") {
    io.stderr.write(`${formatAuthValidationFailureMessage(validation)}\n`);
    return 1;
  }

  const providerId = CLI_TO_AUTH_PROVIDER_ID[selectedCli];
  if (!providerId) {
    io.stderr.write(`Auth provider not found for cli '${selectedCli}'. Use \`fleet auth login\` with a supported provider.\n`);
    return 1;
  }

  await createAuthService().setApiKey(providerId, apiKey.trim());
  io.stdout.write(`${formatAuthLoginSuccessMessage(providerId)}\n`);
  return 0;
}

export function getAuthCliOptions(): readonly AuthCliId[] {
  return AUTH_CLI_OPTIONS.map((option) => option.value);
}

export function parseAuthCliId(value: string | undefined): AuthCliId | undefined {
  if (value === "claude-zai" || value === "claude-kimi") return value;
  return undefined;
}

async function promptForCli(): Promise<AuthCliId | undefined> {
  const selected = await select<AuthCliId>({
    message: AUTH_LOGIN_PROVIDER_PROMPT_MESSAGE,
    options: AUTH_CLI_OPTIONS,
  });
  return isCancel(selected) ? undefined : selected;
}

function cancelAuthCommand(): number {
  cancel(AUTH_COMMAND_CANCELLED_MESSAGE);
  return 1;
}
