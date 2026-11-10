export function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.4v9.2M3.4 8h9.2" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
    </svg>
  );
}

export function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 5a1 1 0 0 1 1-1h2.6l1.3 1.3h5.1a1 1 0 0 1 1 1V11.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

export function SectionMoveIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 4.5h7M2.5 8h4.5M2.5 11.5h7" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M9.5 8h4M11.8 6.2 13.5 8l-1.7 1.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10.6 3.2 12.8 5.4 6.2 12H4v-2.2z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.2 5.8v6.1M8 5.8v6.1M10.8 5.8v6.1" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M3.7 4.1h8.6M6.4 4.1l.4-1h2.4l.4 1M4.6 4.1l.5 9.1h5.8l.5-9.1" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 태스크포스 글리프(겹친 두 네모) — 사이드바 메뉴와 ⌘K 팔레트가 같은 모양을 쓴다. 선 굵기만 부르는 쪽이 정한다. */
export function TaskforceIcon({ strokeWidth = 1.3 }: { readonly strokeWidth?: number }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.5" y="5.5" width="8" height="8" rx="1.2" fill="none" stroke="currentColor" strokeWidth={strokeWidth} />
      <path d="M5.5 5.5V3.7a1.2 1.2 0 0 1 1.2-1.2h5.6a1.2 1.2 0 0 1 1.2 1.2v5.6a1.2 1.2 0 0 1-1.2 1.2H10.5" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CommodoreIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5 9.4 6.6 13.5 8 9.4 9.4 8 13.5 6.6 9.4 2.5 8 6.6 6.6Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
  );
}

/** 콘솔 관리 — 머리글의 슬라이더와 같은 조형. 메뉴 칸은 다른 아이콘과 같은 16px 상자다. */
export function ConsoleManageIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.2 4.8h5.2M11.2 4.8h2.6M2.2 11.2h2.6M8.6 11.2h5.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="9.6" cy="4.8" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="6.4" cy="11.2" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
