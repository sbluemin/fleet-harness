import type { ConsoleLocale } from "@fleet-console/i18n";

// 플릿 한눈에 보기(도움말 모션 팝업)의 문구 — 장의 순서·제목·본문·태그와
// 캔버스 안에 그리는 짧은 표기를 ko/en 한 벌로 둔다. 한국어 문구는 승인 시안 그대로다.

export interface FleetGlanceSceneCopy {
  readonly chapter: string;
  readonly tech?: string;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  /** 완성 장면까지의 진행 시각(초) — 모션 감소 때 한 장면으로 그리는 기준점이다. */
  readonly rest: number;
  /** 캔버스 표기 — 장마다 키가 다르며 같은 장의 draw가 같은 키를 읽는다. */
  readonly canvas: Readonly<Record<string, string>>;
  /** 정리 장처럼 캔버스 대신 타일로 그리는 장이다. */
  readonly summary?: boolean;
}

export interface FleetGlanceChromeCopy {
  readonly title: string;
  readonly count: string;
  readonly autoStart: string;
  readonly autoStop: string;
  readonly replay: string;
  readonly close: string;
  readonly prev: string;
  readonly next: string;
  readonly sectionStructure: string;
  readonly sectionTechniques: string;
  readonly sectionRecap: string;
}

export interface FleetGlanceSummaryRow {
  readonly icon: "lens" | "shells" | "comet" | "spiro" | "stars" | "prism";
  readonly title: string;
  readonly body: string;
  readonly detail: string;
}

const chromeKo: FleetGlanceChromeCopy = {
  title: "플릿 한눈에 보기",
  count: "{current} / {total}",
  autoStart: "자동으로 넘기기",
  autoStop: "자동 넘기기 멈추기",
  replay: "이 장 다시 재생",
  close: "닫기",
  prev: "이전",
  next: "다음",
  sectionStructure: "구조",
  sectionTechniques: "AI 엔지니어링 기법과 플릿",
  sectionRecap: "정리",
};

const chromeEn: FleetGlanceChromeCopy = {
  title: "Fleet at a glance",
  count: "{current} / {total}",
  autoStart: "Auto-play",
  autoStop: "Pause auto-play",
  replay: "Replay this scene",
  close: "Close",
  prev: "Previous",
  next: "Next",
  sectionStructure: "Structure",
  sectionTechniques: "AI engineering in Fleet",
  sectionRecap: "Recap",
};

export function fleetGlanceChrome(locale: ConsoleLocale): FleetGlanceChromeCopy {
  return locale === "ko" ? chromeKo : chromeEn;
}

