import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ledgerEn, ledgerKo } from "../client/i18n/messages.js";

const CLIENT_DIR = path.join(import.meta.dirname, "..", "client");

function clientSources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return clientSources(full);
    if (!/\.tsx?$/.test(entry) || full.endsWith(path.join("i18n", "messages.ts"))) return [];
    return [readFileSync(full, "utf8")];
  });
}

const SOURCE = clientSources(CLIENT_DIR).join("\n");
// `t(\`ledger.window.${value}\`)`처럼 접두만 리터럴인 호출은 정적 문자열로 잡히지 않는다.
const DYNAMIC_PREFIXES = [...SOURCE.matchAll(/`(ledger\.[\w.]*)\$\{/g)].map((match) => match[1]!);

describe("Ledger messages", () => {
  it("keeps English and Korean at the same keys and placeholders", () => {
    expect(Object.keys(ledgerKo).sort()).toEqual(Object.keys(ledgerEn).sort());
    const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
    const drift = Object.keys(ledgerEn).filter((key) => {
      const en = placeholders(ledgerEn[key as keyof typeof ledgerEn]);
      const ko = placeholders(ledgerKo[key as keyof typeof ledgerEn]);
      return en.join() !== ko.join();
    });
    expect(drift).toEqual([]);
  });

  it("ships no message the panel never renders", () => {
    // 죽은 키는 조용히 쌓여 번역가와 리뷰어에게 존재하지 않는 화면을 설명한다.
    const dead = Object.keys(ledgerEn).filter((key) => (
      !SOURCE.includes(`"${key}"`)
      && !DYNAMIC_PREFIXES.some((prefix) => key.startsWith(prefix))
    ));
    expect(dead).toEqual([]);
  });
});
