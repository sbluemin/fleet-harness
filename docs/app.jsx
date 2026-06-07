const { useState, useEffect, useRef } = React;

// ───── Locale ─────
const lang = (typeof navigator !== "undefined" && navigator.language && navigator.language.startsWith("ko")) ? "ko" : "en";
if (typeof document !== "undefined" && document.documentElement) {
  document.documentElement.lang = lang;
}
const t = (obj) => (obj && typeof obj === "object" && (obj.ko || obj.en)) ? (obj[lang] ?? obj.en ?? obj.ko) : obj;

// ───── UI strings ─────
const UI = {
  navHierarchy: { ko: "지휘 체계", en: "Command Chain" },
  navCaptains:  { ko: "8 함장", en: "8 Captains" },
  navProtocol:  { ko: "4 모드", en: "4 Modes" },
  navDiffs:     { ko: "차별점", en: "Why us" },
  primaryAria:  { ko: "주요 메뉴", en: "Primary" },

  heroEyebrow:  { ko: "Fleet Action Protocol · v1", en: "Fleet Action Protocol · v1" },
  heroTitle:    { ko: ["단일 인터페이스에서", "함대 전체를 지휘하라."], en: ["Command an entire fleet", "from a single interface."] },
  heroDescPre:    { ko: "fleet-harness는 Claude Code, Codex 같은 CLI 에이전트를 네이티브로 오케스트레이션하는 멀티-LLM 하네스입니다. 사용자는 ", en: "fleet-harness is a multi-LLM harness that natively orchestrates CLI agents like Claude Code and Codex. You command as the " },
  heroDescAdmiral:{ ko: "대원수", en: "Admiral of the Navy" },
  heroDescMid:    { ko: "로서 임무를 부여하고, 호스트인 ", en: ", while the host — the " },
  heroDescHost:   { ko: "제독", en: "Admiral" },
  heroDescMid2:   { ko: "이 8명의 ", en: " — delegates to eight " },
  heroDescCap:    { ko: "함장", en: "Captains" },
  heroDescTail:   { ko: "에게 책임을 위임해 작전을 종결합니다.", en: " who close the operation." },

  ctaRepo:      { ko: "저장소 살펴보기", en: "Explore the repo" },
  ctaCaptains:  { ko: "함장 명단 보기", en: "Meet the captains" },
  ctaGithubView:{ ko: "GitHub에서 보기", en: "View on GitHub" },
  ctaProtocol:  { ko: "Fleet Action Protocol 보기", en: "See the Fleet Action Protocol" },

  metaBackends: { ko: "CLI Backends", en: "CLI Backends" },
  metaBackendsVal: { ko: "Anthropic / OpenAI / Google / OSS", en: "Anthropic / OpenAI / Google / OSS" },
  metaCaptains: { ko: "Captains", en: "Captains" },
  metaCaptainsVal: { ko: "명시적 책임 분리", en: "Distinct responsibilities" },
  metaProtocol: { ko: "Protocol", en: "Protocol" },
  metaProtocolVal: { ko: "Intent → Mode → Execute", en: "Intent → Mode → Execute" },

  hierarchyEy:  { ko: "Chain of Command", en: "Chain of Command" },
  hierarchyTitle: { ko: "3-단 지휘 체계", en: "Three-tier command structure" },
  hierarchyLede:  { ko: "사용자는 코드를 쓰지 않는다. 결정한다. 함대는 그 결정을 작전으로 환원한다.", en: "You don't write code — you decide. The fleet turns each decision into an operation." },

  backendsEy:    { ko: "CLI Backends · 06", en: "CLI Backends · 06" },
  backendsTitle: { ko: ["여섯 개의 CLI,", "한 명의 제독."], en: ["Six CLIs,", "one Admiral."] },
  backendsLede:  { ko: "한 모델로 모든 작전을 수행하지 않는다. 각 백엔드는 자신이 가장 잘하는 항해를 맡는다.", en: "No single model runs every mission. Each backend takes the voyage it sails best." },

  captainsEy:    { ko: "Captains Roster · 08", en: "Captains Roster · 08" },
  captainsTitle: { ko: ["여덟 명의 함장,", "겹치지 않는 여덟 개의 책임."], en: ["Eight captains,", "eight non-overlapping duties."] },
  captainsLede:  { ko: "함장은 장식이 아닌 운영 계약이다. 좌측에서 함장을 선택하면 임무 강령과 책임 명세가 펼쳐진다.", en: "Captains aren't decoration — they're operational contracts. Pick one to see its mission and duties." },
  captainsAria:  { ko: "함장 명단", en: "Captains list" },
  captainCap:    { ko: "Captain", en: "Captain" },
  responsibilities: { ko: "Responsibilities", en: "Responsibilities" },

  protocolEy:    { ko: "Fleet Action Protocol · 04", en: "Fleet Action Protocol · 04" },
  protocolTitle: { ko: ["하나의 게이트,", "네 개의 모드."], en: ["One gate,", "four modes."] },
  protocolLede:  { ko: "모든 요청은 Intent Gate에서 대화형과 작전형으로 갈린다. 작전형은 Mode Gate에서 정확히 하나의 모드를 고르고, 진입 전 Gate Declaration 한 줄을 반드시 선언한다. 하향 가드가 가벼운 모드로의 도피를 막는다.", en: "Every request splits at the Intent Gate — conversational or operational. Operational work picks exactly one mode at the Mode Gate and must emit a one-line Gate Declaration before entry. The downward guard blocks any escape into a lighter mode." },
  protocolAria:  { ko: "Fleet Action Protocol 모드", en: "Fleet Action Protocol modes" },
  phaseLabel:    { ko: "Mode", en: "Mode" },

  ordersEy:    { ko: "Standing Orders · Always Active", en: "Standing Orders · Always Active" },
  ordersTitle: { ko: ["항상 켜져 있는", "다섯 개의 명령."], en: ["Five orders,", "always on."] },
  ordersLede:  { ko: "어떤 프로토콜 모드에도 종속되지 않고 모든 작전 위에 상시 작동하는 호스트 차원의 안전 장치. 대화형 요청에서도 꺼지지 않는다.", en: "Host-level safeguards that run above every mission, bound to no protocol mode — and never switched off, even on conversational requests." },
  active:      { ko: "Active", en: "Active" },

  diffsEy:    { ko: "What sets it apart · 04", en: "What sets it apart · 04" },
  diffsTitle: { ko: ["왜 또 하나의", "에이전트 프레임워크가 아닌가."], en: ["Why this isn't", "just another agent framework."] },

  compareEy:    { ko: "Landscape", en: "Landscape" },
  compareTitle: { ko: "에이전트 지형도 위에서.", en: "On the agent-tooling landscape." },
  compareLede:  { ko: "비슷한 도구는 많다. 그러나 처음부터 함대로 설계된 도구는 드물다.", en: "Plenty of similar tools. Few are designed as a fleet from day one." },

  closerEy:    { ko: "Mission Brief · Ready", en: "Mission Brief · Ready" },
  closerTitle: { ko: ["함대는", "당신의 명령을 기다린다."], en: ["The fleet awaits", "your orders."] },
  closerSub:   { ko: "저장소를 살펴보고, 첫 임무를 부여하라. 정찰부터 항해일지까지, 함대가 알아서 끝낸다.", en: "Explore the repo, issue your first mission. From recon to the captain's log, the fleet handles the rest." },
  installCmt:  { ko: "# install the harness", en: "# install the harness" },
  setSailCmt:  { ko: "# Set sail on your first mission, Admiral.", en: "# Set sail on your first mission, Admiral." },
  footerLine:  { ko: "fleet-harness · Fleet Action Protocol v1", en: "fleet-harness · Fleet Action Protocol v1" },
  builtOn:     { ko: "native CLI orchestration", en: "native CLI orchestration" },
  countMeta:   { ko: "· 6 CLI · 8 Captains · 4 Modes", en: "· 6 CLI · 8 Captains · 4 Modes" },
};

