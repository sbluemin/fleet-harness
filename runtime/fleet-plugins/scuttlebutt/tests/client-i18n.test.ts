import { describe, expect, it } from "vitest";

import { getT } from "../client/i18n.js";

describe("Scuttlebutt translations", () => {
  it("uses the frozen English and Korean catalogs", () => {
    const en = getT("en");
    const ko = getT("ko");
    expect([
      en("mascot.label"),
      en("chat.tuck"),
      en("chat.placeholder"),
      en("chat.send"),
      en("chat.greeting"),
      en("chat.thinking"),
      en("followup.whoAreYou"),
      en("followup.whatCanYouDo"),
      en("status.searching"),
      en("status.reading"),
      en("status.working"),
      en("arrival.one", { title: "Alpha" }),
      en("arrival.many", { count: 2 }),
      en("settings.section.title"),
      en("settings.section.enable"),
      en("settings.section.enableHint"),
    ]).toEqual([
      "Admiral Tori",
      "Tuck away",
      "Ask Tori anything…",
      "Send",
      "Tori on the bridge — ask anything that does not need a workspace. I can search the web, and I never touch your files.",
      "Tori is looking it up…",
      "Who are you?",
      "What can you do?",
      "Searching…",
      "Reading a source…",
      "Working…",
      "Alpha finished",
      "2 operations finished",
      "Quaker Admirals",
      "Enable the Quaker Admirals",
      "When off, all three floating admirals are removed.",
    ]);
    expect([
      ko("mascot.label"),
      ko("chat.tuck"),
      ko("chat.placeholder"),
      ko("chat.send"),
      ko("chat.greeting"),
      ko("chat.thinking"),
      ko("followup.whoAreYou"),
      ko("followup.whatCanYouDo"),
      ko("status.searching"),
      ko("status.reading"),
      ko("status.working"),
      ko("arrival.one", { title: "알파" }),
      ko("arrival.many", { count: 2 }),
      ko("settings.section.title"),
      ko("settings.section.enable"),
      ko("settings.section.enableHint"),
    ]).toEqual([
      "토리 제독",
      "치워두기",
      "토리에게 무엇이든 물어보세요…",
      "보내기",
      "함교의 토리입니다 — 작업 공간이 필요 없는 건 뭐든 물어보세요. 웹은 찾아보지만 파일은 건드리지 않습니다.",
      "토리가 찾아보는 중…",
      "너는 누구야?",
      "뭘 할 수 있어?",
      "검색하는 중…",
      "출처를 읽는 중…",
      "처리하는 중…",
      "알파 작업이 끝났습니다",
      "Operation 2건이 끝났습니다",
      "퀘이커 제독단",
      "퀘이커 제독단 사용",
      "끄면 떠다니는 제독 셋이 모두 사라집니다.",
    ]);
  });

  it("uses the frozen admiral names and speech lines", () => {
    const en = getT("en");
    const ko = getT("ko");
    expect([
      en("bird.tori"),
      en("bird.bori"),
      en("bird.dori"),
      en("line.bori.1"),
      en("line.bori.2"),
      en("line.bori.3"),
      en("line.dori.1"),
      en("line.dori.2"),
      en("line.dori.3"),
    ]).toEqual([
      "Tori",
      "Bori",
      "Dori",
      "Signal received, loud and clear!",
      "Run up the flags!",
      "Courier Bori — dispatch coming through!",
      "Patrol reports nothing unusual.",
      "Dori entering the patrol route.",
      "Carrier streams are steady.",
    ]);
    expect([
      ko("bird.tori"),
      ko("bird.bori"),
      ko("bird.dori"),
      ko("line.bori.1"),
      ko("line.bori.2"),
      ko("line.bori.3"),
      ko("line.dori.1"),
      ko("line.dori.2"),
      ko("line.dori.3"),
    ]).toEqual([
      "토리",
      "보리",
      "도리",
      "신호 수신 양호!",
      "깃발 올려!",
      "보리 전령, 급보 있음!",
      "초계 이상 무!",
      "도리, 초계 항로 진입.",
      "캐리어 스트림 정상.",
    ]);
  });
});
