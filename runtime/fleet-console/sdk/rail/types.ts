import type { ReactNode } from "react";

export interface RailFolderEntry {
  readonly name: string;
  readonly relativePath: string;
  readonly kind: "dir" | "file";
}

export interface RailFolderListResult {
  readonly relativePath: string;
  readonly parentRelativePath: string | null;
  readonly entries: readonly RailFolderEntry[];
}

export interface RailFileReadResult {
  readonly relativePath: string;
  readonly content: string;
  readonly lang: string;
  readonly truncated?: boolean;
  readonly binary?: boolean;
}

export interface RailHostFiles {
  readonly listFolder: (relativePath?: string) => Promise<RailFolderListResult>;
  readonly readFile: (relativePath: string) => Promise<RailFileReadResult>;
  readonly imageUrl: (relativePath: string) => string;
}

export interface RailDiffFileEntry {
  readonly path: string;
  readonly status: "M" | "A" | "D" | "R";
  readonly additions: number;
  readonly deletions: number;
  readonly truncated?: boolean;
}

export interface RailDiffListResult {
  readonly files: readonly RailDiffFileEntry[];
  readonly truncated?: boolean;
}

export interface RailDiffHunkResult {
  readonly content: string;
  readonly truncated?: boolean;
}

export interface RailHostDiff {
  readonly listChangedFiles: (mode: "workdir" | "staged" | "commit", ref?: string) => Promise<RailDiffListResult>;
  readonly unifiedDiff: (filePath: string, mode: "workdir" | "staged" | "commit", ref?: string) => Promise<RailDiffHunkResult>;
}

export interface RailHostCapabilities {
  readonly files: RailHostFiles;
  readonly diff: RailHostDiff;
}

export interface RailPanelContext {
  readonly theaterId: string | null;
  readonly host: RailHostCapabilities;
}

export interface RailPanelDescriptor {
  readonly id: string;
  readonly title: string;
  readonly icon: ReactNode | (() => ReactNode);
  readonly render: (ctx: RailPanelContext) => ReactNode;
  readonly side?: "right";
}