// ───── Data ─────
const HIERARCHY = [
  {
    rank: "Tier 01",
    role: { ko: "대원수", en: "Admiral of the Navy" },
    en: "Admiral of the Navy · USER",
    desc: { ko: "최종 의사 결정자. 임무를 부여하고 함대의 행동을 승인한다.", en: "The final decision-maker. Issues missions and approves every fleet action." },
  },
  {
    rank: "Tier 02",
    role: { ko: "제독", en: "Admiral" },
    en: "Admiral · HOST",
    desc: { ko: "함대 지휘관. 임무를 분해하고 적임 함장에게 위임하며, 결과를 통합·검증한다.", en: "Fleet commander. Decomposes the mission, delegates to the right captain, then integrates and verifies the results." },
  },
  {
    rank: "Tier 03",
    role: { ko: "함장", en: "Captain" },
    en: "Captain · CLI AGENT",
    desc: { ko: "8명의 전문 함장. 각자의 영역에서 단일 CLI 백엔드를 운용해 작전을 수행한다.", en: "Eight specialists, each running a single CLI backend within their domain to execute the operation." },
  },
];

const CLI_BACKENDS = [
  { num: "01", vendor: "Anthropic", name: "Claude Code", tag: { ko: "장기 추론·아키텍처 판단의 표준 백엔드", en: "The standard backend for long-form reasoning and architectural judgment." }, color: "oklch(78% 0.13 75)" },
  { num: "02", vendor: "Z.AI", name: "Claude Code · GLM", tag: { ko: "Anthropic 호환 · GLM 구동 코스트 절감 라인", en: "Anthropic-compatible — a GLM-powered cost-cutting line." }, color: "oklch(82% 0.13 195)" },
  { num: "03", vendor: "Moonshot", name: "Claude Code · Kimi", tag: { ko: "Anthropic 호환 · 초장문 컨텍스트 라인", en: "Anthropic-compatible — the ultra-long-context line." }, color: "oklch(78% 0.14 290)" },
  { num: "04", vendor: "OpenAI", name: "Codex", tag: { ko: "도구 호출과 실행 위임에 최적화된 작업 함정", en: "A working vessel optimized for tool calls and execution delegation." }, color: "oklch(72% 0.17 25)" },
  { num: "05", vendor: "Google", name: "Gemini", tag: { ko: "외부 인텔리전스 · 대규모 컨텍스트 정찰함", en: "External intelligence — a long-range reconnaissance ship." }, color: "oklch(78% 0.14 145)" },
  { num: "06", vendor: "Open Source", name: "OpenCode Go", tag: { ko: "오픈코어 폴백 · 자체 호스팅 모델 게이트웨이", en: "Open-core fallback — a self-hosted model gateway." }, color: "oklch(74% 0.06 248)" },
];

