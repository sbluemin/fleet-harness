const { useState, useEffect, useRef } = React;

// ───── Locale ─────
const lang = (typeof navigator !== "undefined" && navigator.language && navigator.language.startsWith("ko")) ? "ko" : "en";
if (typeof document !== "undefined" && document.documentElement) {
  document.documentElement.lang = lang;
}
const t = (obj) => (obj && typeof obj === "object" && (obj.ko || obj.en)) ? (obj[lang] ?? obj.en ?? obj.ko) : obj;

// ───── UI strings ─────
const UI = {
  navHierarchy: { ko: "구성", en: "How it works" },
  navProviders: { ko: "게이트웨이", en: "Gateway" },
  navModes:     { ko: "3 모드", en: "3 Modes" },
  navDiffs:     { ko: "차별점", en: "Why us" },
  primaryAria:  { ko: "주요 메뉴", en: "Primary" },

  heroEyebrow:  { ko: "Fleet Console · Research preview", en: "Fleet Console · Research preview" },
  heroTitle:    { ko: ["하나의 콘솔.", "모든 에이전트."], en: ["One console.", "Every coding agent."] },
  heroDescPre:    { ko: "Fleet Console은 코딩 에이전트를 브라우저가 아니라 로컬 서버가 소유하는 ", en: "Fleet Console runs coding agents as " },
  heroDescOperation:{ ko: "Operation", en: "Operations" },
  heroDescMid:    { ko: "으로 실행합니다. 탭을 닫아도 세션은 계속 돌고, 호스트 에이전트인 ", en: " owned by a local server, not your browser. Close the tab and the session keeps running. The host agent — the " },
  heroDescHost:   { ko: "Admiral", en: "Admiral" },
  heroDescMid2:   { ko: "은 여섯 개의 ", en: " — plans and delegates under six always-on " },
  heroDescOrders: { ko: "Standing Order", en: "Standing Orders" },
  heroDescTail:   { ko: " 아래에서 계획하고 위임합니다.", en: "." },

  ctaRepo:      { ko: "저장소 살펴보기", en: "Explore the repo" },
  ctaProviders: { ko: "게이트웨이 모델 보기", en: "See the gateway models" },
  ctaGithubView:{ ko: "GitHub에서 보기", en: "View on GitHub" },
  ctaModes:     { ko: "캔버스 모드 보기", en: "See the canvas modes" },

  metaKinds: { ko: "Launch kinds", en: "Launch kinds" },
  metaKindsVal: { ko: "Native / Gateway", en: "Native / Gateway" },
  metaProviders: { ko: "Gateway providers", en: "Gateway providers" },
  metaProvidersVal: { ko: "구독과 API 키", en: "Subscriptions and API keys" },
  metaOrders: { ko: "Standing Orders", en: "Standing Orders" },
  metaOrdersVal: { ko: "상시 작동", en: "Always on" },

  hierarchyEy:  { ko: "How it works", en: "How it works" },
  hierarchyTitle: { ko: "결정 · 계획 · 실행", en: "Decide, plan, execute" },
  hierarchyLede:  { ko: "사용자는 코드를 쓰지 않는다. 결정한다. 호스트가 그 결정을 Operation으로 환원한다.", en: "You don't write code — you decide. The host turns each decision into an Operation." },

  backendsEy:    { ko: "Launch kinds · 02", en: "Launch kinds · 02" },
  backendsTitle: { ko: ["두 가지 실행 종류,", "하나의 캔버스."], en: ["Two launch kinds,", "one canvas."] },
  backendsLede:  { ko: "Fleet은 실제 CLI 바이너리를 선언된 제품 표면에서 실행한다. 제작사가 다듬은 에이전트 루프와 이미 쓰던 인증이 그대로 보존된다.", en: "Fleet launches the actual CLI binary in its declared product surface, preserving the model-native agent loop and the authentication you already use." },

  providersEy:    { ko: "AI Gateway · 04", en: "AI Gateway · 04" },
  providersTitle: { ko: ["네 곳의 공급자,", "당신의 계정으로."], en: ["Four providers,", "on accounts you own."] },
  providersLede:  { ko: "게이트웨이는 API 프록시가 아니라 로컬 Claude Code 엔드포인트다. 상류 요청은 Console이 직접 보내고, 어떤 공급자의 자격 증명도 Claude Code 프로세스에 들어가지 않는다. Codex와 Cursor는 이미 쓰던 구독을 타고, Kimi와 OpenCode Go는 설정에 등록한 API 키를 쓴다. 좌측에서 공급자를 고르면 게이트웨이로 닿는 모델이 펼쳐진다.", en: "The gateway is a local Claude Code endpoint, not an API proxy: the Console makes the upstream request itself, and no provider credential ever enters the Claude Code process. Codex and Cursor ride the subscription you already have; Kimi and OpenCode Go take an API key you register in Settings. Pick a provider to see the models it reaches." },
  providersAria:  { ko: "게이트웨이 공급자", en: "Gateway providers" },
  providerCap:    { ko: "Provider", en: "Provider" },
  reachableModels: { ko: "Models", en: "Models" },

  modesEy:    { ko: "Canvas modes · 03", en: "Canvas modes · 03" },
  modesTitle: { ko: ["같은 캔버스를 쓰는", "세 가지 방식."], en: ["Three ways to work", "the same canvas."] },
  modesLede:  { ko: "Operation은 무한 캔버스 위에 놓이고, 커맨드 밴드의 스위치가 배치를 어디까지 직접 할지 정한다. 여러 에이전트가 동시에 응답을 기다릴 때 고르는 것이 War Room이다.", en: "Operations live on an infinite canvas, and a switch in the command band decides how much of the arranging you do yourself. War Room is the one to reach for when several agents are waiting on you." },
  modesAria:  { ko: "캔버스 모드", en: "Canvas modes" },
  modeLabel:  { ko: "Mode", en: "Mode" },

  ordersEy:    { ko: "Standing Orders · Always Active", en: "Standing Orders · Always Active" },
  ordersTitle: { ko: ["항상 켜져 있는", "여섯 개의 명령."], en: ["Six orders,", "always on."] },
  ordersLede:  { ko: "모든 작업 위에 상시 작동하는 호스트 차원의 안전 장치. 대화형 요청에서도 꺼지지 않는다.", en: "Host-level safeguards that run above every task — and never switched off, even on conversational requests." },
  active:      { ko: "Active", en: "Active" },

  diffsEy:    { ko: "What sets it apart · 04", en: "What sets it apart · 04" },
  diffsTitle: { ko: ["왜 또 하나의", "에이전트 프레임워크가 아닌가."], en: ["Why this isn't", "just another agent framework."] },

  compareEy:    { ko: "Landscape", en: "Landscape" },
  compareTitle: { ko: "에이전트 지형도 위에서.", en: "On the agent-tooling landscape." },
  compareLede:  { ko: "비슷한 도구는 많다. 그러나 에이전트를 서버가 소유하는 살아 있는 작업 단위로 다루는 도구는 드물다.", en: "Plenty of similar tools. Few treat an agent as a live, server-owned unit of work." },

  closerEy:    { ko: "Get started", en: "Get started" },
  closerTitle: { ko: ["콘솔을 켜고", "첫 Operation을 띄우세요."], en: ["Start the console,", "launch your first Operation."] },
  closerSub:   { ko: "모든 실행은 내 머신 안에서 이루어진다. 서버는 기본적으로 루프백에 바인딩되고, 브라우저에는 MCP·공급자 토큰이 전달되지 않는다. 원격 접속은 켜야 열린다.", en: "Everything runs on your machine: the server binds to loopback by default, and the browser never receives MCP or provider tokens. Remote access opens only when you turn it on." },
  installCmt:  { ko: "# install the console", en: "# install the console" },
  setSailCmt:  { ko: "# Start it, and it opens in your browser.", en: "# Start it, and it opens in your browser." },
  footerLine:  { ko: "fleet-harness · Fleet Console", en: "fleet-harness · Fleet Console" },
  builtOn:     { ko: "native CLI orchestration", en: "native CLI orchestration" },
  countMeta:   { ko: "· 2 Launch kinds · 4 Providers · 6 Standing Orders", en: "· 2 Launch kinds · 4 Providers · 6 Standing Orders" },
};

