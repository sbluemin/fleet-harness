export interface AuthCommandIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

export type AuthCliId = "claude-zai" | "claude-kimi";
