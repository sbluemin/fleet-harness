import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createTranslator, resolveLocalizedText } from "../sdk/i18n/translate.js";
import type { MessageCatalog } from "../sdk/i18n/types.js";
import { formatRelativeTime } from "../core/client/src/i18n/format.js";
import { CORE_MESSAGES, getT } from "../core/client/src/i18n/index.js";
import { renderMessage } from "../core/client/src/i18n/ui.js";
import { translateServerError } from "../core/client/src/i18n/ui.js";

/**
 * en===ko가 허용되는 값 목록.
 * 원형 유지 용어·제품/테마명·프로토콜 토큰·이관 전부터 EN UI에 한국어가 있던 라벨 등.
 */
const IDENTICAL_LOCALE_VALUE_ALLOWLIST = new Set([
  // 다이어그램 라이트박스 고정 헤드라인
  "MANIFEST · DIAGRAM",
  // Codex 헬스 칩 — drydock은 도메인 원형이고 OK는 상태 표기 그대로 읽힌다.
  "drydock OK",
  // 이관 전부터 command-band rename aria가 한국어였음
  "{title} 이름 변경",
  // 호스트 칩의 "여기" 표식은 두 로케일에서 같은 낱말로 읽힌다(대원수 지시).
  "Local",
  // 액세스 링크의 모양 그 자체 — 번역하면 붙여넣을 것과 달라진다.
  "fleet://join?code=...",
  // 버전 델타는 두 숫자와 화살표뿐 — 번역할 낱말이 없다.
  "{from} → {to}",
  // 단축키 표기·언어 칩·버전 태그
  "⌘/Ctrl",
  "EN",
  "한국어",
  "v{version}",
  // 도메인·제품 원형 및 복수형 내비 라벨
  "Operations",
  "GitHub",
  // Remote access Desktop 설치 링크 라벨 — GitHub 제품 표면 명칭을 그대로 둔다.
  "GitHub releases",
  "Backend API",
  // Operation 종류 명칭 — 플러그인 카탈로그(terminal.kind.shell)도 두 로케일 모두 "Shell"이다.
  "Shell",
  // 겉모습 미리보기가 그리는 축소판 안의 문자열 — 레일 항목과 패널 값은 제품 표면에
  // 실제로 서 있는 이름 그대로여야 미리보기가 미리보기 구실을 한다.
  "Repository",
  "Operation",
  "rebuild-index",
  // 캔버스 모드 3종은 번역하지 않는 제품 고유 명칭이다.
  "Cruise",
  "Tactical",
  "War Room",
  "Operation {title}{groupContext}",
  // Quick Launch 멘션 행선지 태그 — mono 대문자 계기 표기라 두 로케일에서 같은 모양으로 읽는다.
  "Operation · {theater}",
  // 플러그인 행선지 태그는 낱말이 없는 순수 조판이다 — 두 값 모두 플러그인이 로케일에 맞춰 채운다.
  "{category} · {name}",
  "Companion {title}",
  "Map",
  "Activity Rail",
  "Quick Launch",
  "Theater",
  "Theater {name}",
  "Codex",
  // 실행 그룹은 공급자 제품명을 그대로 읽는다 — Codex와 같은 자리다.
  "Claude",
  "Console",
  "Terminal",
  // 테마·포트 모드·언어 선택 라벨(고유명)
  "Instrument",
  "Maritime",
  "Carbon",
  "Whites",
  "Auto",
  "Etc",
  "English",
  "Dynamic",
  "Static",
  "1024–65535",
  " · Dynamic",
  // 액센트 색 고유명
  "Crimson",
  "Amber",
  "Moss",
  "Teal",
  "Cerulean",
  "Indigo",
  "Plum",
  "Rose",
  // 모드 커튼 키커(고정 대문자 각인)·투어 진행 표기(숫자 포맷)
  "WAR ROOM",
  "TACTICAL",
  "CRUISE",
  "{current} / {total}",
  // 제품 탭·Cowork 설정 토큰
  "Fleet CLI",
  "Fleet Console",
  "Fleet Desktop",
  "Fleet Mobile",
  "Fleet Plugin",
  "Fleet Core",
  "CLI",
  "Model",
  "Effort",
  // Codex 패치 종류·op 뱃지(프로토콜 토큰)
  "Create",
  "Update",
  "Patch",
  "CREATE",
  "UPDATE",
  // 이관 전부터 EN UI에 한국어가 있던 충돌 해소 라벨
  "기존 문서 대체",
  "신규 문서 생성",
]);

function placeholderNames(message: string): string[] {
  return [...message.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]!).sort();
}

const CATALOG = {
  en: {
    "hello.name": "Hello, {name}!",
    "plain": "Plain",
  },
  ko: {
    "hello.name": "안녕하세요, {name}!",
    "plain": "일반",
  },
} as const satisfies MessageCatalog<"hello.name" | "plain">;

