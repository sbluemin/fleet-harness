
export interface ClientApiCapability {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  subscribe(path: string, onMessage: (event: MessageEvent<string>) => void): () => void;
  resync(): void;
}


export interface ClientLifecycleCapability {
  onDispose(cleanup: () => void): () => void;
}
