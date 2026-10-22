export interface SessionHostProcess {
  readonly pid?: number;
  on(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: () => void): unknown;
  unref(): void;
}
/** 커널별 행동은 조합부가 제공한다. foundation은 native binding을 import하지 않는다. */
export interface SessionHostPlatform {
  spawnIndependent(command: string, args: readonly string[], env: NodeJS.ProcessEnv, diagnostics: number): SessionHostProcess;
  protectDirectory(file: string): void;
  assertIndependent(): void;
  owns(file: string): boolean;
}