describe("createTranslator", () => {
  it("returns locale-specific values for en and ko", () => {
    expect(createTranslator(CATALOG, "en")("plain")).toBe("Plain");
    expect(createTranslator(CATALOG, "ko")("plain")).toBe("일반");
  });

  it("interpolates {name} placeholders and leaves missing values intact", () => {
    const t = createTranslator(CATALOG, "en");
    expect(t("hello.name", { name: "Fleet" })).toBe("Hello, Fleet!");
    expect(t("hello.name")).toBe("Hello, {name}!");
  });

  it("returns the key itself when the message is missing", () => {
    const t = createTranslator(CATALOG, "en");
    expect(t("missing.key" as "plain")).toBe("missing.key");
  });
});

describe("resolveLocalizedText", () => {
  it("returns strings as-is and invokes locale functions", () => {
    expect(resolveLocalizedText("static", "ko")).toBe("static");
    expect(resolveLocalizedText((locale) => `L:${locale}`, "en")).toBe("L:en");
  });
});

describe("formatRelativeTime", () => {
  it("produces different strings for ko and en", () => {
    const now = Date.UTC(2026, 6, 25, 12, 0, 0);
    const past = now - 90_000;
    const en = formatRelativeTime(past, "en", now);
    const ko = formatRelativeTime(past, "ko", now);
    expect(en).not.toBe(ko);
    expect(en.length).toBeGreaterThan(0);
    expect(ko.length).toBeGreaterThan(0);
  });
});

describe("translateServerError", () => {
  it("maps known English server phrases and preserves unknowns", () => {
    const t = getT("ko");
    expect(translateServerError("Method not allowed", t)).toBe("허용되지 않은 요청 방식입니다");
    expect(translateServerError("Not found", t)).toBe("찾을 수 없습니다");
    expect(translateServerError("Unauthorized", t)).toBe("권한이 없습니다");
    expect(translateServerError("Internal server error", t)).toBe("서버 내부 오류가 발생했습니다");
    expect(translateServerError("Something else", t)).toBe("Something else");
  });
});

describe("renderMessage", () => {
  function markup(nodes: ReactNode[]): string {
    return renderToStaticMarkup(createElement("span", null, ...nodes));
  }

  it("interleaves string fragments with React nodes for {name} placeholders", () => {
    const html = markup(
      renderMessage("Port {port} fell back to a {mode} port on {host}.", {
        port: createElement("strong", null, "8080"),
        mode: createElement("strong", null, "Dynamic"),
        host: createElement("strong", null, "127.0.0.1:4310"),
      }),
    );
    expect(html).toBe(
      "<span>Port <strong>8080</strong> fell back to a <strong>Dynamic</strong> port on <strong>127.0.0.1:4310</strong>.</span>",
    );
  });

  it("leaves missing placeholders intact", () => {
    const html = markup(
      renderMessage("Next restart will try {port}.", {
        other: createElement("strong", null, "x"),
      }),
    );
    expect(html).toBe("<span>Next restart will try {port}.</span>");
  });

  it("assigns stable keys so mixed arrays are valid React children", () => {
    const parts = renderMessage("A {x} B {y}", {
      x: createElement("em", null, "1"),
      y: createElement("em", null, "2"),
    });
    const keyed = parts.filter((part) => typeof part === "object" && part !== null && "key" in part);
    expect(keyed.map((part) => (part as { key: string }).key)).toEqual(["rich:x:0", "rich:y:1"]);
  });
});

describe("CORE_MESSAGES locale parity", () => {
  it("fails when en===ko unless the value is on the intentional allowlist", () => {
    const unexpected: string[] = [];
    for (const key of Object.keys(CORE_MESSAGES.en) as Array<keyof typeof CORE_MESSAGES.en>) {
      const en = CORE_MESSAGES.en[key];
      const ko = CORE_MESSAGES.ko[key];
      if (en === ko && !IDENTICAL_LOCALE_VALUE_ALLOWLIST.has(en)) {
        unexpected.push(`${key}: ${JSON.stringify(en)}`);
      }
    }
    expect(unexpected).toEqual([]);
  });

  it("keeps the same {placeholder} set for every en/ko message pair", () => {
    const mismatched: string[] = [];
    for (const key of Object.keys(CORE_MESSAGES.en) as Array<keyof typeof CORE_MESSAGES.en>) {
      const enPlaceholders = placeholderNames(CORE_MESSAGES.en[key]);
      const koPlaceholders = placeholderNames(CORE_MESSAGES.ko[key]);
      if (enPlaceholders.join("\0") !== koPlaceholders.join("\0")) {
        mismatched.push(`${key}: en=${JSON.stringify(enPlaceholders)} ko=${JSON.stringify(koPlaceholders)}`);
      }
    }
    expect(mismatched).toEqual([]);
  });
});