const CAPTAINS = [
  {
    id: "Vanguard",
    role: { ko: "Scout Specialist", en: "Scout Specialist" },
    cli: "Codex CLI",
    color: "#5fd673",
    mission: { ko: "안개를 먼저 가르는 자. 함대 어떤 작전보다 먼저 정찰을 띄운다.", en: "First to part the fog. Sails ahead of every fleet operation." },
    duties: [
      { ko: "코드베이스 정찰 — 디렉터리·심볼·호출 그래프 추적", en: "Codebase reconnaissance — directories, symbols, call graphs." },
      { ko: "분산 정찰 — 서브-스카우트 동시 파견으로 면적 확보", en: "Distributed scouting — parallel sub-scouts cover ground fast." },
      { ko: "웹 리서치 — 외부 레퍼런스·표준·라이브러리 문서 수집", en: "Web research — external references, standards, library docs." },
      { ko: "지식 갭 좌표화 — Reconnaissance 단계 입력으로 환원", en: "Map knowledge gaps — feed them into the Reconnaissance phase." },
    ],
  },
  {
    id: "Tempest",
    role: { ko: "External Intelligence Strike", en: "External Intelligence Strike" },
    cli: "Gemini CLI",
    color: "#3dd5f3",
    mission: { ko: "수평선 너머의 코드를 가져온다. 외부 저장소·API·SDK는 모두 그의 사정거리.", en: "Brings back code from beyond the horizon. External repos, APIs, SDKs are all in range." },
    duties: [
      { ko: "GitHub 외부 저장소 조사 및 비교 분석", en: "External GitHub repository survey and comparative analysis." },
      { ko: "API·SDK 시그니처와 의미론 분석", en: "API/SDK signature and semantic analysis." },
      { ko: "라이선스·종속성 영향 평가", en: "License and dependency impact assessment." },
      { ko: "외부 레퍼런스 → 내부 적용 가능성 보고", en: "Reports on whether external references can be adopted internally." },
    ],
  },
  {
    id: "Nimitz",
    role: { ko: "Strategic Command & Judgment", en: "Strategic Command & Judgment" },
    cli: "Claude Code",
    color: "#d4af37",
    mission: { ko: "방아쇠를 당기지 않는다. 그러나 어디에 어떻게 당길지를 결정한다. Read-only 전략 사령관.", en: "Doesn't pull the trigger — decides where and how it should be pulled. The read-only strategic commander." },
    duties: [
      { ko: "아키텍처 결정 (ADR) — 트레이드오프 및 위험 분석", en: "Architecture decisions (ADRs) — tradeoffs and risk analysis." },
      { ko: "전략 판단 — 대안 비교, 우선순위, 진행 여부", en: "Strategic judgment — alternatives, priorities, go/no-go." },
      { ko: "Task Force 합의 — 다중 함장 결과 중재", en: "Task Force consensus — arbitrating multi-captain outputs." },
      { ko: "Read-only 모드 — 실행은 위임, 판단만 수행", en: "Read-only mode — judgment only; execution is delegated." },
    ],
  },
  {
    id: "Kirov",
    role: { ko: "Operational Planning Bridge", en: "Operational Planning Bridge" },
    cli: "Claude Code",
    color: "#e8a854",
    mission: { ko: "전략을 작전 명령서로 옮긴다. .fleet/plans/*.md — 모든 다단 작전의 단일 진실원.", en: "Translates strategy into operation orders. .fleet/plans/*.md — the single source of truth for every multi-stage op." },
    duties: [
      { ko: "작전 계획서(.fleet/plans/*.md) 작성·갱신", en: "Authors and maintains operation plans (.fleet/plans/*.md)." },
      { ko: "Wave 분해 · 의존성 그래프 정의", en: "Wave decomposition and dependency graph definition." },
      { ko: "Acceptance criteria · 검증 게이트 명시", en: "Specifies acceptance criteria and verification gates." },
      { ko: "Ohio 등 실행 함장에 plan_file 전달", en: "Hands the plan_file to executors like Ohio." },
    ],
  },
  {
    id: "Genesis",
    role: { ko: "Chief Engineer", en: "Chief Engineer" },
    cli: "Codex CLI",
    color: "#ff6b6b",
    mission: { ko: "단일 결정타. 신규 모듈·통합·마이그레이션을 한 번의 항해로 종결한다.", en: "The decisive blow. Closes new modules, integrations, and migrations in a single voyage." },
    duties: [
      { ko: "단일 함정 구현 — 새 기능, 모듈, 시스템 통합", en: "Single-vessel implementation — new features, modules, system integrations." },
      { ko: "프레임워크 마이그레이션 · 대규모 리팩터", en: "Framework migrations and large-scale refactors." },
      { ko: "빌드 게이트 통과를 책임지는 구현 표준", en: "Owns the implementation standard required to pass the build gate." },
      { ko: "패치보다 시스템 — 일관성을 잃을 바엔 다시 짠다", en: "System over patch — would rather rewrite than lose consistency." },
    ],
  },
  {
    id: "Ohio",
    role: { ko: "Multi-Wave Strike Execution", en: "Multi-Wave Strike Execution" },
    cli: "Codex CLI",
    color: "#a78bfa",
    mission: { ko: "Kirov의 명령서를 받아 파(Wave) 단위로 발사한다. 다단 작전의 실집행 잠수함.", en: "Receives Kirov's orders and fires by wave. The submarine that actually executes multi-stage ops." },
    duties: [
      { ko: "plan_file 수신 → wave별 순차 실행", en: "Receives plan_file and runs each wave in sequence." },
      { ko: "각 wave 후 빌드·테스트·검증 게이트", en: "Build / test / verification gate after every wave." },
      { ko: "롤백 가능 단위로 커밋·체크포인트 유지", en: "Keeps commits and checkpoints at rollback-safe granularity." },
      { ko: "장기 다단 마이그레이션의 1차 실집행자", en: "Primary executor for long, multi-stage migrations." },
    ],
  },
  {
    id: "Sentinel",
    role: { ko: "The Inquisitor · QA & Security Lead", en: "The Inquisitor · QA & Security Lead" },
    cli: "Codex CLI",
    color: "#fb7185",
    mission: { ko: "함대의 검열관. 어떤 코드도 그의 의심을 거치지 않고는 실전에 투입되지 않는다.", en: "The fleet's inquisitor. No code reaches the front line without surviving his doubt." },
    duties: [
      { ko: "코드 리뷰 — 시맨틱·성능·테스트 커버리지", en: "Code review — semantics, performance, test coverage." },
      { ko: "보안 감사 — OWASP Top 10, 권한 모델, 비밀 관리", en: "Security audit — OWASP Top 10, permission models, secret handling." },
      { ko: "버그 헌팅 · 침투 테스트 시나리오 작성", en: "Bug hunting and penetration-test scenario authoring." },
      { ko: "Review Cycle에서 Genesis 결과를 병렬 심문", en: "Interrogates Genesis's output in parallel during the Review Cycle." },
    ],
  },
  {
    id: "Chronicle",
    role: { ko: "Chief Knowledge Officer", en: "Chief Knowledge Officer" },
    cli: "Gemini CLI",
    color: "#3dd5f3",
    mission: { ko: "함대의 기억. 작전이 끝나기 전 마지막으로 항해일지를 닫는 자.", en: "The fleet's memory. The last hand to close the captain's log before the operation ends." },
    duties: [
      { ko: "AGENTS.md · 함장 운영 매뉴얼 유지", en: "Maintains AGENTS.md and the captains' operating manual." },
      { ko: "PR 요약 · 변경 영향 감사 보고", en: "PR summaries and change-impact audit reports." },
      { ko: "문서 SSOT 동기화 — 코드와 일지의 차이 추적", en: "Doc SSOT sync — tracks divergence between code and log." },
      { ko: "Documentation Update 단계의 단독 책임자", en: "Sole owner of the Documentation Update phase." },
    ],
  },
];

