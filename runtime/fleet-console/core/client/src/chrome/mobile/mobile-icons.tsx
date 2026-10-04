import type { ReactNode } from "react";

/**
 * 모바일 셸의 아이콘 한 벌. 24×24 격자에 선 1.7, 둥근 끝 — 모양은 시안과 같고 색은 호출부 글자색을 따른다.
 * 경로 문자열이 아니라 노드로 두는 이유는 SDK 계약(`MobileBarMenuItem.icon`)이 ReactNode를 받기 때문이다.
 */
const PATHS = {
  menu: <path d="M4 7h16M4 12h11M4 17h7" />,
  plus: <path d="M12 5v14M5 12h14" />,
  kebab: <><circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none" /></>,
  back: <path d="M15 5l-7 7 7 7" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  down: <path d="M6 9l6 6 6-6" />,
  right: <path d="M9 6l6 6-6 6" />,
  newop: <><path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" /><path d="M12 7.5v6M9 10.5h6" /></>,
  theater: <path d="M5 5h14M4 9h16v10H4z" />,
  target: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r=".8" fill="currentColor" /></>,
  file: <><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5" /></>,
  folder: <path d="M3 6h6l2 2h10v11H3z" />,
  wiki: <><path d="M5 4h9a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z" /><path d="M5 17a3 3 0 0 1 3-3h9" /></>,
  term: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 10l3 2-3 2M13 15h4" /></>,
  grid: <><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></>,
  archive: <><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10h14V9M10 13h4" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></>,
  gear: <><circle cx="12" cy="12" r="3.2" /><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M5.5 18.5l1.8-1.8M16.7 7.3l1.8-1.8" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.6v.4" /></>,
  send: <path d="M12 19V5M6 11l6-6 6 6" />,
  pencil: <path d="M4 20h4L19 9l-4-4L4 16z" />,
  swap: <path d="M4 8h13l-3-3M20 16H7l3 3" />,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M5 16V6a2 2 0 0 1 2-2h9" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  minus: <path d="M6 12h12" />,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />,
} satisfies Record<string, ReactNode>;

export type MobileIconName = keyof typeof PATHS;

export function MobileIcon({ name, size = 22, className }: { readonly name: MobileIconName; readonly size?: number; readonly className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
