import type { CliType } from "@sbluemin/unified-agent";

import { createAuthService } from "./auth-storage.js";

export const CLI_TO_AUTH_PROVIDER_ID: Partial<Record<CliType, string>> = {
  "claude-zai": "Claude Code with Z.AI GLM",
  "claude-kimi": "Claude Code with Moonshot Kimi",
};

export async function resolveAuthEnv(
  cli: CliType,
): Promise<Record<string, string>> {
  const providerId = CLI_TO_AUTH_PROVIDER_ID[cli];
  if (!providerId) return {};
  const auth = createAuthService();
  const token = await auth.getApiKey(providerId);
  if (!token) {
    throw new Error(
      `auth.json에서 cli '${cli}'의 인증 토큰을 찾을 수 없습니다 (providerId: '${providerId}'). ~/.pi/agent/auth.json에 해당 항목이 등록되어 있는지 확인하세요.`,
    );
  }
  return { ANTHROPIC_AUTH_TOKEN: token };
}
