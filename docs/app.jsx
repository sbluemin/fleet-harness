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
  navCaptains:  { ko: "4 함장", en: "4 Captains" },
  navProtocol:  { ko: "4 모드", en: "4 Modes" },
  navDiffs:     { ko: "차별점", en: "Why us" },
  primaryAria:  { ko: "주요 메뉴", en: "Primary" },

  heroEyebrow:  { ko: "Fleet Action Protocol · v1", en: "Fleet Action Protocol · v1" },
  heroTitle:    { ko: ["단일 인터페이스에서", "함대 전체를 지휘하라."], en: ["Command an entire fleet", "from a single interface."] },
  heroDescPre:    { ko: "fleet-harness는 Claude Code와 Claude Gateway Operation을 오케스트레이션하고 Session Analyst에서 Cursor Agent를 제공하는 멀티-LLM 하네스입니다. 사용자는 ", en: "fleet-harness is a multi-LLM harness that orchestrates Claude Code and Claude Gateway operations, with Cursor Agent available to Session Analyst. You command as the " },
  heroDescAdmiral:{ ko: "대원수", en: "Admiral of the Navy" },
  heroDescMid:    { ko: "로서 임무를 부여하고, 호스트인 ", en: ", while the host — the " },
  heroDescHost:   { ko: "제독", en: "Admiral" },
  heroDescMid2:   { ko: "이 4명의 ", en: " — delegates to four " },
  heroDescCap:    { ko: "함장", en: "Captains" },
  heroDescTail:   { ko: "에게 책임을 위임해 작전을 종결합니다.", en: " who close the operation." },

  ctaRepo:      { ko: "저장소 살펴보기", en: "Explore the repo" },
  ctaCaptains:  { ko: "함장 명단 보기", en: "Meet the captains" },
  ctaGithubView:{ ko: "GitHub에서 보기", en: "View on GitHub" },
  ctaProtocol:  { ko: "Fleet Action Protocol 보기", en: "See the Fleet Action Protocol" },

  metaBackends: { ko: "CLI Backends", en: "CLI Backends" },
  metaBackendsVal: { ko: "Anthropic / OpenAI / Cursor", en: "Anthropic / OpenAI / Cursor" },
  metaCaptains: { ko: "Captains", en: "Captains" },
  metaCaptainsVal: { ko: "명시적 책임 분리", en: "Distinct responsibilities" },
  metaProtocol: { ko: "Protocol", en: "Protocol" },
  metaProtocolVal: { ko: "Intent → Mode → Execute", en: "Intent → Mode → Execute" },

  hierarchyEy:  { ko: "Chain of Command", en: "Chain of Command" },
  hierarchyTitle: { ko: "3-단 지휘 체계", en: "Three-tier command structure" },
  hierarchyLede:  { ko: "사용자는 코드를 쓰지 않는다. 결정한다. 함대는 그 결정을 작전으로 환원한다.", en: "You don't write code — you decide. The fleet turns each decision into an operation." },

  backendsEy:    { ko: "Runtime Paths · 04", en: "Runtime Paths · 04" },
  backendsTitle: { ko: ["네 개의 런타임 경로,", "한 명의 제독."], en: ["Four runtime paths,", "one Admiral."] },
  backendsLede:  { ko: "한 모델로 모든 작업을 수행하지 않는다. 각 경로는 자신이 가장 잘하는 역할을 맡는다.", en: "No single model handles every task. Each path takes the role it serves best." },

  captainsEy:    { ko: "Captains Roster · 04", en: "Captains Roster · 04" },
  captainsTitle: { ko: ["네 명의 함장,", "겹치지 않는 네 개의 책임."], en: ["Four captains,", "four non-overlapping duties."] },
  captainsLede:  { ko: "함장은 장식이 아닌 운영 계약이다. 좌측에서 함장을 선택하면 임무 강령과 책임 명세가 펼쳐진다.", en: "Captains aren't decoration — they're operational contracts. Pick one to see its mission and duties." },
  captainsAria:  { ko: "함장 명단", en: "Captains list" },
  captainCap:    { ko: "Captain", en: "Captain" },
  responsibilities: { ko: "Responsibilities", en: "Responsibilities" },

  protocolEy:    { ko: "Fleet Action Protocol · 04", en: "Fleet Action Protocol · 04" },
  protocolTitle: { ko: ["하나의 게이트,", "네 개의 모드."], en: ["One gate,", "four modes."] },
  protocolLede:  { ko: "모든 요청은 Intent Gate에서 대화형과 작전형으로 갈린다. 작전형은 Mode Gate에서 정확히 하나의 모드 스킬을 온디맨드로 적재하고, General Quarters 준비 점검을 마친 뒤 brief 한 줄로 작전 계획을 보고하고 진입한다. 하향 가드가 가벼운 모드로의 도피를 막는다.", en: "Every request splits at the Intent Gate — conversational or operational. Operational work loads exactly one mode skill on demand at the Mode Gate, runs the General Quarters readiness checks, then reports a one-line brief before entry. The downward guard blocks any escape into a lighter mode." },
  protocolAria:  { ko: "Fleet Action Protocol 모드", en: "Fleet Action Protocol modes" },
  phaseLabel:    { ko: "Mode", en: "Mode" },

  ordersEy:    { ko: "Standing Orders · Always Active", en: "Standing Orders · Always Active" },
  ordersTitle: { ko: ["항상 켜져 있는", "여섯 개의 명령."], en: ["Six orders,", "always on."] },
  ordersLede:  { ko: "어떤 프로토콜 모드에도 종속되지 않고 모든 작전 위에 상시 작동하는 호스트 차원의 안전 장치. 대화형 요청에서도 꺼지지 않는다.", en: "Host-level safeguards that run above every mission, bound to no protocol mode — and never switched off, even on conversational requests." },
  active:      { ko: "Active", en: "Active" },

  diffsEy:    { ko: "What sets it apart · 04", en: "What sets it apart · 04" },
  diffsTitle: { ko: ["왜 또 하나의", "에이전트 프레임워크가 아닌가."], en: ["Why this isn't", "just another agent framework."] },

  compareEy:    { ko: "Landscape", en: "Landscape" },
  compareTitle: { ko: "에이전트 지형도 위에서.", en: "On the agent-tooling landscape." },
  compareLede:  { ko: "비슷한 도구는 많다. 그러나 처음부터 함대로 설계된 도구는 드물다.", en: "Plenty of similar tools. Few are designed as a fleet from day one." },

  closerEy:    { ko: "Mission Brief · Ready", en: "Mission Brief · Ready" },
  closerTitle: { ko: ["함대는", "당신의 명령을 기다린다."], en: ["The fleet awaits", "your orders."] },
  closerSub:   { ko: "저장소를 살펴보고, 첫 임무를 부여하라. 정찰부터 검증까지, 함대가 알아서 끝낸다. 문서화와 Fleet Wiki는 Carrier에 위임하지 않고 제독이 직접 수행한다.", en: "Explore the repo, issue your first mission. From recon to verification, the fleet handles the rest. The Admiral performs documentation and Fleet Wiki work directly — not through Carriers." },
  installCmt:  { ko: "# install the harness", en: "# install the harness" },
  setSailCmt:  { ko: "# Set sail on your first mission, Admiral.", en: "# Set sail on your first mission, Admiral." },
  footerLine:  { ko: "fleet-harness · Fleet Action Protocol v1", en: "fleet-harness · Fleet Action Protocol v1" },
  builtOn:     { ko: "native CLI orchestration", en: "native CLI orchestration" },
  countMeta:   { ko: "· 4 Paths · 4 Captains · 4 Modes", en: "· 4 Paths · 4 Captains · 4 Modes" },
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
    desc: { ko: "4명의 전문 함장. 각자의 영역에서 단일 CLI 백엔드를 운용해 작전을 수행한다.", en: "Four specialists, each running a single CLI backend within their domain to execute the operation." },
  },
];

