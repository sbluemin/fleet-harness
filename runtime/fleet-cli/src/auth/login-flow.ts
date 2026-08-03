import { cancel, isCancel, password, select } from "@clack/prompts";
import {
  KIMI_AUTH_PROVIDER_ID,
  OPENCODE_AUTH_PROVIDER_ID,
  validateKimiAuthKey,
  validateOpencodeGoAuthKey,
  type AuthKeyValidationResult,
} from "@dotobokuri/fleet-admiral";

import type { AuthCliId, AuthCommandDeps, AuthCommandIo } from "./types.js";

interface AuthCliDefinition {
  readonly label: string;
  /** Short provider name used in operator-facing failure messages. */
  readonly shortName: string;
  readonly providerId: string;
  readonly validate: (apiKey: string) => Promise<AuthKeyValidationResult>;
}

export const AUTH_CLI_DEFINITIONS: Readonly<Record<AuthCliId, AuthCliDefinition>> = {
  kimi: {
    label: "Kimi for AI Gateway",
    shortName: "Kimi",
    providerId: KIMI_AUTH_PROVIDER_ID,
    validate: validateKimiAuthKey,
  },
  opencode: {
    label: "OpenCode Go for AI Gateway",
    shortName: "OpenCode Go",
    providerId: OPENCODE_AUTH_PROVIDER_ID,
    validate: validateOpencodeGoAuthKey,
  },
};

const AUTH_CLI_OPTIONS: readonly { readonly value: AuthCliId; readonly label: string }[] =
  (Object.keys(AUTH_CLI_DEFINITIONS) as AuthCliId[]).map((value) => ({
    value,
    label: AUTH_CLI_DEFINITIONS[value].label,
  }));

export async function runAuthLoginFlow(
  argv: readonly string[],
  io: AuthCommandIo,
  deps: AuthCommandDeps,
): Promise<number> {
  const selectedCli = parseAuthCliId(argv[0]) ?? await promptForCli();
  if (!selectedCli) return cancelAuthCommand();
  const definition = AUTH_CLI_DEFINITIONS[selectedCli];

  const apiKey = await password({
    message: `Enter the ${definition.shortName} API key`,
    mask: "*",
  });
  if (isCancel(apiKey) || typeof apiKey !== "string" || apiKey.trim().length === 0) {
    return cancelAuthCommand();
  }

  const validation = await definition.validate(apiKey.trim());
  if (validation.status !== "success") {
    io.stderr.write(`${formatValidationFailure(definition.shortName, validation.status)}\n`);
    return 1;
  }

  await deps.authService.setApiKey(definition.providerId, apiKey.trim());
  io.stdout.write(`${definition.label} signed in.\n`);
  return 0;
}

export function getAuthCliOptions(): readonly AuthCliId[] {
  return AUTH_CLI_OPTIONS.map((option) => option.value);
}

export function parseAuthCliId(value: string | undefined): AuthCliId | undefined {
  return value !== undefined && value in AUTH_CLI_DEFINITIONS ? value as AuthCliId : undefined;
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

function formatValidationFailure(shortName: string, status: string): string {
  if (status === "unauthorized") return `${shortName} rejected the API key. Check the key and try again.`;
  if (status === "forbidden") return `The API key is not allowed for ${shortName}. Check its permissions.`;
  if (status === "timeout") return `${shortName} API key validation timed out. Check the connection and try again.`;
  if (status === "network") return `Could not reach ${shortName} to validate the API key.`;
  if (status === "server") return `${shortName} returned an error while validating the API key. Try again later.`;
  return `Could not validate the ${shortName} API key.`;
}
