import type { ConsoleLocale, LocalizedText, MessageCatalog, MessageValues, Translate } from "./types.js";

export function createTranslator<K extends string>(catalog: MessageCatalog<K>, locale: ConsoleLocale): Translate<K> {
  const table = catalog[locale];
  return (key, values) => {
    const template = table[key];
    if (typeof template !== "string") return key;
    if (!values) return template;
    return interpolate(template, values);
  };
}

export function resolveLocalizedText(value: LocalizedText, locale: ConsoleLocale): string {
  return typeof value === "function" ? value(locale) : value;
}

function interpolate(template: string, values: MessageValues): string {
  return template.replace(/{([^{}]+)}/g, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}