// ───── Data ─────
const HIERARCHY = [
  {
    rank: "Tier 01",
    role: { ko: "사용자", en: "You" },
    en: "You · DECIDE",
    desc: { ko: "최종 의사 결정자. 무엇을 할지 정하고, 되돌리기 어려운 행동을 승인한다.", en: "The final decision-maker. Sets what gets done and approves anything hard to reverse." },
  },
  {
    rank: "Tier 02",
    role: { ko: "Admiral", en: "Admiral" },
    en: "Admiral · HOST AGENT",
    desc: { ko: "호스트 에이전트. 작업을 분해하고 적합한 모델에 위임하며, 돌아온 결과를 산출물 단위로 검사한 뒤 통합한다.", en: "The host agent. Decomposes the work, delegates it to the model that fits, then inspects the returned artifacts before integrating them." },
  },
  {
    rank: "Tier 03",
    role: { ko: "Operation", en: "Operation" },
    en: "Operation · AGENT SESSION",
    desc: { ko: "실제 터미널 세션. 로컬 Fleet Console 서버가 소유하므로 탭을 닫아도 계속 실행되고 출력도 계속 쌓인다.", en: "A real terminal session owned by the local Fleet Console server, so it keeps running and buffering output after you close the tab." },
  },
];

const CLI_BACKENDS = [
  { num: "01", vendor: "Anthropic", name: "Claude (Native)", tag: { ko: "순정 Claude Code — Console 훅과 Wiki 스킬만 덧붙는다", en: "Plain Claude Code — Console hooks and Wiki skills are all that get added." }, color: "oklch(78% 0.13 75)" },
  { num: "02", vendor: "Codex · Cursor · Moonshot · OpenCode", name: "Claude (Gateway)", tag: { ko: "설정에서 켠 모델로 구동되는 Claude Code", en: "Claude Code driving the models you enabled in Settings." }, color: "oklch(72% 0.17 25)" },
];

