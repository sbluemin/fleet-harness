export interface TheaterBadgeProps {
  readonly label: string;
  readonly initials: string;
  readonly detail?: string;
  readonly tone?: "normal" | "warning";
}

export function TheaterBadge({ label, initials, detail, tone = "normal" }: TheaterBadgeProps) {
  return (
    <span className={`theater-badge${tone === "warning" ? " is-warning" : ""}`} title={detail ? `${label} · ${detail}` : label}>
      <span className="theater-badge-initials" aria-hidden="true">{initials}</span>
      <span className="theater-badge-label">{label}</span>
      {detail ? <span className="theater-badge-detail">{detail}</span> : null}
    </span>
  );
}

export function theaterInitials(label: string): string {
  const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  const graphemes = (value: string) => segmenter ? [...segmenter.segment(value)].map((item) => item.segment) : Array.from(value);
  const words = label.trim().split(/[\s\-_.]+/).filter(Boolean);
  const initials = words.length > 1
    ? words.flatMap((word) => graphemes(word).slice(0, 1))
    : graphemes(label).filter((grapheme) => /[\p{L}\p{N}]/u.test(grapheme));
  return initials.slice(0, 2).join("").toUpperCase() || "--";
}
