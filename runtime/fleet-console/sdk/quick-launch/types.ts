export interface QuickLaunchFileSearchRequest {
  readonly query: string;
  readonly theaterId: string;
  readonly limit: number;
  readonly signal: AbortSignal;
}

export interface QuickLaunchFileSearchResult {
  readonly id: string;
  readonly relativePath: string;
}

export type QuickLaunchFileSearchProvider = (
  request: QuickLaunchFileSearchRequest,
) => Promise<readonly QuickLaunchFileSearchResult[]>;