const PROVIDERS = [
  {
    id: "Codex",
    role: { ko: "OpenAI · ChatGPT 구독", en: "OpenAI · ChatGPT subscription" },
    cli: "subscription",
    color: "#5fd673",
    mission: {
      ko: "GPT-5.6 계열을 Claude Code 표면으로 들여온다. 추론 강도 사다리가 가장 깊은 경로다 — Sol과 Terra는 low부터 ultra까지, Luna는 max까지 노출하므로 같은 모델을 가벼운 작업과 어려운 판단에 다른 강도로 쓸 수 있다.",
      en: "Brings the GPT-5.6 family onto the Claude Code surface, with the deepest reasoning ladder of any provider here: Sol and Terra run from low through ultra, Luna through max, so one model can serve both cheap mechanical work and hard judgment at different efforts.",
    },
    models: [
      { ko: "GPT-5.6 Sol — low~ultra, Fast 변형 포함", en: "GPT-5.6 Sol — low through ultra, Fast variant included" },
      { ko: "GPT-5.6 Terra — low~ultra, Fast 변형 포함", en: "GPT-5.6 Terra — low through ultra, Fast variant included" },
      { ko: "GPT-5.6 Luna — low~max, Fast 변형 포함", en: "GPT-5.6 Luna — low through max, Fast variant included" },
    ],
  },
  {
    id: "Cursor",
    role: { ko: "Cursor 구독", en: "Cursor subscription" },
    cli: "subscription",
    color: "#d4af37",
    mission: {
      ko: "한 구독으로 여러 벤더의 모델에 닿는 가장 넓은 경로. Composer부터 Grok·GPT·Claude·Kimi까지 같은 게이트웨이 뒤에 선다.",
      en: "The widest path: one subscription reaching models from several vendors — Composer, Grok, GPT, Claude, and Kimi all stand behind the same gateway.",
    },
    models: [
      { ko: "Composer 2.5", en: "Composer 2.5" },
      { ko: "Grok 4.5", en: "Grok 4.5" },
      { ko: "GPT-5.6 Sol", en: "GPT-5.6 Sol" },
      { ko: "Claude Opus 5 · Claude Fable 5", en: "Claude Opus 5 and Claude Fable 5" },
      { ko: "Kimi K3 · Auto", en: "Kimi K3 and Auto" },
    ],
  },
  {
    id: "Moonshot",
    role: { ko: "Moonshot AI · Kimi API 키", en: "Moonshot AI · Kimi API key" },
    cli: "API key",
    color: "#ff6b6b",
    mission: {
      ko: "긴 컨텍스트가 필요한 작업을 위한 경로. K3는 백만 토큰 창을 들고 오므로, 큰 하위 시스템을 한 세션 안에서 통째로 읽힐 수 있다.",
      en: "The path for work that needs a long context. K3 brings a million-token window, so a large subsystem can be read whole inside one session.",
    },
    models: [
      { ko: "Kimi K3 — 1M 컨텍스트", en: "Kimi K3 — 1M context" },
      { ko: "Kimi K3 256K", en: "Kimi K3 256K" },
    ],
  },
  {
    id: "OpenCode",
    role: { ko: "OpenCode Go API 키", en: "OpenCode Go API key" },
    cli: "API key",
    color: "#fb7185",
    mission: {
      ko: "오픈 웨이트 모델을 가장 많이 모아 둔 경로. 기계적인 대량 작업을 값싼 신원에 흩뿌릴 때 쓰는 폭이 여기서 나온다.",
      en: "The widest bench of open-weight models. This is where the breadth comes from when mechanical, high-volume work is spread across cheaper identities.",
    },
    models: [
      { ko: "MiniMax M3 · Qwen3 Max", en: "MiniMax M3 and Qwen3 Max" },
      { ko: "DeepSeek V4 · GLM-5", en: "DeepSeek V4 and GLM-5" },
      { ko: "Kimi K3 · MiMo", en: "Kimi K3 and MiMo" },
      { ko: "Grok 4.5 · GPT-5.6 Luna", en: "Grok 4.5 and GPT-5.6 Luna" },
    ],
  },
];