const scenesKo: readonly FleetGlanceSceneCopy[] = [
  {
    chapter: "플릿의 구조",
    title: "사람 한 명을 중심으로 여러 에이전트가 함께 돌아요",
    body: "사람 곁을 사령관 여럿이 돌고, 사령관마다 목표를 거느려요. 목표 하나를 들여다보면 지휘관이 있고, 그 곁을 구성원이 돌며 미션을 맡아요.",
    tags: ["사령관 ×N", "목표 ×N", "지휘관 1", "구성원 ×0~N"],
    rest: 6,
    canvas: {
      brand: "Fleet Console",
      you: "사람",
      legend0: "사령관 ×N",
      legend1: "목표 ×N",
      inside: "목표 하나 안",
      commander: "지휘관",
      members: "구성원 ×0~N · 미션 수행",
    },
  },
  {
    chapter: "플릿의 구조",
    title: "방향은 바깥으로 퍼지고, 결과는 안으로 모여요",
    body: "사람이 정한 방향이 사령관, 지휘관, 구성원으로 물결처럼 번져요. 일이 끝나면 증거가 완료 기준을 채우고, 회고와 사령관 리뷰를 거쳐 사람에게 돌아와요.",
    tags: ["방향 → 계획 → 미션", "증거 → 완료 기준 → 회고 → 사령관 리뷰"],
    rest: 4.2,
    canvas: {
      inner: "사령관",
      innerResult: "사령관 리뷰",
      middle: "지휘관",
      middleResult: "완료 기준 · 회고",
      outer: "구성원",
      outerResult: "증거",
      you: "사람",
      outward: "방향",
      outwardSub: "바깥으로 퍼져요",
      inward: "결과",
      inwardSub: "안으로 모여요",
    },
  },
  {
    chapter: "플릿의 구조",
    title: "태스크포스는 사령관 여럿이 주제 하나에 모여요",
    body: "사령관 2명 이상이 한 주제를 두고 함께 이야기하는 그룹 대화예요. 각 사령관에게는 마지막으로 읽은 뒤에 나온 새 발언만 전해져요. 설정 › 실험 기능에서 켜요.",
    tags: ["사령관 2~N", "주제 하나", "새 발언만 전달", "실험 기능"],
    rest: 5,
    canvas: {
      topic: "주제 하나",
      a: "사령관 A",
      b: "사령관 B",
      c: "사령관 C",
      d: "사령관 D",
      note: "새로 나온 말만 서로에게 전해져요",
      lab: "실험 기능",
    },
  },
  {
    chapter: "AI 엔지니어링 기법과 플릿",
    tech: "Context Engineering",
    title: "컨텍스트 엔지니어링 · 렌즈로 거른 것만 들어가요",
    body: "에이전트가 무엇을 읽느냐가 결과를 정해요. 플릿은 쌓인 기록을 그대로 넣지 않고, 사령관 설명을 맨 위 기준으로 두고 필요한 것만 골라 넣어요.",
    tags: ["설명 · 최상위 기준", "정보", "기억", "원문과 이미지를 지킨 brief", "목표 기록 검색", "세션 교대 요약", "태스크포스 새 발언"],
    rest: 5,
    canvas: {
      pile: "쌓여 있는 기록",
      reading: "에이전트가 읽는 것",
      pick: "고르기",
      item0: "설명 · 최상위 기준",
      item1: "정보 (intel)",
      item2: "기억 (fleet-memory)",
      item3: "brief 원문 · 이미지",
      item4: "목표 기록 검색",
      item5: "세션 교대 때 최근 일 요약",
      item6: "태스크포스 새 발언",
    },
  },
  {
    chapter: "AI 엔지니어링 기법과 플릿",
    tech: "Harness Engineering",
    title: "하네스 엔지니어링 · 모델을 겹겹이 감싸요",
    body: "같은 모델도 어떤 규칙과 도구, 어떤 격리 안에서 일하느냐에 따라 결과가 달라져요. 플릿은 작전 구역마다 규칙과 절차를 두고, 모델 선택과 사용량까지 관리해요.",
    tags: ["작전 구역별 CLAUDE.md", "skills", "MCP 도구", "worktree 격리", "AI Gateway 라우팅", "Quota"],
    rest: 4.5,
    canvas: {
      model: "모델",
      shell0: "규칙과 절차",
      shell0Sub: "작전 구역별 CLAUDE.md · skills",
      shell1: "도구와 격리",
      shell1Sub: "MCP 도구 · worktree 격리",
      shell2: "모델과 사용량",
      shell2Sub: "AI Gateway 라우팅 · Quota",
    },
  },
  {
    chapter: "AI 엔지니어링 기법과 플릿",
    tech: "Loop Engineering",
    title: "루프 엔지니어링 · 끝날 때까지 스스로 돌아요",
    body: "지휘관은 계획을 세우고, 미션을 돌리고, 증거로 완료 기준을 채운 뒤에야 넘겨요. 알림이 오면 깨어나고, 멈추면 정체로 보여요.",
    tags: ["계획 → 미션 → 증거 → 완료 기준 → 인계", "알림으로 깨어나기", "루틴", "정체 감지", "리뷰 게이트"],
    rest: 5.2,
    canvas: {
      lead: "지휘관",
      leadSub: "끝날 때까지",
      node0: "계획",
      node1: "미션",
      node2: "증거",
      node3: "완료 기준",
      node4: "인계",
      side0: "알림이 오면 깨어나요",
      side1: "루틴은 정해진 때 시작해요",
      side2: "멈추면 정체로 보여요",
      side3: "PR은 리뷰와 체크를 통과해야 머지해요",
    },
  },
  {
    chapter: "AI 엔지니어링 기법과 플릿",
    tech: "Double Loop",
    title: "이중 루프 · 일하는 바퀴 위에 배우는 바퀴",
    body: "바깥 바퀴에서 사령관이 목표를 정하고 결과를 판단해요. 그 위를 도는 작은 바퀴에서 지휘관이 미션을 수행해요. 회고에서 얻은 교훈은 규칙과 skill로 되돌아가 다음 일을 바꿔요.",
    tags: ["바깥 · 사령관", "안쪽 · 지휘관", "회고", "learning-harvest", "규칙 · skill 갱신", "기억 lessons"],
    rest: 7,
    canvas: {
      outer: "바깥 바퀴 · 사령관",
      inner: "작은 바퀴 · 지휘관의 미션 수행",
      stop0: "설명 · 정보",
      stop1: "목표",
      stop2: "결과 판단",
      learn0: "회고",
      learn1: "learning-harvest",
      learn2: "규칙 · skill 갱신",
      memory: "기억에도 lessons로 남겨요",
    },
  },
  {
    chapter: "AI 엔지니어링 기법과 플릿",
    tech: "Graph Engineering",
    title: "그래프 엔지니어링 · 미션은 별자리처럼 이어져요",
    body: "지휘관은 미션 사이의 선행 관계를 별자리처럼 이어요. 앞 미션이 끝나면 다음 별이 켜지고, 서로 기다릴 필요가 없는 미션은 동시에 켜져요. 이 도움말을 만드는 목표도 이렇게 짰어요.",
    tags: ["선행조건 그래프", "병렬 우선", "목표 → 후속 목표", "사령관 → 지휘관 → 구성원"],
    rest: 6,
    canvas: {
      a: "시안",
      b: "승인",
      c: "구현",
      d: "검증 준비",
      e: "실앱 검증",
      f: "머지",
      followup: "후속 목표",
      together: "동시에 켜져요",
    },
  },
  {
    chapter: "AI 엔지니어링 기법과 플릿",
    tech: "Agent Engineering",
    title: "에이전트 엔지니어링 · 일을 나눠 알맞은 모델에게",
    body: "사령관, 지휘관, 구성원이 각자 맡은 일만 해요. AI Gateway는 프리즘처럼 미션의 난이도를 보고 알맞은 모델로 나눠 보내요. 화면 조작과 브라우저 도구도 쓸 수 있어요.",
    tags: ["역할 분리", "난이도별 모델 라우팅", "태스크포스", "Computer Use", "Browser"],
    rest: 4.5,
    canvas: {
      stream: "크고 작은 미션",
      light: "가벼운 모델",
      balanced: "균형 모델",
      strong: "강한 모델",
      gateway: "AI Gateway",
      role0: "사령관",
      role0Sub: "방향과 판단",
      role1: "지휘관",
      role1Sub: "계획과 통합",
      role2: "구성원",
      role2Sub: "미션 수행",
      tools: "Computer Use · Browser",
    },
  },
  {
    chapter: "정리",
    title: "여섯 가지 기법, 플릿에서는 이렇게",
    body: "닫아도 괜찮아요. 앱 메뉴의 도움말 › 플릿 한눈에 보기에서 언제든 다시 볼 수 있어요.",
    tags: [],
    rest: 0,
    canvas: {},
    summary: true,
  },
];

