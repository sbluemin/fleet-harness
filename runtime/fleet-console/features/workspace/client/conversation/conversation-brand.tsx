import { DESKTOP_BRAND_MARK_ATTRIBUTE, DESKTOP_BRAND_WORDMARK_ATTRIBUTE } from "@fleet-console/protocol/desktop/brand";

/** git 이력의 BrandWordmark — 개발 채널만 열린 링과 Fleet·DEV를 쓴다. */
export function BrandWordmark({ local = false }: { readonly local?: boolean }) {
  return <span className={`conversation-brand-wordmark${local ? " is-local" : ""}`} {...{ [DESKTOP_BRAND_WORDMARK_ATTRIBUTE]: "" }}>
    Fleet{local ? <><span className="conversation-brand-sep" aria-hidden="true">·</span><span className="conversation-brand-tag">DEV</span></> : null}
  </span>;
}

export function BrandMarkIcon({ local = false }: { readonly local?: boolean }) {
  return <svg className="conversation-brand-glyph" viewBox="0 0 64 64" aria-hidden="true" {...{ [DESKTOP_BRAND_MARK_ATTRIBUTE]: "" }}>
    <rect x="2" y="2" width="60" height="60" rx="14" fill="var(--ink-deep)" stroke="var(--surface-rim-strong)" strokeWidth="2" />
    {local
      ? <path d="M48.33 23.31A18.5 18.5 0 0 1 48.33 40.69M40.69 48.33A18.5 18.5 0 0 1 23.31 48.33M15.67 40.69A18.5 18.5 0 0 1 15.67 23.31M23.31 15.67A18.5 18.5 0 0 1 40.69 15.67" fill="none" stroke="var(--brass)" strokeWidth="3.5" strokeLinecap="round" />
      : <circle cx="32" cy="32" r="18.5" fill="none" stroke="var(--brass)" strokeWidth="3.5" />}
    <circle cx="32" cy="32" r="10.5" fill="none" stroke="var(--brass)" strokeWidth="1.8" opacity="0.55" />
    <path d="M32 9v8M32 47v8M9 32h8M47 32h8" stroke="var(--brass)" strokeWidth="3" strokeLinecap="round" />
    <circle cx="32" cy="32" r="3" fill="var(--brass)" />
    {local ? null : <circle cx="44.7" cy="19.3" r="5" fill="var(--aurora)" />}
  </svg>;
}