const MODES = [
  {
    n: "01",
    name: "Trivial",
    kr: { ko: "사소", en: "Trivial" },
    tag: { ko: "단일 표면", en: "Single surface" },
    required: false,
    desc: { ko: "단순하고 가역적이며 단일 표면에 닿는 작업. 계획 부담이 거의 없는 최소 절차로 즉시 실행한다.", en: "Simple, reversible work that touches a single surface. Run it immediately with minimal planning overhead." },
    points: [
      { m: "SCOPE", t: { ko: "**단일·가역 표면** — 오타 수정, 로그 한 줄, 지역 변수 개명 수준.", en: "**Single, reversible surface** — a typo, one log line, a local rename." } },
      { m: "GUARD", t: { ko: "비가역·구조·다중 모듈·독트린 변경이 끼면 진입 금지, 상향 게이트로.", en: "Anything irreversible, structural, multi-module, or doctrine-level forbids entry — escalate." } },
    ],
  },
  {
    n: "02",
    name: "Standard",
    kr: { ko: "표준", en: "Standard" },
    tag: { ko: "기본", en: "Default" },
    required: false,
    desc: { ko: "하향 가드를 건드리지 않는 일반적인 경계형 작전. 모드가 모호할 때의 기본 폴백이기도 하다.", en: "Ordinary bounded work that doesn't trip the downward guard — and the default fallback when the mode is ambiguous." },
    points: [
      { m: "FLOW", t: { ko: "**정찰 → 계획 경계 → 인라인 계획 → 실집행 → 검증 → 문서**.", en: "**Recon → planning boundary → inline plan → execution → verification → docs**." } },
      { m: "GATE", t: { ko: "계획 경계 진입엔 complete 확신 — 차단 갭이 남으면 못 들어간다.", en: "The planning boundary demands complete confidence — no entry with blocking gaps open." } },
    ],
  },
  {
    n: "03",
    name: "High-Risk",
    kr: { ko: "고위험", en: "High-Risk" },
    tag: { ko: "강제 통제", en: "Hard controls" },
    required: true,
    desc: { ko: "비가역 작업, 구조·API 변경, 다중 모듈 편집, 독트린·프롬프트 정책 수정, 보안 민감 작업. 명시적 위험 통제 없이는 한 줄도 쓰지 않는다.", en: "Irreversible ops, structural/API changes, cross-module edits, doctrine or prompt-policy edits, security-sensitive work. Not a line ships without explicit risk controls." },
    points: [
      { m: "TRIGGER", t: { ko: "**하향 가드 발동** — 비가역·구조·계약·독트린·보안 중 하나라도.", en: "**Downward guard fires** — any of irreversible, structural, contract, doctrine, or security." } },
      { m: "CONTROL", t: { ko: "롤백 단위·명시적 통제·증거 기반 진행을 강제한다.", en: "Enforces rollback units, explicit controls, and evidence-backed progress." } },
    ],
  },
  {
    n: "04",
    name: "Multi-Agent",
    kr: { ko: "다중 함장", en: "Multi-Agent" },
    tag: { ko: "병렬 협조", en: "Coordinated" },
    required: true,
    desc: { ko: "여러 함장, 독립 병렬 작업 줄기, 교차 함장 리뷰 루프, 파일 소유권 조정이 필요한 작전. 협조 자체가 핵심이다.", en: "Work that needs multiple captains, independent parallel workstreams, cross-captain review loops, and file-ownership coordination. Coordination is the whole point." },
    points: [
      { m: "COORD",     t: { ko: "**다중 함장 병렬 출격** — 같은 단계의 함장은 기본이 병렬.", en: "**Multiple captains in parallel** — same-phase captains launch concurrently by default." } },
      { m: "OWNERSHIP", t: { ko: "파일 소유권 경계와 교차 리뷰 루프를 관리한다.", en: "Manages file-ownership boundaries and cross-review loops." } },
    ],
  },
];

