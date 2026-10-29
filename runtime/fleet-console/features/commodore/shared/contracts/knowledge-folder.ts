export type KnowledgeFolderAction = "display" | "open";

export type KnowledgeFolderResult =
  | { readonly status: "display"; readonly displayPath: string; readonly exists: boolean }
  | { readonly status: "opened" | "missing" | "unavailable" };