const scenesEn: readonly FleetGlanceSceneCopy[] = [
  {
    chapter: "How Fleet is organized",
    title: "One person, with many agents in orbit",
    body: "Commodores circle around you, each holding objectives. Look inside one objective and you'll find its commander, with members running missions around them.",
    tags: ["Commodores ×N", "Objectives ×N", "1 commander", "Members ×0–N"],
    rest: 6,
    canvas: {
      brand: "Fleet Console",
      you: "You",
      legend0: "Commodores ×N",
      legend1: "Objectives ×N",
      inside: "Inside one objective",
      commander: "Commander",
      members: "Members ×0–N",
      membersSub: "running missions",
    },
  },
  {
    chapter: "How Fleet is organized",
    title: "Direction flows outward, results gather inward",
    body: "The direction you set ripples out through commodores, commanders, and members like a wave. When the work ends, evidence fills the done criteria and returns to you through retrospectives and commodore review.",
    tags: ["Direction → plan → missions", "Evidence → done criteria → retrospectives → commodore review"],
    rest: 4.2,
    canvas: {
      inner: "Commodore",
      innerResult: "Commodore review",
      middle: "Commander",
      middleResult: "Done criteria · retrospective",
      outer: "Member",
      outerResult: "Evidence",
      you: "You",
      outward: "Direction",
      outwardSub: "Flows outward",
      inward: "Results",
      inwardSub: "Gather inward",
    },
  },
  {
    chapter: "How Fleet is organized",
    title: "A TaskForce gathers several commodores around one topic",
    body: "A group conversation where two or more commodores talk through a single topic. Each commodore only receives the utterances that arrived after their last read. Turn it on in Settings › Experimental.",
    tags: ["Commodores ×2–N", "One topic", "Only new utterances", "Experimental"],
    rest: 5,
    canvas: {
      topic: "One topic",
      a: "Commodore A",
      b: "Commodore B",
      c: "Commodore C",
      d: "Commodore D",
      note: "Only new utterances travel between them",
      lab: "Experimental",
    },
  },
  {
    chapter: "AI engineering, in Fleet",
    tech: "Context Engineering",
    title: "Context engineering · only what passes the lens goes in",
    body: "What an agent reads decides the outcome. Fleet doesn't pour in every accumulated record — the commodore's description stays the top authority, and only what's needed is picked out.",
    tags: ["Description · top authority", "Intel", "Memory", "Briefs keep source text & images", "Objective record search", "Handoff summaries on session change", "TaskForce's newest utterances"],
    rest: 5,
    canvas: {
      pile: "Piled-up records",
      reading: "What the agent reads",
      pick: "Curating",
      item0: "Description leads",
      item1: "Intel (intel)",
      item2: "Memory (fleet-memory)",
      item3: "Brief source text · images",
      item4: "Objective record search",
      item5: "Session-handoff recap",
      item6: "TaskForce new utterances",
    },
  },
  {
    chapter: "AI engineering, in Fleet",
    tech: "Harness Engineering",
    title: "Harness engineering · layers wrapped around the model",
    body: "The same model performs differently depending on the rules, tools, and isolation it works inside. Fleet sets rules and routines per theater, and manages model selection and usage too.",
    tags: ["Per-theater CLAUDE.md", "skills", "MCP tools", "Worktree isolation", "AI Gateway routing", "Quota"],
    rest: 4.5,
    canvas: {
      model: "Model",
      shell0: "Rules & routines",
      shell0Sub: "Per-theater CLAUDE.md · skills",
      shell1: "Tools & isolation",
      shell1Sub: "MCP tools · worktree isolation",
      shell2: "Models & usage",
      shell2Sub: "AI Gateway routing · Quota",
    },
  },
  {
    chapter: "AI engineering, in Fleet",
    tech: "Loop Engineering",
    title: "Loop engineering · keeps turning until it's done",
    body: "The commander plans, runs missions, and only hands off once evidence fills the done criteria. Notifications wake it up, and a stall shows up as stuck.",
    tags: ["Plan → mission → evidence → done criteria → handoff", "Wakes on notifications", "Routines", "Stall detection", "Review gates"],
    rest: 5.2,
    canvas: {
      lead: "Commander",
      leadSub: "Until it's done",
      node0: "Plan",
      node1: "Mission",
      node2: "Evidence",
      node3: "Done criteria",
      node4: "Handoff",
      side0: "Wakes on notifications",
      side1: "Routines start on schedule",
      side2: "A stall shows as stuck",
      side3: "PRs merge after review & checks",
    },
  },
  {
    chapter: "AI engineering, in Fleet",
    tech: "Double Loop",
    title: "Double loop · a learning wheel above the working wheel",
    body: "On the outer wheel, the commodore sets objectives and judges results. On the smaller wheel above it, the commander runs missions. Lessons from retrospectives flow back into rules and skills, changing the next round of work.",
    tags: ["Outer · commodore", "Inner · commander", "Retrospective", "learning-harvest", "Rule · skill updates", "Memory lessons"],
    rest: 7,
    canvas: {
      outer: "Outer wheel · commodore",
      inner: "Inner wheel · the commander's missions",
      stop0: "Description · intel",
      stop1: "Objective",
      stop2: "Judging results",
      learn0: "Retrospective",
      learn1: "learning-harvest",
      learn2: "Rule · skill updates",
      memory: "Also kept as lessons in memory",
    },
  },
  {
    chapter: "AI engineering, in Fleet",
    tech: "Graph Engineering",
    title: "Graph engineering · missions strung like constellations",
    body: "The commander links prerequisite lines between missions like a constellation. When one mission finishes, the next star lights up; missions that needn't wait for each other light up together. The objective that built this very guide was planned the same way.",
    tags: ["Prerequisite graph", "Parallel first", "Objective → follow-ups", "Commodore → commander → member"],
    rest: 6,
    canvas: {
      a: "Mockup",
      b: "Approval",
      c: "Implementation",
      d: "Verification prep",
      e: "Live verification",
      f: "Merge",
      followup: "Follow-up objective",
      together: "Light up together",
    },
  },
  {
    chapter: "AI engineering, in Fleet",
    tech: "Agent Engineering",
    title: "Agent engineering · split the work, match the model",
    body: "Commodores, commanders, and members each do their own job. Like a prism, the AI Gateway looks at each mission's difficulty and routes it to a fitting model. Screen control and browser tools are available too.",
    tags: ["Separated roles", "Difficulty-based model routing", "TaskForce", "Computer Use", "Browser"],
    rest: 4.5,
    canvas: {
      stream: "Missions big and small",
      light: "Light model",
      balanced: "Balanced model",
      strong: "Strong model",
      gateway: "AI Gateway",
      role0: "Commodore",
      role0Sub: "Directs & judges",
      role1: "Commander",
      role1Sub: "Plans & integrates",
      role2: "Member",
      role2Sub: "Runs missions",
      tools: "Computer Use · Browser",
    },
  },
  {
    chapter: "Recap",
    title: "Six techniques, the Fleet way",
    body: "Safe to close — reopen it anytime from the app menu under Help › Fleet at a glance.",
    tags: [],
    rest: 0,
    canvas: {},
    summary: true,
  },
];

