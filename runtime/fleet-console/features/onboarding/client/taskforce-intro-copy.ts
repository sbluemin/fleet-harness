import type { ConsoleLocale } from "@fleet-console/i18n";

// 태스크포스 소개 카드의 문구 — 승인 시안 v2의 문구표 그대로다. 본문의 굵은 두 대목은
// 문장 순서가 언어마다 달라 통째로 번역하지 않고 다섯 조각으로 나눠 잇는다.

export interface TaskforceIntroCopy {
  readonly eyebrow: string;
  readonly badge: string;
  readonly title: string;
  readonly bodyPre: string;
  readonly bodyEm1: string;
  readonly bodyMid: string;
  readonly bodyEm2: string;
  readonly bodyPost: string;
  readonly link: string;
  readonly primary: string;
  readonly dismiss: string;
}

export interface TaskforceIntroCanvasCopy {
  readonly topic: string;
  readonly goal: string;
  readonly a: string;
  readonly b: string;
  readonly c: string;
  readonly d: string;
  readonly step1: string;
  readonly step2: string;
  readonly step3: string;
}

const copyKo: TaskforceIntroCopy = {
  eyebrow: "새 기능",
  badge: "실험 기능",
  title: "태스크포스: 사령관 여럿이 함께 판단하고 목표를 세워요",
  bodyPre: "사령관 2명 이상이 한 주제를 두고 ",
  bodyEm1: "함께 판단하고",
  bodyMid: ", 그 판단으로 ",
  bodyEm2: "목표를 세워 진행",
  bodyPost: "까지 이어 가요. 실험 기능이라 기본으로 꺼져 있어요.",
  link: "설정에서 켜기",
  primary: "알겠어요",
  dismiss: "소개 카드 닫기",
};

const copyEn: TaskforceIntroCopy = {
  eyebrow: "New",
  badge: "Experimental",
  title: "TaskForce: Commodores judge together and set the objective",
  bodyPre: "Two or more Commodores ",
  bodyEm1: "judge one topic together",
  bodyMid: ", then turn that judgment into ",
  bodyEm2: "an objective",
  bodyPost: " and carry it forward. It is experimental and off by default.",
  link: "Turn on in Settings",
  primary: "Got it",
  dismiss: "Dismiss the introduction card",
};

export function taskforceIntroCopy(locale: ConsoleLocale): TaskforceIntroCopy {
  return locale === "ko" ? copyKo : copyEn;
}

const canvasKo: TaskforceIntroCanvasCopy = {
  topic: "주제 하나",
  goal: "목표",
  a: "사령관 A",
  b: "사령관 B",
  c: "사령관 C",
  d: "사령관 D",
  step1: "① 주제 하나에 모여",
  step2: "② 함께 판단하고",
  step3: "③ 목표를 세워 진행해요",
};

const canvasEn: TaskforceIntroCanvasCopy = {
  topic: "One topic",
  goal: "Objective",
  a: "Commodore A",
  b: "Commodore B",
  c: "Commodore C",
  d: "Commodore D",
  step1: "① Gather on one topic",
  step2: "② Judge together",
  step3: "③ Set the objective and proceed",
};

export function taskforceIntroCanvas(locale: ConsoleLocale): TaskforceIntroCanvasCopy {
  return locale === "ko" ? canvasKo : canvasEn;
}

/** 모션 감소 때 그리는 정지 프레임 — 세 단계가 모두 보이는 시각(초)이다. */
export const TASKFORCE_INTRO_REST = 12;

/** 모션 한 바퀴 — 시안 v2와 같은 15초다. */
export const TASKFORCE_INTRO_LOOP_S = 15;