const CLI_BACKENDS = [
  { num: "01", vendor: "Anthropic", name: "Claude Code", tag: { ko: "장기 추론·아키텍처 판단의 표준 백엔드", en: "The standard backend for long-form reasoning and architectural judgment." }, color: "oklch(78% 0.13 75)" },
  { num: "02", vendor: "OpenAI · Cursor · Moonshot AI", name: "Claude Gateway", tag: { ko: "여러 프론티어 모델을 Claude Code 표면에서 라우팅하는 실험적 백엔드", en: "An experimental backend routing frontier models through the Claude Code surface." }, color: "oklch(72% 0.17 25)" },
  { num: "03", vendor: "OpenAI", name: "Codex CLI", tag: { ko: "Carrier와 Task Force를 위한 실행 백엔드", en: "An execution backend for Carriers and Task Forces." }, color: "oklch(72% 0.03 250)" },
  { num: "04", vendor: "Cursor", name: "Cursor Agent", tag: { ko: "Session Analyst를 위한 다중 모델 분석 백엔드", en: "A multi-model analysis backend for Session Analyst." }, color: "oklch(78% 0.14 145)" },
];

const CAPTAINS = [
  {
    id: "Vanguard",
    role: { ko: "Reconnaissance Specialist", en: "Reconnaissance Specialist" },
    cli: "Claude Code",
    color: "#5fd673",
    mission: {
      ko: "로컬과 원격을 가리지 않고 코드베이스 사실을 수집한다. 코드를 수정하거나 판단을 대신하지 않고 다음 결정을 위한 근거를 가져온다.",
      en: "Collects codebase facts wherever the source lives — local or remote. Returns evidence for the next decision without editing code or making the decision.",
    },
    duties: [
      { ko: "로컬·원격 코드베이스 정찰 — 디렉터리·심볼·호출 그래프 추적", en: "Local and remote codebase reconnaissance — directories, symbols, call graphs." },
      { ko: "외부 저장소 심층 조사 — 읽기 전용 API·공개 코드 검색·임시 clone", en: "External repository deep dives — read-only APIs, public code search, temporary clones." },
      { ko: "API·SDK 사용 패턴과 웹·외부 레퍼런스 수집", en: "API and SDK usage patterns plus web and external references." },
      { ko: "출처 기반 보고 — 로컬 절대 경로, 원격 소스 참조, 신뢰도", en: "Source-linked reporting — local absolute paths, remote source references, confidence." },
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
      { ko: "Task Force 합의와 읽기 전용 경계 — 실행은 호스트에 반환", en: "Task Force consensus and read-only boundary — execution returns to the host." },
    ],
  },
  {
    id: "Genesis",
    role: { ko: "Chief Engineer", en: "Chief Engineer" },
    cli: "Claude Code",
    color: "#ff6b6b",
    mission: { ko: "직접 구현과 호스트가 작성한 실행 계약 기반 구현을 모두 맡는다. 구현과 QA 증거를 반환하는 수석 엔지니어.", en: "Owns direct implementation and execution of host-authored implementation contracts. The chief engineer returns implementation and QA evidence." },
    duties: [
      { ko: "직접 구현 — 새 기능, 모듈, 시스템 통합", en: "Direct implementation — new features, modules, system integrations." },
      { ko: "구조화된 구현 — 호스트가 작성한 범위와 제약을 그대로 실행", en: "Structured implementation — executes the host-authored scope and constraints." },
      { ko: "각 wave 후 빌드·테스트·QA 증거 반환", en: "Returns build, test, and QA evidence after each wave." },
      { ko: "설계 계약 준수 — 대안을 임의로 대체하지 않고 호스트에 반환", en: "Preserves design contracts — returns alternatives to the host instead of substituting them." },
    ],
  },
  {
    id: "Sentinel",
    role: { ko: "The Inquisitor · QA & Security Lead", en: "The Inquisitor · QA & Security Lead" },
    cli: "Claude Code",
    color: "#fb7185",
    mission: { ko: "함대의 검열관. 어떤 코드도 그의 의심을 거치지 않고는 실전에 투입되지 않는다.", en: "The fleet's inquisitor. No code reaches the front line without surviving his doubt." },
    duties: [
      { ko: "코드 리뷰 — 시맨틱·성능·테스트 커버리지", en: "Code review — semantics, performance, test coverage." },
      { ko: "보안 감사 — OWASP Top 10, 권한 모델, 비밀 관리", en: "Security audit — OWASP Top 10, permission models, secret handling." },
      { ko: "버그 헌팅 · 침투 테스트 시나리오 작성", en: "Bug hunting and penetration-test scenario authoring." },
      { ko: "Review Cycle에서 Genesis 결과를 병렬 심문", en: "Interrogates Genesis's output in parallel during the Review Cycle." },
    ],
  },
];