export function fleetGlanceScenes(locale: ConsoleLocale): readonly FleetGlanceSceneCopy[] {
  return locale === "ko" ? scenesKo : scenesEn;
}

const summaryKo: readonly FleetGlanceSummaryRow[] = [
  { icon: "lens", title: "컨텍스트 엔지니어링", body: "설명을 기준으로, 필요한 기록만 골라 넣어요", detail: "설명 · 정보 · 기억 · brief" },
  { icon: "shells", title: "하네스 엔지니어링", body: "규칙·도구·격리로 모델을 감싸요", detail: "CLAUDE.md · skills · worktree" },
  { icon: "comet", title: "루프 엔지니어링", body: "증거로 완료 기준을 채울 때까지 돌아요", detail: "계획 → 미션 → 증거 → 인계" },
  { icon: "spiro", title: "이중 루프", body: "일하는 바퀴 위에서 배우는 바퀴가 돌아요", detail: "회고 → learning-harvest" },
  { icon: "stars", title: "그래프 엔지니어링", body: "선행 관계로 잇고, 기다릴 필요 없는 건 동시에", detail: "미션 그래프 · 후속 목표" },
  { icon: "prism", title: "에이전트 엔지니어링", body: "역할을 나누고 일에 맞는 모델을 골라요", detail: "역할 · AI Gateway 라우팅" },
];

const summaryEn: readonly FleetGlanceSummaryRow[] = [
  { icon: "lens", title: "Context engineering", body: "The description leads; only needed records go in", detail: "Description · intel · memory · briefs" },
  { icon: "shells", title: "Harness engineering", body: "Rules, tools, and isolation wrap the model", detail: "CLAUDE.md · skills · worktrees" },
  { icon: "comet", title: "Loop engineering", body: "Circles until evidence fills the done criteria", detail: "Plan → mission → evidence → handoff" },
  { icon: "spiro", title: "Double loop", body: "A learning wheel turns above the working wheel", detail: "Retrospective → learning-harvest" },
  { icon: "stars", title: "Graph engineering", body: "Linked by prerequisites; independent ones run together", detail: "Mission graph · follow-ups" },
  { icon: "prism", title: "Agent engineering", body: "Split roles, route each job to a fitting model", detail: "Roles · AI Gateway routing" },
];

export function fleetGlanceSummary(locale: ConsoleLocale): readonly FleetGlanceSummaryRow[] {
  return locale === "ko" ? summaryKo : summaryEn;
}
