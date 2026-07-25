import { getGlobalSettingsStoreState } from "../../global-settings-store.js";
import { getT } from "../../i18n/index.js";
import { resolveConsoleLanguage } from "../../whatsnew-i18n.js";

function resolveActiveLocale() {
  const preference = getGlobalSettingsStoreState().state?.language ?? "auto";
  const navigatorLanguage =
    typeof navigator !== "undefined" && typeof navigator.language === "string"
      ? navigator.language.toLowerCase()
      : "";
  return resolveConsoleLanguage(preference, navigatorLanguage);
}

// op-badge: CREATE(+)/UPDATE(↻) 모두 brass 톤, 글리프+라벨로만 구분 (aurora 단독 금지)
export function renderOpBadge(op: "create_wiki" | "update_wiki", targetExists: boolean): string {
  const t = getT(resolveActiveLocale());
  const isCreate = op === "create_wiki" || !targetExists;
  const glyph = isCreate ? "+" : "↻";
  const label = isCreate ? t("codex.opBadge.create") : t("codex.opBadge.update");
  const modClass = isCreate ? "op-badge--create" : "op-badge--update";
  return `<span class="op-badge ${modClass}" aria-label="${label}">
    <span class="op-badge-glyph" aria-hidden="true">${glyph}</span>
    <span class="op-badge-label">${label}</span>
  </span>`;
}