const ORDERS = [
  {
    name: "Mission Anchor",
    kr: { ko: "임무 정렬", en: "Mission Anchor" },
    desc: { ko: "임무 목표를 단 한 문장의 북극성으로 고정한다. 모든 체크포인트 진입 전 목표를 복창하고, 진출 후 정렬을 자가 점검하며, 표류가 감지되면 즉시 정지·복귀한다.", en: "Pins the mission to a single-sentence north star. Recall the objective before every checkpoint, self-check alignment after, and halt to recover the moment drift appears." },
  },
  {
    name: "Context Confidence",
    kr: { ko: "맥락 확신", en: "Context Confidence" },
    desc: { ko: "결정 경계에 들어서기 전 증거 충분성을 complete·sufficient·partial·speculative로 판정한다. 증거 목록 없는 확신은 speculative로 강등되고, 기준 미달이면 정찰로 재진입한다.", en: "Grades evidence sufficiency — complete, sufficient, partial, speculative — before any decision boundary. Confidence with no evidence list is demoted to speculative; below threshold, it re-enters reconnaissance." },
  },
  {
    name: "Carrier Operations Policy",
    kr: { ko: "함대 운용 정책", en: "Carrier Operations Policy" },
    desc: { ko: "실행은 위임하고 판단은 보유한다. 작업 복잡도에 함대 규모를 비례시키고, 같은 단계의 다중 함장은 기본적으로 병렬 출격시킨다.", en: "Delegate execution, retain judgment. Size the fleet to the task's complexity, and launch same-phase captains in parallel by default." },
  },
  {
    name: "Deep Dive",
    kr: { ko: "딥 다이브", en: "Deep Dive" },
    desc: { ko: "추측이 발견되는 즉시 자동 검증을 띄운다. 동일 가정에 대해 최대 2회까지 재검증하고, 그래도 불확실하면 대원수에게 회부한다.", en: "Auto-verification launches the moment a guess appears. Up to two re-checks per assumption — still uncertain, it escalates to the Admiral of the Navy." },
  },
  {
    name: "Result Integrity",
    kr: { ko: "결과 무결성", en: "Result Integrity" },
    desc: { ko: "함장이 가져온 결과는 관련성·완결성·내부 충돌 3축으로 검사한다. 어느 하나라도 어긋나면 자동 재시도하고, 실패가 누적되면 대원수에게 보고한다.", en: "Captain results are checked on three axes — relevance, completeness, internal consistency. Any failure triggers a retry; repeated failure is reported to the Admiral of the Navy." },
  },
];

const DIFFS = [
  {
    n: "01",
    name: "Multi-CLI Orchestration",
    kr: { ko: "멀티-CLI 오케스트레이션", en: "Multi-CLI Orchestration" },
    body: { ko: "단일 인터페이스 아래 6개의 CLI 백엔드 — Claude Code 라인 3종, Codex, Gemini, OpenCode Go — 가 함께 실행된다. 모델별 강점을 작전 단위로 골라 쓴다.", en: "Six CLI backends — three Claude Code lines, Codex, Gemini, OpenCode Go — run together under one interface. Pick each model's strength on a per-operation basis." },
  },
  {
    n: "02",
    name: "Naval Metaphor as Contract",
    kr: { ko: "운영 가능한 해군 메타포", en: "An Operational Naval Metaphor" },
    body: { ko: "장식이 아니다. 8명 함장은 각자 서로 겹치지 않는 책임 영역을 가진 운영 계약이다. Vanguard에게 ADR을 시키지 않고, Nimitz에게 코드를 쓰게 하지 않는다.", en: "Not decoration. Each of the eight captains is an operational contract with non-overlapping duties. Vanguard doesn't write ADRs; Nimitz doesn't write code." },
  },
  {
    n: "03",
    name: "Task Force & Squadron",
    kr: { ko: "Wave", en: "Wave" },
    body: { ko: "Task Force는 여러 백엔드의 결과를 합의 알고리즘으로 통합. Squadron은 동일 작전을 병렬 분기로 동시에 시도하고 가장 우수한 줄기를 채택한다.", en: "Task Force fuses outputs from multiple backends through a consensus algorithm. Squadron tries the same operation along parallel branches and adopts the strongest one." },
  },
  {
    n: "04",
    name: "Architectural Discipline",
    kr: { ko: "아키텍처 규율", en: "Architectural Discipline" },
    body: { ko: "빌드 게이트는 협상 불가. SSOT(.fleet/plans/*.md, AGENTS.md, ADR)는 강제 동기화. 각 wave는 그 자체로 컴파일·테스트를 통과해야 다음으로 진행한다.", en: "Build gates are non-negotiable. SSOT (.fleet/plans/*.md, AGENTS.md, ADRs) stays force-synced. Each wave must compile and test on its own to advance." },
  },
];

