import type { SupportedLanguage } from "../i18n/types";

export function renderLangToggle(currentLang: SupportedLanguage): string {
  const koPressed = currentLang === "ko";
  const enPressed = currentLang === "en";
  const ariaLabel = currentLang === "ko"
    ? "언어 전환: 한국어"
    : "Switch language: English";

  return `
    <div class="lang-toggle" role="group" aria-label="${ariaLabel}">
      <button
        class="lang-toggle-btn${koPressed ? " active" : ""}"
        type="button"
        data-action="set-language"
        data-lang="ko"
        aria-pressed="${koPressed}"
      >KO</button>
      <button
        class="lang-toggle-btn${enPressed ? " active" : ""}"
        type="button"
        data-action="set-language"
        data-lang="en"
        aria-pressed="${enPressed}"
      >EN</button>
    </div>
  `;
}
