import { theaterInitials } from "../../../../../features/workspace/client/sidebar/theater-initials.js";

const TONES = ["crimson", "amber", "moss", "teal", "cerulean", "indigo", "plum", "rose"] as const;

/** 같은 키는 늘 같은 정체성 톤을 받는다 — Theater·Console 모노그램의 면. */
export function identityToneOf(key: string): (typeof TONES)[number] {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  return TONES[hash % TONES.length]!;
}

/** Theater(둥근 사각) · Console(원) 모노그램 — 면은 정체성 톤, 글자는 화면 배경색. */
export function MobileMonogram({ label, toneKey, tone, letters, round = false, size = 28 }: {
  readonly label: string;
  readonly toneKey: string;
  /** 앱이 정해 준 정체성 톤 — 있으면 키 해시보다 우선한다. */
  readonly tone?: (typeof TONES)[number] | null;
  /** 앱이 정해 준 모노그램 글자 — 있으면 이름에서 따지 않는다. */
  readonly letters?: string | null;
  readonly round?: boolean;
  readonly size?: number;
}) {
  return (
    <span
      className={`mobile-monogram${round ? " is-round" : ""}`}
      style={{ width: size, height: size, background: `var(--id-${tone ?? identityToneOf(toneKey)})`, fontSize: size >= 56 ? 18 : size >= 36 ? 14 : size >= 28 ? 11 : 9, fontWeight: size >= 56 ? 700 : undefined }}
      aria-hidden="true"
    >
      {letters ?? theaterInitials(label)}
    </span>
  );
}
