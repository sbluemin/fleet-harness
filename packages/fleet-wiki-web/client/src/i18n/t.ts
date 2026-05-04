import type { I18nMessages, SupportedLanguage } from "./types";
import { en } from "./messages/en";
import { ko } from "./messages/ko";
import { getLanguage } from "./store";

type Params = Record<string, string | number>;

const dictionaries: Record<SupportedLanguage, I18nMessages> = { ko, en };

export function t(key: string, params?: Params): string {
  const lang = getLanguage();
  const active = lookup(dictionaries[lang], key);
  if (active !== undefined) return substitute(active, params);
  const fallback = lookup(dictionaries.en, key);
  if (fallback !== undefined) return substitute(fallback, params);
  return key;
}

export function flattenKeys(obj: object, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object") {
      keys.push(...flattenKeys(v as object, full));
    } else {
      keys.push(full);
    }
  }
  return keys;
}

export function validateKeysets(): { valid: boolean; missingInEn: string[]; missingInKo: string[] } {
  const koKeys = new Set(flattenKeys(ko));
  const enKeys = new Set(flattenKeys(en));
  const missingInEn = [...koKeys].filter((k) => !enKeys.has(k));
  const missingInKo = [...enKeys].filter((k) => !koKeys.has(k));
  return { valid: missingInEn.length === 0 && missingInKo.length === 0, missingInEn, missingInKo };
}

function lookup(dict: I18nMessages, key: string): string | undefined {
  const parts = key.split(".");
  let current: unknown = dict;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

function substitute(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    k in params ? String(params[k]) : `{${k}}`,
  );
}