const COMPARES = [
  {
    cat: { ko: "단일 LLM", en: "Single-LLM" },
    name: "Claude Code · Cursor · Aider",
    bullets: [
      { ko: "1 모델 ↔ 1 컨텍스트", en: "One model ↔ one context" },
      { ko: "사용자가 역할 분리", en: "User splits the roles" },
      { ko: "수동 컨텍스트 전환", en: "Manual context switching" },
    ],
    verdict: { ko: "한 명의 천재. 그러나 함장이 아니라 일등 항해사다.", en: "A lone genius — a first mate, not a captain." },
  },
  {
    cat: { ko: "멀티 에이전트 프레임", en: "Multi-agent framework" },
    name: "AutoGen · CrewAI · LangGraph",
    bullets: [
      { ko: "역할 정의 자유도 높음", en: "Highly flexible role definition" },
      { ko: "그래프·메시지 기반", en: "Graph- and message-based" },
      { ko: "프레임워크 학습 비용", en: "Framework learning cost" },
    ],
    verdict: { ko: "설계도는 강하다. 하지만 실제 함정은 직접 띄워야 한다.", en: "Strong blueprints — but you still launch the ships yourself." },
  },
  {
    cat: { ko: "컨테이너 격리형", en: "Container-isolated" },
    name: "OpenHands · Devin",
    bullets: [
      { ko: "가상 환경에서 자율 실행", en: "Autonomous execution in a virtual env" },
      { ko: "엔드-투-엔드 지향", en: "End-to-end oriented" },
      { ko: "백엔드 모델 단일/제한", en: "Single or limited backend models" },
    ],
    verdict: { ko: "강력한 단일 함정. 함대는 아니다.", en: "A powerful single vessel. Not a fleet." },
  },
  {
    cat: "fleet-harness",
    name: "Fleet Action Protocol",
    us: true,
    bullets: [
      { ko: "6 CLI 백엔드 동시 지휘", en: "Six CLI backends commanded together" },
      { ko: "8 함장 명시적 책임 분리", en: "Eight captains, distinct duties" },
      { ko: "적응형 4-모드 프로토콜 게이트", en: "Adaptive four-mode protocol gate" },
    ],
    verdict: { ko: "처음부터 함대로 설계되었다.", en: "Designed as a fleet from day one." },
  },
];

// ───── Top nav ─────
function Nav() {
  return (
    <header className="topnav">
      <div className="shell topnav-inner">
        <a href="#top" className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 20h20" />
              <path d="M5 20l-2-7h18l-2 7" />
              <path d="M12 4v9" />
              <path d="M8 8h8" />
            </svg>
          </span>
          fleet-harness
        </a>
        <nav className="nav-links" aria-label={t(UI.primaryAria)}>
          <a href="#hierarchy">{t(UI.navHierarchy)}</a>
          <a href="#captains">{t(UI.navCaptains)}</a>
          <a href="#protocol">{t(UI.navProtocol)}</a>
          <a href="#diffs">{t(UI.navDiffs)}</a>
        </nav>
        <a href="https://github.com/sbluemin/fleet-harness.git" className="nav-cta" target="_blank" rel="noreferrer">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 .5C5.7.5.5 5.7.5 12c0 5 3.3 9.3 7.8 10.8.6.1.8-.3.8-.6v-2.1c-3.2.7-3.9-1.5-3.9-1.5-.5-1.4-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.8-1.6-2.6-.3-5.4-1.3-5.4-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.2 1.2.9-.3 1.9-.4 2.9-.4s2 .1 2.9.4c2.2-1.5 3.2-1.2 3.2-1.2.6 1.7.2 2.9.1 3.2.7.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.4 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6 4.5-1.5 7.8-5.8 7.8-10.8C23.5 5.7 18.3.5 12 .5z" />
          </svg>
          GitHub
        </a>
      </div>
    </header>
  );
}

