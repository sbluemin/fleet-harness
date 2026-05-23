export type DedicatedCliId = "claude" | "claude-zai" | "claude-kimi" | "codex";

export interface DedicatedCliProfile {
  readonly id: DedicatedCliId;
  readonly label: string;
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly messagePolicy?: CliMessagePolicy;
  readonly terminalName: string;
}

export interface CliMessagePolicy {
  readonly bracketedPaste?: boolean;
  readonly lineTerminator?: string;
  readonly multilineStrategy?: "literal" | "paste-mode";
}

export interface DedicatedCliDefinition {
  readonly id: DedicatedCliId;
  readonly label: string;
  readonly defaultBin: string;
  readonly envOverrideName: string;
  createProfile(options: DedicatedCliProfileOptions): Promise<DedicatedCliProfile>;
}

export interface DedicatedCliProfileOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly model?: string;
}

export interface DedicatedCliInjectionContext {
  readonly cliId: DedicatedCliId;
  readonly replaceSystemPrompt: boolean;
  readonly systemPromptFile: string;
  readonly endpointUrl: string;
  readonly bearerToken: string;
}

export interface DedicatedCliInjectionCapabilityEnabled {
  readonly enabled: true;
  readonly builderId: "claude-native" | "codex-native";
}

export interface DedicatedCliInjectionCapabilityDisabled {
  readonly enabled: false;
  readonly reason: "native-builder-not-implemented";
}

export type DedicatedCliInjectionCapability =
  | DedicatedCliInjectionCapabilityEnabled
  | DedicatedCliInjectionCapabilityDisabled;
