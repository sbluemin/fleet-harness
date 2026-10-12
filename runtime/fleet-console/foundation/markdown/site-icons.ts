/**
 * 사이트 링크 아이콘 — 네트워크 없이 저장소에 실은 단색 글리프만 쓴다.
 *
 * 파비콘을 받아 오지 않는 것이 이 모듈의 계약이다. 렌더만으로 외부 요청이 나가면 링크 하나가
 * 클릭 없는 유출 통로가 되고(호스트 이름에 비밀을 실은 주소), 흐르는 동안 자라는 호스트마다 헛요청이 생긴다.
 * 그래서 자주 나오는 몇 곳만 손으로 그린 마크를 두고 나머지는 지구본 하나로 선다.
 *
 * 색은 정하지 않는다 — `currentColor`만 쓰므로 링크 잉크(테마 토큰)를 그대로 따른다.
 * 글리프는 정적 문자열이고 주소에서 온 값은 섞이지 않는다.
 */

const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';

const GLYPHS = {
  globe: `<g ${STROKE}><circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.75 1.75 2.5 3.5 2.5 5.5S9.75 11.75 8 13.5C6.25 11.75 5.5 10 5.5 8S6.25 4.25 8 2.5z"/></g>`,
  github: `<path fill="currentColor" d="M8 .8a7.2 7.2 0 00-2.28 14.03c.36.07.49-.16.49-.35v-1.22c-2 .43-2.42-.97-2.42-.97-.33-.83-.8-1.05-.8-1.05-.65-.45.05-.44.05-.44.72.05 1.1.74 1.1.74.64 1.1 1.68.78 2.1.6.06-.47.25-.78.45-.96-1.6-.18-3.28-.8-3.28-3.56 0-.79.28-1.43.74-1.93-.07-.18-.32-.92.07-1.91 0 0 .6-.19 1.98.74a6.9 6.9 0 013.6 0c1.37-.93 1.97-.74 1.97-.74.4.99.15 1.73.07 1.91.46.5.74 1.14.74 1.93 0 2.77-1.69 3.38-3.3 3.56.26.22.49.66.49 1.33v1.97c0 .19.13.42.5.35A7.2 7.2 0 008 .8z"/>`,
  google: `<path ${STROKE} d="M11.9 4.1A5.5 5.5 0 1 0 13.5 8H8.25"/>`,
  youtube: `<path fill="currentColor" fill-rule="evenodd" d="M3.75 3h8.5a3 3 0 013 3v4a3 3 0 01-3 3h-8.5a3 3 0 01-3-3V6a3 3 0 013-3zM6.5 5.6v4.8L10.6 8z"/>`,
  wikipedia: `<path ${STROKE} d="M1 4h3M12 4h3M2.5 4l2.5 8.5L8 5.5l3 7L13.5 4"/>`,
  npm: `<path fill="currentColor" fill-rule="evenodd" d="M1.5 1.5h13v13h-13zM4 4v8h4V6.5h2V12h2V4z"/>`,
  stackoverflow: `<path ${STROKE} d="M3 9.5v4h10v-4M5.5 11.5h5M5.8 9.1l4.9 1M6.6 6.8l4.5 2.1M8.1 4.7l3.8 3.1M10.2 2.8l2.8 4"/>`,
} as const;

export type SiteIconName = keyof typeof GLYPHS;

/** 등록 도메인 → 마크. 하위 도메인(gist.github.com, ko.wikipedia.org)도 같은 마크다. */
const SITE_DOMAINS: readonly (readonly [string, SiteIconName])[] = [
  ["github.com", "github"],
  ["githubusercontent.com", "github"],
  ["google.com", "google"],
  ["youtube.com", "youtube"],
  ["youtu.be", "youtube"],
  ["wikipedia.org", "wikipedia"],
  ["npmjs.com", "npm"],
  ["npmjs.org", "npm"],
  ["stackoverflow.com", "stackoverflow"],
];

export function siteIconName(hostname: string): SiteIconName {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  for (const [domain, name] of SITE_DOMAINS) {
    if (host === domain || host.endsWith(`.${domain}`)) return name;
  }
  return "globe";
}

export function siteIconSvg(name: SiteIconName): string {
  return `<svg class="md-site-icon" data-site="${name}" viewBox="0 0 16 16" aria-hidden="true">${GLYPHS[name]}</svg>`;
}
