export type DedicatedCliId = "claude" | "codex" | "gemini" | "opencode" | "cursor-agent";

export interface DedicatedCliProfile {
  readonly id: DedicatedCliId;
  readonly label: string;
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly terminalName: string;
}

export interface DedicatedCliDefinition {
  readonly id: DedicatedCliId;
  readonly label: string;
  readonly defaultBin: string;
  readonly envOverrideName: string;
  createProfile(options: DedicatedCliProfileOptions): DedicatedCliProfile;
}

export interface DedicatedCliProfileOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