const MODES = [
  {
    n: "01",
    name: "Baseline",
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
    name: "Midline",
    kr: { ko: "표준", en: "Standard" },
    tag: { ko: "기본", en: "Default" },
    required: false,
    desc: { ko: "하향 가드를 건드리지 않는 일반적인 경계형 작전. 모드가 모호할 때의 기본 폴백이기도 하다.", en: "Ordinary bounded work that doesn't trip the downward guard — and the default fallback when the mode is ambiguous." },
    points: [
      { m: "FLOW", t: { ko: "**정찰 → 계획 경계 → 인라인 계획 → 실집행 → 검증 → 문서**.", en: "**Recon → planning boundary → inline plan → execution → verification → docs**." } },
      { m: "GATE", t: { ko: "계획 경계 진입엔 sufficient 확신 — 차단 갭이 남으면 못 들어간다.", en: "The planning boundary demands sufficient confidence — no entry with blocking gaps open." } },
    ],
  },
  {
    n: "03",
    name: "Redline",
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
    name: "Frontline",
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
    name: "Command Integrity",
    kr: { ko: "명령 무결성", en: "Command Integrity" },
    desc: { ko: "명령 수령 단계의 무결성을 지킨다. 기술적으로 결함 있는 명령에는 근거를 갖춰 진언하고, 착수 전 결정형 모호함은 질문으로 해소하며, 명시 범위 밖 권한을 가정하지 않고, 지침 충돌은 안전·정확·명료·효율 순으로 중재한다.", en: "Guards integrity at order reception. Technically flawed orders get a reasoned pushback, decision-shaped ambiguity is clarified before work starts, no permission is assumed beyond the granted scope, and conflicting directives resolve by safety, correctness, clarity, then efficiency." },
  },
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
    body: { ko: "Claude Code와 Claude Gateway는 Operation을 실행하고, Codex CLI는 Carrier와 Task Force를 구동하며, Cursor Agent는 Session Analyst를 맡는다.", en: "Claude Code and Claude Gateway run operations, Codex CLI powers Carriers and Task Forces, and Cursor Agent serves Session Analyst." },
  },
  {
    n: "02",
    name: "Naval Metaphor as Contract",
    kr: { ko: "운영 가능한 해군 메타포", en: "An Operational Naval Metaphor" },
    body: { ko: "장식이 아니다. 4명의 함장은 각자 서로 겹치지 않는 책임 영역을 가진 운영 계약이다. Vanguard에게 ADR을 시키지 않고, Nimitz에게 코드를 쓰게 하지 않는다. 문서화와 Fleet Wiki는 Carrier에 위임하지 않고 제독이 직접 수행한다.", en: "Not decoration. Each of the four captains is an operational contract with non-overlapping duties. Vanguard doesn't write ADRs; Nimitz doesn't write code. The Admiral performs documentation and Fleet Wiki work directly — not through Carriers." },
  },
  {
    n: "03",
    name: "Task Force & Squadron",
    kr: { ko: "태스크 포스 & 스쿼드론", en: "Task Force & Squadron" },
    body: { ko: "Task Force는 여러 백엔드의 결과를 합의 알고리즘으로 통합. Squadron은 동일 작전을 병렬 분기로 동시에 시도하고 가장 우수한 줄기를 채택한다.", en: "Task Force fuses outputs from multiple backends through a consensus algorithm. Squadron tries the same operation along parallel branches and adopts the strongest one." },
  },
  {
    n: "04",
    name: "Architectural Discipline",
    kr: { ko: "아키텍처 규율", en: "Architectural Discipline" },
    body: { ko: "빌드 게이트는 협상 불가. SSOT(AGENTS.md, ADR)는 강제 동기화. 각 wave는 그 자체로 컴파일·테스트를 통과해야 다음으로 진행한다.", en: "Build gates are non-negotiable. SSOT (AGENTS.md and ADRs) stays force-synced. Each wave must compile and test on its own to advance." },
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
      { ko: "네 런타임 경로 통합 지휘", en: "Four runtime paths coordinated together" },
      { ko: "4 함장 명시적 책임 분리", en: "Four captains, distinct duties" },
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
  const nodeCount = 4;
  const radius = 38;
  const nodes = Array.from({ length: nodeCount }, (_, i) => {
    const angle = (i / nodeCount) * Math.PI * 2 - Math.PI / 2;
    return {
      x: 50 + Math.cos(angle) * radius,
      y: 50 + Math.sin(angle) * radius,
      label: ["VG", "NM", "GN", "SN"][i],
      full: ["Vanguard", "Nimitz", "Genesis", "Sentinel"][i],
      color: ["#5fd673", "#d4af37", "#ff6b6b", "#fb7185"][i],
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
                <div className="value"><em>3</em> · {t(UI.metaBackendsVal)}</div>
              </div>
              <div className="hero-meta-item">
                <div className="label">{t(UI.metaCaptains)}</div>
                <div className="value"><em>{CAPTAINS.length}</em> · {t(UI.metaCaptainsVal)}</div>
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
            <div style={{animation: "fleet-pop 360ms var(--ease-spring) both"}}>
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
            <div style={{animation: "fleet-pop 320ms var(--ease-spring) both"}}>
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
