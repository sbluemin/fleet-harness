import { cancel, isCancel, password, select } from "@clack/prompts";
import {
  CLI_TO_AUTH_PROVIDER_ID,
  validateAgentCliAuthKey,
} from "@dotobokuri/fleet-admiral";

import type { AuthCliId, AuthCommandDeps, AuthCommandIo } from "./types.js";

const AUTH_CLI_OPTIONS: readonly { readonly value: AuthCliId; readonly label: string }[] = [
  { value: "claude-kimi", label: "Kimi via Claude Code" },
];

export async function runAuthLoginFlow(
  argv: readonly string[],
  io: AuthCommandIo,
  deps: AuthCommandDeps,
): Promise<number> {
  const selectedCli = parseAuthCliId(argv[0]) ?? await promptForCli();
  if (!selectedCli) return cancelAuthCommand();

  const apiKey = await password({
    message: "Enter the Kimi API key",
    mask: "*",
  });
  if (isCancel(apiKey) || typeof apiKey !== "string" || apiKey.trim().length === 0) {
    return cancelAuthCommand();
  }

  const validation = await validateAgentCliAuthKey(selectedCli, apiKey.trim());
  if (validation.status !== "success") {
    io.stderr.write(`${formatValidationFailure(validation.status)}\n`);
    return 1;
  }

  const providerId = CLI_TO_AUTH_PROVIDER_ID[selectedCli];
  if (!providerId) {
    io.stderr.write(`Authentication is unavailable for '${selectedCli}'.\n`);
    return 1;
  }
  await deps.authService.setApiKey(providerId, apiKey.trim());
  io.stdout.write("Kimi via Claude Code signed in.\n");
  return 0;
}

export function getAuthCliOptions(): readonly AuthCliId[] {
  return AUTH_CLI_OPTIONS.map((option) => option.value);
}

export function parseAuthCliId(value: string | undefined): AuthCliId | undefined {
  return value === "claude-kimi" ? value : undefined;
}

async function promptForCli(): Promise<AuthCliId | undefined> {
  const selected = await select<AuthCliId>({
    message: "Select an authentication provider",
    options: [...AUTH_CLI_OPTIONS],
  });
  return isCancel(selected) ? undefined : selected;
}

function cancelAuthCommand(): number {
  cancel("Authentication cancelled.");
  return 1;
}

function formatValidationFailure(status: string): string {
  if (status === "unauthorized") return "Kimi rejected the API key. Check the key and try again.";
  if (status === "forbidden") return "The API key is not allowed for Kimi. Check its permissions.";
  if (status === "timeout") return "Kimi API key validation timed out. Check the connection and try again.";
  if (status === "network") return "Could not reach Kimi to validate the API key.";
  if (status === "server") return "Kimi returned an error while validating the API key. Try again later.";
  return "Could not validate the Kimi API key.";
}