// ───── Hero ─────
function Hero() {
  const nodeCount = 6;
  const radius = 38;
  const nodes = Array.from({ length: nodeCount }, (_, i) => {
    const angle = (i / nodeCount) * Math.PI * 2 - Math.PI / 2;
    return {
      x: 50 + Math.cos(angle) * radius,
      y: 50 + Math.sin(angle) * radius,
      label: ["VG", "TP", "NM", "KV", "GN", "OH"][i],
      full: ["Vanguard", "Tempest", "Nimitz", "Kirov", "Genesis", "Ohio"][i],
      color: ["#5fd673", "#3dd5f3", "#d4af37", "#e8a854", "#ff6b6b", "#a78bfa"][i],
    };
  });

  const titleLines = t(UI.heroTitle);
  return (
    <section className="hero section" id="top">
      <div className="shell">
        <div className="hero-grid">
          <div>
            <div className="hero-eyebrow">
              <span className="pulse" aria-hidden="true"></span>
              <span className="eyebrow">{t(UI.heroEyebrow)}</span>
            </div>
            <h1 className="hero-title">{titleLines[0]}<br/>{titleLines[1]}</h1>
            <p className="hero-desc">
              {t(UI.heroDescPre)}
              <em style={{color:"var(--brass-bright)", fontStyle:"italic"}}>{t(UI.heroDescAdmiral)}</em>
              {t(UI.heroDescMid)}
              <em style={{color:"var(--brass-bright)", fontStyle:"italic"}}>{t(UI.heroDescHost)}</em>
              {t(UI.heroDescMid2)}
              <em style={{color:"var(--brass-bright)", fontStyle:"italic"}}>{t(UI.heroDescCap)}</em>
              {t(UI.heroDescTail)}
            </p>
            <div className="hero-actions">
              <a className="btn-primary" href="https://github.com/sbluemin/fleet-harness.git" target="_blank" rel="noreferrer">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.7.5.5 5.7.5 12c0 5 3.3 9.3 7.8 10.8.6.1.8-.3.8-.6v-2.1c-3.2.7-3.9-1.5-3.9-1.5-.5-1.4-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.8-1.6-2.6-.3-5.4-1.3-5.4-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.2 1.2.9-.3 1.9-.4 2.9-.4s2 .1 2.9.4c2.2-1.5 3.2-1.2 3.2-1.2.6 1.7.2 2.9.1 3.2.7.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.4 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6 4.5-1.5 7.8-5.8 7.8-10.8C23.5 5.7 18.3.5 12 .5z" /></svg>
                {t(UI.ctaRepo)}
              </a>
              <a className="btn-secondary" href="#captains">{t(UI.ctaCaptains)}</a>
            </div>
            <div className="hero-meta">
              <div className="hero-meta-item">
                <div className="label">{t(UI.metaBackends)}</div>
                <div className="value"><em>6</em> · {t(UI.metaBackendsVal)}</div>
              </div>
              <div className="hero-meta-item">
                <div className="label">{t(UI.metaCaptains)}</div>
                <div className="value"><em>8</em> · {t(UI.metaCaptainsVal)}</div>
              </div>
              <div className="hero-meta-item">
                <div className="label">{t(UI.metaProtocol)}</div>
                <div className="value"><em>4</em> · {t(UI.metaProtocolVal)}</div>
              </div>
            </div>
          </div>

          <div className="hero-diagram" aria-hidden="true">
            <div className="hero-diagram-ring"></div>
            <div className="hero-diagram-ring r2"></div>
            <div className="hero-diagram-ring r3"></div>
            <div className="hero-diagram-sweep"></div>
            <div className="hero-diagram-center">
              <div>
                <div className="role">Admiral</div>
                <div className="name">{lang === "ko" ? "제독" : "Admiral"}<br/>HOST</div>
              </div>
            </div>
            {nodes.map((n, i) => (
              <div
                key={i}
                className="hero-diagram-node"
                style={{ left: n.x + "%", top: n.y + "%", "--node-color": n.color }}
                title={n.full}
              >
                <span className="node-label">{n.label}</span>
                <span className="node-name">{n.full}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ───── Hierarchy ─────
function Hierarchy() {
  return (
    <section className="section" id="hierarchy">
      <div className="shell">
        <div className="section-head">
          <span className="eyebrow">{t(UI.hierarchyEy)}</span>
          <div className="divider"></div>
          <h2 className="section-title">{t(UI.hierarchyTitle)}</h2>
          <p className="lede">{t(UI.hierarchyLede)}</p>
        </div>
        <div className="hierarchy">
          {HIERARCHY.map((tier, i) => (
            <div className="tier" key={tier.rank}>
              <div className="tier-rank">{tier.rank}</div>
              <div className="tier-role">{t(tier.role)}</div>
              <div className="tier-en">{tier.en}</div>
              <div className="tier-desc">{t(tier.desc)}</div>
              {i < HIERARCHY.length - 1 && <div className="tier-arrow" aria-hidden="true">→</div>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ───── CLI Backends ─────
function Backends() {
  const title = t(UI.backendsTitle);
  return (
    <section className="section" id="backends">
      <div className="shell">
        <div className="section-head">
          <span className="eyebrow">{t(UI.backendsEy)}</span>
          <div className="divider"></div>
          <h2 className="section-title">{title[0]}<br/>{title[1]}</h2>
          <p className="lede">{t(UI.backendsLede)}</p>
        </div>
        <div className="cli-grid">
          {CLI_BACKENDS.map(c => (
            <div className="cli" key={c.name} style={{ "--cli-color": c.color }}>
              <div className="cli-head">
                <span className="cli-num">No. {c.num}</span>
                <span className="cli-vendor">{c.vendor}</span>
              </div>
              <div className="cli-name">{c.name}</div>
              <div className="cli-tag">{t(c.tag)}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ───── Captains ─────
function Captains() {
  const [active, setActive] = useState(0);
  const c = CAPTAINS[active];
  const title = t(UI.captainsTitle);
  return (
    <section className="section" id="captains">
      <div className="shell">
        <div className="section-head">
          <span className="eyebrow">{t(UI.captainsEy)}</span>
          <div className="divider"></div>
          <h2 className="section-title">{title[0]}<br/>{title[1]}</h2>
          <p className="lede">{t(UI.captainsLede)}</p>
        </div>
        <div className="captains-wrap">
          <div className="captain-list" role="tablist" aria-label={t(UI.captainsAria)}>
            {CAPTAINS.map((cap, i) => (
              <button
                key={cap.id}
                role="tab"
                aria-selected={active === i}
                className={"captain-list-item " + (active === i ? "active" : "")}
                style={{ "--cap-color": cap.color }}
                onClick={() => setActive(i)}
              >
                <span className="captain-dot" aria-hidden="true"></span>
                <span className="captain-list-text">
                  <span className="captain-list-name">{cap.id}</span>
                  <span className="captain-list-role">{t(cap.role)}</span>
                </span>
              </button>
            ))}
          </div>

          <div
            className="captain-detail"
            style={{ "--cap-color": c.color }}
            key={c.id}
          >
            <div style={{animation: "codex-pop 360ms var(--ease-spring) both"}}>
              <div className="captain-detail-head">
                <div className="captain-detail-title-block">
                  <div className="captain-id"><span>{t(UI.captainCap)}</span> · {c.id.toUpperCase()}</div>
                  <h3 className="captain-name">{c.id}</h3>
                  <div className="captain-role">{t(c.role)}</div>
                </div>
                <div className="captain-cli-badge">
                  <span className="ind" aria-hidden="true"></span>
                  {c.cli}
                </div>
              </div>
              <div className="captain-body">
                <div className="captain-mission">"{t(c.mission)}"</div>
                <div>
                  <div className="captain-resp-title">{t(UI.responsibilities)}</div>
                  <ul className="captain-resp-list">
                    {c.duties.map((d, i) => <li key={i}>{t(d)}</li>)}
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ───── Protocol (gate · 4 modes) ─────
function Protocol() {
  const [active, setActive] = useState(0);
  const p = MODES[active];
  const title = t(UI.protocolTitle);
  return (
    <section className="section" id="protocol">
      <div className="shell">
        <div className="section-head">
          <span className="eyebrow">{t(UI.protocolEy)}</span>
          <div className="divider"></div>
          <h2 className="section-title">{title[0]}<br/>{title[1]}</h2>
          <p className="lede">{t(UI.protocolLede)}</p>
        </div>
        <div className="phases-wrap">
          <div className="phase-rail" role="tablist" aria-label={t(UI.protocolAria)}>
            {MODES.map((ph, i) => (
              <button
                key={ph.n}
                role="tab"
                aria-selected={active === i}
                className={
                  "phase-step " +
                  (active === i ? "active " : "") +
                  (ph.required ? "required" : "conditional")
                }
                onClick={() => setActive(i)}
              >
                <span className="phase-step-num">{ph.n}</span>
                <span className="phase-step-body">
                  <span className="phase-step-title">{ph.name}</span>
                  <span className="phase-step-tag">· {t(ph.tag)} · {t(ph.kr)}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="phase-detail" key={p.n}>
            <div style={{animation: "codex-pop 320ms var(--ease-spring) both"}}>
              <div className="phase-detail-num" aria-hidden="true">{p.n}</div>
              <div className="phase-detail-eyebrow">
                <span>{t(UI.phaseLabel)} {p.n}</span>
                <span style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: p.required ? "var(--coral)" : "var(--aurora)",
                  boxShadow: `0 0 8px ${p.required ? "var(--coral)" : "var(--aurora)"}`,
                }}></span>
                <span style={{color: p.required ? "var(--coral)" : "var(--aurora)"}}>{t(p.tag)}</span>
              </div>
              <h3 className="phase-detail-title">{p.name} <span style={{color:"var(--ink-fog)", fontWeight:300}}>· {t(p.kr)}</span></h3>
              <p className="phase-detail-desc">{t(p.desc)}</p>
              <div className="phase-detail-points">
                {p.points.map((pt, i) => (
                  <div className="phase-detail-point" key={i}>
                    <span className="pt-marker">{pt.m}</span>
                    <span dangerouslySetInnerHTML={{__html: t(pt.t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}}></span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ───── Standing Orders ─────
function Orders() {
  const title = t(UI.ordersTitle);
  return (
    <section className="section" id="orders">
      <div className="shell">
        <div className="section-head">
          <span className="eyebrow">{t(UI.ordersEy)}</span>
          <div className="divider"></div>
          <h2 className="section-title">{title[0]}<br/>{title[1]}</h2>
          <p className="lede">{t(UI.ordersLede)}</p>
        </div>
        <div className="orders-grid">
          {ORDERS.map(o => (
            <div className="order" key={o.name}>
              <div className="order-glow" aria-hidden="true"></div>
              <div className="order-status">
                <span className="live" aria-hidden="true"></span> {t(UI.active)}
              </div>
              <div className="order-name">
                {o.name}
                <span>· {t(o.kr)}</span>
              </div>
              <div className="order-desc">{t(o.desc)}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ───── Differentiators ─────
function Diffs() {
  const title = t(UI.diffsTitle);
  return (
    <section className="section" id="diffs">
      <div className="shell">
        <div className="section-head">
          <span className="eyebrow">{t(UI.diffsEy)}</span>
          <div className="divider"></div>
          <h2 className="section-title">{title[0]}<br/>{title[1]}</h2>
        </div>
        <div className="diff-list">
          {DIFFS.map(d => (
            <div className="diff-row" key={d.n}>
              <div className="diff-num">{d.n}</div>
              <div className="diff-name">
                <span>{t(d.kr)}</span>
                {d.name}
              </div>
              <div className="diff-body">{t(d.body)}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ───── Comparison ─────
function Compare() {
  return (
    <section className="section" id="compare">
      <div className="shell">
        <div className="section-head">
          <span className="eyebrow">{t(UI.compareEy)}</span>
          <div className="divider"></div>
          <h2 className="section-title">{t(UI.compareTitle)}</h2>
          <p className="lede">{t(UI.compareLede)}</p>
        </div>
        <div className="compare-grid">
          {COMPARES.map(c => (
            <div className={"compare-col " + (c.us ? "us" : "")} key={c.name}>
              <div className="compare-cat">{t(c.cat)}</div>
              <div className="compare-name">{c.name}</div>
              <ul className="compare-list">
                {c.bullets.map((b, i) => <li key={i}>{t(b)}</li>)}
              </ul>
              <div className="compare-verdict">{t(c.verdict)}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ───── Closer ─────
function Closer() {
  const title = t(UI.closerTitle);
  return (
    <section className="closer" id="install">
      <div className="shell">
        <div className="closer-card">
          <div className="closer-eyebrow">{t(UI.closerEy)}</div>
          <h2 className="closer-title">{title[0]}<br/>{title[1]}</h2>
          <p className="closer-sub">{t(UI.closerSub)}</p>
          <div className="code-block" style={{textAlign:"left", maxWidth: 540, margin: "0 auto 36px"}}>
            <span className="cm">{t(UI.installCmt)}</span><br/>
            <span className="pr">$</span> npm install -g <span className="ar">@dotobokuri/fleet-cli</span><br/>
            <span className="pr">$</span> fleet <span className="cm">{t(UI.setSailCmt)}</span>
          </div>
          <div className="closer-actions">
            <a className="btn-primary" href="https://github.com/sbluemin/fleet-harness.git" target="_blank" rel="noreferrer">
              {t(UI.ctaGithubView)}
            </a>
            <a className="btn-secondary" href="#protocol">
              {t(UI.ctaProtocol)}
            </a>
          </div>
        </div>
        <div className="footer">
          <div>{t(UI.footerLine)}</div>
          <div className="footer-meta">
            <span>{t(UI.builtOn)}</span>
            <span>{t(UI.countMeta)}</span>
          </div>
        </div>
      </div>
    </section>
  );
}

// ───── App ─────
function App() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Hierarchy />
        <Backends />
        <Captains />
        <Protocol />
        <Orders />
        <Diffs />
        <Compare />
        <Closer />
      </main>
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
