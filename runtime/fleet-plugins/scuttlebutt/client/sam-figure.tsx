export function SamFigure() {
  return (
    <svg
      className="scuttlebutt-sam"
      viewBox="0 0 76 92"
      aria-hidden="true"
    >
      <g className="scuttlebutt-sam-all">
        {/* tail: behind the body, pivots at its base */}
        <path className="scuttlebutt-sam-tail" d="M54 74 C66 74 70 64 68 54 C67 49 63 47 61 50 C59 53 62 55 63 59 C64 65 60 68 53 68 Z" fill="var(--ink-pearl)"/>

        {/* arms: pivot at the shoulder, swing up for the cheer */}
        <g className="scuttlebutt-sam-arm-l"><rect x="12" y="60" width="10" height="20" rx="5" fill="var(--ink-veil)"/><circle cx="17" cy="79" r="5.4" fill="var(--ink-pearl)"/></g>
        <g className="scuttlebutt-sam-arm-r"><rect x="54" y="60" width="10" height="20" rx="5" fill="var(--ink-veil)"/><circle cx="59" cy="79" r="5.4" fill="var(--ink-pearl)"/></g>

        {/* body */}
        <g className="scuttlebutt-sam-body">
          <path d="M20 92 L20 68 C20 61 26 57 38 57 C50 57 56 61 56 68 L56 92 Z" fill="var(--ink-veil)"/>
          <path d="M31 57 L38 70 L45 57 Z" fill="var(--ink-pearl)"/>
          <rect x="18" y="62" width="9" height="6" rx="2.4" fill="var(--brass)"/>
          <rect x="49" y="62" width="9" height="6" rx="2.4" fill="var(--brass)"/>
          <circle cx="33" cy="79" r="2.3" fill="var(--brass)"/>
          <circle cx="43" cy="79" r="2.3" fill="var(--brass)"/>
        </g>

        {/* head + cap */}
        <g className="scuttlebutt-sam-head">
          <path className="scuttlebutt-sam-ear-l" d="M17 26 L20 9 L33 20 Z" fill="var(--ink-pearl)"/>
          <path className="scuttlebutt-sam-ear-r" d="M59 26 L56 9 L43 20 Z" fill="var(--ink-pearl)"/>
          <rect x="11" y="20" width="54" height="44" rx="20" fill="var(--ink-pearl)"/>

          {/* cap: crown, brass band, visor, anchor */}
          <path d="M13 30 C13 16 23 8 38 8 C53 8 63 16 63 30 Z" fill="var(--ink-pearl)"/>
          <rect x="12" y="28" width="52" height="8" rx="3" fill="var(--brass)"/>
          <path d="M10 36 C10 33 66 33 66 36 C66 41 55 44 38 44 C21 44 10 41 10 36 Z" fill="var(--ink-rim)"/>
          <path d="M38 13 v9 M33 16 h10 M32 21 c0 4 12 4 12 0" stroke="var(--brass)" strokeWidth="2.2" fill="none" strokeLinecap="round"/>

          {/* face */}
          <g className="scuttlebutt-sam-eyes">
            <ellipse cx="27" cy="52" rx="4.6" ry="5.4" fill="var(--ink-abyss)"/>
            <ellipse cx="49" cy="52" rx="4.6" ry="5.4" fill="var(--ink-abyss)"/>
            <circle cx="28.6" cy="50" r="1.5" fill="var(--ink-pearl)"/>
            <circle cx="50.6" cy="50" r="1.5" fill="var(--ink-pearl)"/>
          </g>
          <g className="scuttlebutt-sam-happy">
            <path d="M22 53 c2.4 -4.4 8.2 -4.4 10.6 0" stroke="var(--ink-abyss)" strokeWidth="2.6" fill="none" strokeLinecap="round"/>
            <path d="M44 53 c2.4 -4.4 8.2 -4.4 10.6 0" stroke="var(--ink-abyss)" strokeWidth="2.6" fill="none" strokeLinecap="round"/>
          </g>
          <path d="M38 57 l-2.4 2.4 h4.8 Z" fill="var(--ink-rim)"/>
          <path d="M6 50 h7 M6 56 h7 M63 50 h7 M63 56 h7" stroke="var(--ink-rim)" strokeWidth="1.4" strokeLinecap="round" opacity="0.75"/>
        </g>

        {/* cheer sparks */}
        <g className="scuttlebutt-sam-spark" fill="var(--brass)">
          <path d="M8 30 l1.6 4 4 1.6 -4 1.6 -1.6 4 -1.6 -4 -4 -1.6 4 -1.6 Z"/>
          <path d="M68 26 l1.3 3.2 3.2 1.3 -3.2 1.3 -1.3 3.2 -1.3 -3.2 -3.2 -1.3 3.2 -1.3 Z"/>
        </g>
      </g>
    </svg>
  );
}
