import type { ReactNode } from "react";
export interface ArchiveSectionContext {
  readonly language: "en" | "ko";
  readonly theaterId: string | null;
  readonly query?: string;
  /** 칸의 줄이 다른 표면으로 옮겨 갈 때 시트를 닫는다. */
  readonly close: () => void;
}


export interface ArchiveSectionDescriptor {
  readonly id: string;
  readonly title: (language: "en" | "ko") => string;
  readonly subscribe: (listener: () => void) => () => void;
  /** 이 Theater(null 이면 활성 Theater)에서 칸이 담은 수 — 보관함 입구의 「· 이름 N」과 칸 머리에 선다. */
  readonly count: (theaterId: string | null, query?: string) => number;
  readonly render: (context: ArchiveSectionContext) => ReactNode;
}
