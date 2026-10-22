/**
 * 시작 구성 표식(승인 시안 C 「낫표」) — 업데이트 전 구성으로 계속 도는 세션 옆에 서는 조용한 사실 표식이다.
 *
 * 「」 두 모서리는 시작할 때의 구성을 그대로 옮겨 적은 채 돈다는 뜻이다. 오류·경고가 아니므로 신호색·brass·점·후광을 쓰지 않고,
 * 3티어 무채 잉크 한 획으로 이름 바로 뒤(결정 요청 표식과 같은 자리)에 선다. 활동 상태 칸(아바타)은 건드리지 않는다.
 * 사이드바 행·채팅 머리·목표 명단이 같은 모양과 같은 문구를 쓰고, 사령관 표면도 이 부품을 그대로 붙인다.
 * 색·크기는 호스트 CSS(`.launch-configuration-mark`)가 정한다.
 *
 * `unknown` 은 그리지 않는다 — 판정할 근거가 없는 것을 이전 구성이라 단정하지도, 최신이라 표시하지도 않는다.
 */

export type LaunchConfigurationState = "current" | "previous" | "unknown";

const COPY = {
  ko: {
    plain: "시작할 때의 구성 그대로 실행 중이에요. 새 도구와 프롬프트는 새 세션부터 적용돼요.",
    release: (version: string) => `시작할 때의 구성(v${version}) 그대로 실행 중이에요. 새 도구와 프롬프트는 새 세션부터 적용돼요.`,
  },
  en: {
    plain: "Running as set up at start. New tools and prompts apply from the next session.",
    release: (version: string) => `Running as set up at start (v${version}). New tools and prompts apply from the next session.`,
  },
} as const;

/** 툴팁과 접근성 이름이 같은 문장이다. release 는 시작한 Console version 이 지금과 다를 때만 온다. */
export function launchConfigurationLabel(locale: "en" | "ko", release?: string): string {
  const copy = COPY[locale];
  return release ? copy.release(release) : copy.plain;
}

/** 16 단위 상자, 1.4 획 — Console 커맨드 아이콘 문법. 크기는 부르는 쪽 CSS 가 정한다. */
export function LaunchConfigurationGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7.4V4.4A1.4 1.4 0 0 1 4.4 3h3" />
      <path d="M13 8.6v3a1.4 1.4 0 0 1-1.4 1.4h-3" />
    </svg>
  );
}

export interface LaunchConfigurationMarkProps {
  readonly state: LaunchConfigurationState | undefined;
  readonly release?: string;
  readonly locale: "en" | "ko";
  /** 감싼 요소가 이미 이 사실을 접근성 이름으로 말하는 자리 — 중복 낭독을 막는다. */
  readonly decorative?: boolean;
  readonly className?: string;
}

export function LaunchConfigurationMark({ state, release, locale, decorative = false, className }: LaunchConfigurationMarkProps) {
  if (state !== "previous") return null;
  const label = launchConfigurationLabel(locale, release);
  return (
    <span
      className={className ? `launch-configuration-mark ${className}` : "launch-configuration-mark"}
      title={label}
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
    >
      <LaunchConfigurationGlyph />
    </span>
  );
}