const MODES = [
  {
    n: "01",
    name: "Cruise",
    kr: { ko: "직접 배치", en: "Place them yourself" },
    tag: { ko: "기본", en: "Default" },
    required: true,
    desc: { ko: "패널을 원하는 자리에 직접 놓는 기본 모드. 무한 캔버스 위에서 위치와 크기를 스스로 정하고, 그 배치는 다음에 열 때도 그대로 남는다.", en: "The default: put each panel where you want it. You choose position and size on the infinite canvas, and the arrangement is still there when you come back." },
    points: [
      { m: "CANVAS", t: { ko: "**무한 캔버스** — 패널마다 위치·크기를 기억한다.", en: "**An infinite canvas** — every panel remembers its own position and size." } },
      { m: "SEARCH", t: { ko: "**⌘K**로 모든 Theater에 걸쳐 Operation을 검색하고, **⌘P**로 커맨드 팔레트를 연다.", en: "**⌘K** searches Operations across every Theater; **⌘P** opens the command palette." } },
    ],
  },
  {
    n: "02",
    name: "Tactical",
    kr: { ko: "한 번에 정렬", en: "Lay them all out" },
    tag: { ko: "Alt+F", en: "Alt+F" },
    required: false,
    desc: { ko: "열려 있는 패널을 한 번에 정렬해 전부 한 화면에 세운다. 무엇이 떠 있는지부터 확인하고 싶을 때 쓰는 모드다.", en: "Lays every open panel out at once so the whole set is on screen. This is the mode for finding out what is running before deciding where to look." },
    points: [
      { m: "LAYOUT", t: { ko: "**전체 자동 정렬** — 직접 배치한 좌표는 보존되고, Cruise로 돌아오면 되살아난다.", en: "**Everything arranged at once** — your hand-placed coordinates survive and come back with Cruise." } },
      { m: "SORT", t: { ko: "**Alt+S**로 사이드바를 Operation 상태 기준으로 정렬한다.", en: "**Alt+S** sorts the sidebar by operation status." } },
    ],
  },
  {
    n: "03",
    name: "War Room",
    kr: { ko: "한 건씩 처리", en: "One at a time" },
    tag: { ko: "Alt+T", en: "Alt+T" },
    required: false,
    desc: { ko: "여러 에이전트가 동시에 응답을 기다릴 때 고르는 모드. Operation을 한 번에 하나씩 무대에 올리고 나머지는 큐에 세워, 무엇부터 볼지 고르는 일 자체를 없앤다.", en: "The mode for when several agents are waiting on you. It stages a single Operation at a time and keeps the rest in a queue, so choosing what to look at stops being a decision." },
    points: [
      { m: "STAGE", t: { ko: "**한 번에 하나** — 나머지는 대기 큐에 서고, 순서를 잃지 않는다.", en: "**One at a time** — the rest wait in a queue without losing their place." } },
      { m: "DEFER", t: { ko: "**Alt+→**로 지금 것을 뒤로 미룬다. 답할 준비가 안 된 것을 붙잡고 있지 않아도 된다.", en: "**Alt+→** defers the staged one, so nothing you aren't ready to answer holds up the queue." } },
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
    name: "Orchestration Policy",
    kr: { ko: "오케스트레이션 정책", en: "Orchestration Policy" },
    desc: { ko: "실행은 위임하고 판단은 보유한다. 작업 복잡도에 실행 폭을 비례시키고, 모든 위임은 실행 표면과 신원을 명시적으로 고정한다.", en: "Delegate execution, retain judgment. Size the run to the task's complexity, and pin every handoff to an explicit surface and identity." },
  },
  {
    name: "Deep Dive",
    kr: { ko: "딥 다이브", en: "Deep Dive" },
    desc: { ko: "추측이 발견되는 즉시 자동 검증을 띄운다. 동일 가정에 대해 최대 2회까지 재검증하고, 그래도 불확실하면 미해결로 표시해 사용자에게 회부한다.", en: "Auto-verification launches the moment a guess appears. Up to two re-checks per assumption — still uncertain, it is surfaced to you as unresolved." },
  },
  {
    name: "Result Integrity",
    kr: { ko: "결과 무결성", en: "Result Integrity" },
    desc: { ko: "위임한 실행이 돌려준 결과는 관련성·완결성·내부 충돌 3축으로 검사하고, 파일을 바꾼 실행은 서사가 아니라 diff를 직접 읽어 판정한다. 실패가 누적되면 사용자에게 보고한다.", en: "Every delegated result is checked on three axes — relevance, completeness, internal consistency — and a run that changed files is judged by reading its diff, never its own summary. Repeated failure is reported to you." },
  },
];

const DIFFS = [
  {
    n: "01",
    name: "Multi-CLI Orchestration",
    kr: { ko: "멀티-CLI 오케스트레이션", en: "Multi-CLI Orchestration" },
    body: { ko: "제작사가 다듬은 에이전트 루프를 대체하지 않고 조율한다. Fleet은 실제 CLI 바이너리를 실행하고 지원 프로토콜로 말하므로, 이미 쓰던 기능과 인증이 그대로 살아 있다.", en: "Native runtimes are coordinated, not replaced. Fleet launches the actual CLI binary and speaks its supported protocol, so the capabilities and authentication you already use stay intact." },
  },
  {
    n: "02",
    name: "Sessions That Outlive the Tab",
    kr: { ko: "탭보다 오래 사는 세션", en: "Sessions That Outlive the Tab" },
    body: { ko: "Operation은 브라우저가 아니라 로컬 서버가 소유한다. 탭을 닫으면 소켓만 분리되고 PTY는 계속 돈다. 다시 열면 스크롤백을 재생하고 하던 일을 이어간다.", en: "An Operation is owned by the local server, not the browser. Closing the tab detaches the socket while the PTY keeps running; reopen it and the session replays its scrollback and carries on." },
  },
  {
    n: "03",
    name: "Credentials Stay Out of the Agent",
    kr: { ko: "자격 증명은 에이전트 밖에", en: "Credentials Stay Out of the Agent" },
    body: { ko: "게이트웨이는 API 프록시가 아니라 로컬 Claude Code 엔드포인트다. 자격 증명은 Console이 들고 상류 요청도 Console이 보내므로, 에이전트 프로세스는 그것을 한 번도 보지 않는다. 계정은 각자 자기 것을 쓴다 — Codex와 Cursor는 기존 구독, Kimi와 OpenCode Go는 등록한 API 키.", en: "The gateway is a local Claude Code endpoint, not an API proxy. The Console holds the credential and makes the upstream request, so the agent process never sees it. Each provider runs on your own account: an existing subscription for Codex and Cursor, a registered API key for Kimi and OpenCode Go." },
  },
  {
    n: "04",
    name: "Architectural Discipline",
    kr: { ko: "아키텍처 규율", en: "Architectural Discipline" },
    body: { ko: "빌드 게이트는 협상 불가. 패키지 경계는 CI가 매 PR마다 검사한다 — `core-*`는 Fleet 도메인을 몰라야 하고, 어기면 검사에서 걸린다. 각 단계는 그 자체로 컴파일·테스트를 통과해야 다음으로 넘어간다.", en: "Build gates are non-negotiable. Package boundaries are checked by CI on every pull request: `core-*` must stay Fleet-domain-agnostic, and a violation fails the check. Each step must compile and test on its own to advance." },
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
    verdict: { ko: "혼자서는 뛰어나다. 다만 세션이 하나뿐이다.", en: "Excellent on its own — but there is only ever one session." },
  },
  {
    cat: { ko: "멀티 에이전트 프레임", en: "Multi-agent framework" },
    name: "AutoGen · CrewAI · LangGraph",
    bullets: [
      { ko: "역할 정의 자유도 높음", en: "Highly flexible role definition" },
      { ko: "그래프·메시지 기반", en: "Graph- and message-based" },
      { ko: "프레임워크 학습 비용", en: "Framework learning cost" },
    ],
    verdict: { ko: "설계도는 강하다. 하지만 실행 환경은 직접 만들어야 한다.", en: "Strong blueprints — but you still build the runtime yourself." },
  },
  {
    cat: { ko: "컨테이너 격리형", en: "Container-isolated" },
    name: "OpenHands · Devin",
    bullets: [
      { ko: "가상 환경에서 자율 실행", en: "Autonomous execution in a virtual env" },
      { ko: "엔드-투-엔드 지향", en: "End-to-end oriented" },
      { ko: "백엔드 모델 단일/제한", en: "Single or limited backend models" },
    ],
    verdict: { ko: "강력한 단일 실행기. 여러 개를 동시에 감독하는 자리는 아니다.", en: "A powerful single runner — not a place to supervise several at once." },
  },
  {
    cat: "fleet-harness",
    name: "Fleet Console",
    us: true,
    bullets: [
      { ko: "서버가 소유하는 병렬 Operation", en: "Parallel, server-owned Operations" },
      { ko: "내 계정으로 닿는 4개 공급자", en: "Four providers on accounts you own" },
      { ko: "상시 작동하는 6개 Standing Order", en: "Six always-on Standing Orders" },
    ],
    verdict: { ko: "여러 에이전트를 동시에 감독하는 자리로 설계되었다.", en: "Built to be the place you supervise several agents at once." },
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
          <a href="#providers">{t(UI.navProviders)}</a>
          <a href="#modes">{t(UI.navModes)}</a>
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
  const nodeCount = PROVIDERS.length;
  const radius = 38;
  const nodes = Array.from({ length: nodeCount }, (_, i) => {
    const angle = (i / nodeCount) * Math.PI * 2 - Math.PI / 2;
    return {
      x: 50 + Math.cos(angle) * radius,
      y: 50 + Math.sin(angle) * radius,
      label: ["CX", "CR", "MS", "OC"][i],
      full: PROVIDERS[i].id,
      color: PROVIDERS[i].color,
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
              <em style={{color:"var(--brass-bright)", fontStyle:"italic"}}>{t(UI.heroDescOperation)}</em>
              {t(UI.heroDescMid)}
              <em style={{color:"var(--brass-bright)", fontStyle:"italic"}}>{t(UI.heroDescHost)}</em>
              {t(UI.heroDescMid2)}
              <em style={{color:"var(--brass-bright)", fontStyle:"italic"}}>{t(UI.heroDescOrders)}</em>
              {t(UI.heroDescTail)}
            </p>
            <div className="hero-actions">
              <a className="btn-primary" href="https://github.com/sbluemin/fleet-harness.git" target="_blank" rel="noreferrer">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.7.5.5 5.7.5 12c0 5 3.3 9.3 7.8 10.8.6.1.8-.3.8-.6v-2.1c-3.2.7-3.9-1.5-3.9-1.5-.5-1.4-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.8-1.6-2.6-.3-5.4-1.3-5.4-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.2 1.2.9-.3 1.9-.4 2.9-.4s2 .1 2.9.4c2.2-1.5 3.2-1.2 3.2-1.2.6 1.7.2 2.9.1 3.2.7.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.4 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6 4.5-1.5 7.8-5.8 7.8-10.8C23.5 5.7 18.3.5 12 .5z" /></svg>
                {t(UI.ctaRepo)}
              </a>
              <a className="btn-secondary" href="#providers">{t(UI.ctaProviders)}</a>
            </div>
            <div className="hero-meta">
              <div className="hero-meta-item">
                <div className="label">{t(UI.metaKinds)}</div>
                <div className="value"><em>{CLI_BACKENDS.length}</em> · {t(UI.metaKindsVal)}</div>
              </div>
              <div className="hero-meta-item">
                <div className="label">{t(UI.metaProviders)}</div>
                <div className="value"><em>{PROVIDERS.length}</em> · {t(UI.metaProvidersVal)}</div>
              </div>
              <div className="hero-meta-item">
                <div className="label">{t(UI.metaOrders)}</div>
                <div className="value"><em>{ORDERS.length}</em> · {t(UI.metaOrdersVal)}</div>
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
                <div className="name">Admiral<br/>HOST</div>
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

// ───── Gateway providers ─────
function Providers() {
  const [active, setActive] = useState(0);
  const c = PROVIDERS[active];
  const title = t(UI.providersTitle);
  return (
    <section className="section" id="providers">
      <div className="shell">
        <div className="section-head">
          <span className="eyebrow">{t(UI.providersEy)}</span>
          <div className="divider"></div>
          <h2 className="section-title">{title[0]}<br/>{title[1]}</h2>
          <p className="lede">{t(UI.providersLede)}</p>
        </div>
        <div className="providers-wrap">
          <div className="provider-list" role="tablist" aria-label={t(UI.providersAria)}>
            {PROVIDERS.map((cap, i) => (
              <button
                key={cap.id}
                role="tab"
                aria-selected={active === i}
                className={"provider-list-item " + (active === i ? "active" : "")}
                style={{ "--cap-color": cap.color }}
                onClick={() => setActive(i)}
              >
                <span className="provider-dot" aria-hidden="true"></span>
                <span className="provider-list-text">
                  <span className="provider-list-name">{cap.id}</span>
                  <span className="provider-list-role">{t(cap.role)}</span>
                </span>
              </button>
            ))}
          </div>

          <div
            className="provider-detail"
            style={{ "--cap-color": c.color }}
            key={c.id}
          >
            <div style={{animation: "fleet-pop 360ms var(--ease-spring) both"}}>
              <div className="provider-detail-head">
                <div className="provider-detail-title-block">
                  <div className="provider-id"><span>{t(UI.providerCap)}</span> · {c.id.toUpperCase()}</div>
                  <h3 className="provider-name">{c.id}</h3>
                  <div className="provider-role">{t(c.role)}</div>
                </div>
                <div className="provider-cli-badge">
                  <span className="ind" aria-hidden="true"></span>
                  {c.cli}
                </div>
              </div>
              <div className="provider-body">
                <div className="provider-mission">"{t(c.mission)}"</div>
                <div>
                  <div className="provider-model-title">{t(UI.reachableModels)}</div>
                  <ul className="provider-model-list">
                    {c.models.map((d, i) => <li key={i}>{t(d)}</li>)}
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

// ───── Canvas modes ─────
function Modes() {
  const [active, setActive] = useState(0);
  const p = MODES[active];
  const title = t(UI.modesTitle);
  return (
    <section className="section" id="modes">
      <div className="shell">
        <div className="section-head">
          <span className="eyebrow">{t(UI.modesEy)}</span>
          <div className="divider"></div>
          <h2 className="section-title">{title[0]}<br/>{title[1]}</h2>
          <p className="lede">{t(UI.modesLede)}</p>
        </div>
        <div className="modes-wrap">
          <div className="mode-rail" role="tablist" aria-label={t(UI.modesAria)}>
            {MODES.map((ph, i) => (
              <button
                key={ph.n}
                role="tab"
                aria-selected={active === i}
                className={
                  "mode-step " +
                  (active === i ? "active " : "") +
                  (ph.required ? "required" : "conditional")
                }
                onClick={() => setActive(i)}
              >
                <span className="mode-step-num">{ph.n}</span>
                <span className="mode-step-body">
                  <span className="mode-step-title">{ph.name}</span>
                  <span className="mode-step-tag">· {t(ph.tag)} · {t(ph.kr)}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="mode-detail" key={p.n}>
            <div style={{animation: "fleet-pop 320ms var(--ease-spring) both"}}>
              <div className="mode-detail-num" aria-hidden="true">{p.n}</div>
              <div className="mode-detail-eyebrow">
                <span>{t(UI.modeLabel)} {p.n}</span>
                <span style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: p.required ? "var(--coral)" : "var(--aurora)",
                  boxShadow: `0 0 8px ${p.required ? "var(--coral)" : "var(--aurora)"}`,
                }}></span>
                <span style={{color: p.required ? "var(--coral)" : "var(--aurora)"}}>{t(p.tag)}</span>
              </div>
              <h3 className="mode-detail-title">{p.name} <span style={{color:"var(--ink-fog)", fontWeight:300}}>· {t(p.kr)}</span></h3>
              <p className="mode-detail-desc">{t(p.desc)}</p>
              <div className="mode-detail-points">
                {p.points.map((pt, i) => (
                  <div className="mode-detail-point" key={i}>
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
            <span className="pr">$</span> npm install -g <span className="ar">@dotobokuri/fleet-console</span><br/>
            <span className="pr">$</span> fleet-console <span className="cm">{t(UI.setSailCmt)}</span>
          </div>
          <div className="closer-actions">
            <a className="btn-primary" href="https://github.com/sbluemin/fleet-harness.git" target="_blank" rel="noreferrer">
              {t(UI.ctaGithubView)}
            </a>
            <a className="btn-secondary" href="#modes">
              {t(UI.ctaModes)}
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
        <Providers />
        <Modes />
        <Orders />
        <Diffs />
        <Compare />
        <Closer />
      </main>
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
