import type { AuthService } from "@dotobokuri/core-infra";

export interface AuthCommandDeps {
  readonly authService: AuthService;
}

export interface AuthCommandIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

export type AuthCliId = "claude-kimi";
