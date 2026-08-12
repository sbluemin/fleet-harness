const { useState, useEffect, useRef } = React;

// ───── Locale ─────
// ?lang=en|ko가 우선, 없으면 브라우저 언어. 토글은 App 재마운트로 전체를 다시 그린다.
const urlLang = new URLSearchParams(location.search).get("lang");
let lang = (urlLang === "en" || urlLang === "ko")
  ? urlLang
  : ((typeof navigator !== "undefined" && navigator.language && navigator.language.startsWith("ko")) ? "ko" : "en");
if (typeof document !== "undefined" && document.documentElement) {
  document.documentElement.lang = lang;
}
const t = (obj) => (obj && typeof obj === "object" && (obj.ko || obj.en)) ? (obj[lang] ?? obj.en ?? obj.ko) : obj;

// ───── UI strings ─────
const UI = {
  navGateway:  { ko: "게이트웨이", en: "Gateway" },
  navModes:    { ko: "캔버스", en: "Canvas" },
  navAnywhere: { ko: "어디서든", en: "Anywhere" },
  navDoctrine: { ko: "교리", en: "Doctrine" },
  navCompare:  { ko: "비교", en: "Compare" },
  primaryAria: { ko: "주요 메뉴", en: "Primary" },
  langAria:    { ko: "언어 전환", en: "Switch language" },

  heroEyebrow: { ko: "Fleet Console · Research preview", en: "Fleet Console · Research preview" },
  heroT1: { ko: "모든 프런티어 코딩 에이전트.", en: "Every frontier coding agent." },
  heroT2: { ko: "하나의 콘솔.", en: "One console." },
  heroT3: { ko: "어떤 화면에서든.", en: "Any screen." },
  heroSub: {
    ko: "Fleet는 코딩 에이전트들을 내 머신이 소유한 라이브 세션으로 실행합니다. 탭을 닫아도 세션은 계속 돌고 — 브라우저에서도, 데스크톱 창에서도, 주머니 속 폰에서도 같은 함대를 지휘합니다.",
    en: "Fleet runs your coding agents as live sessions owned by your machine. Close the tab and they keep working — and you command the same fleet from a browser, a desktop window, or the phone in your pocket.",
  },
  metaProviders: { ko: "Gateway providers", en: "Gateway providers" },
  metaProvidersV: { ko: "구독과 API 키", en: "Subscriptions & API keys" },
  metaModes: { ko: "Canvas modes", en: "Canvas modes" },
  metaModesV: { ko: "Cruise · Tactical · War Room", en: "Cruise · Tactical · War Room" },
  metaScreens: { ko: "Screens", en: "Screens" },
  metaScreensV: { ko: "브라우저 · 데스크톱 · Android", en: "Browser · Desktop · Android" },
  bootTitle: { ko: "fleet — zsh", en: "fleet — zsh" },
  heroCap: {
    ko: "실제 화면 — 이 저장소 위에서 Claude Fable 5, Codex GPT-5.6 Sol, Cursor Grok 4.5가 나란히 도는 Tactical 캔버스.",
    en: "Real capture — Claude Fable 5, Codex GPT-5.6 Sol, and Cursor Grok 4.5 running side by side on the Tactical canvas, on this very repository.",
  },

  thesis1: { ko: "서버가 세션을 소유하면, ", en: "When the server owns the session, " },
  thesisEm: { ko: "화면은 골라 쓰는 것", en: "the screen becomes a choice" },
  thesis2: { ko: "이 됩니다.", en: "." },
  screenBrowser: { ko: "브라우저", en: "Browser" },
  screenDesktop: { ko: "데스크톱 앱", en: "Desktop app" },
  screenAndroid: { ko: "Android", en: "Android" },
  screenAndroidTag: { ko: "테스터 배포 중", en: "rolling out to testers" },

  gwEy: { ko: "AI Gateway", en: "AI Gateway" },
  gwT1: { ko: "런치 메뉴 하나 뒤의", en: "Every frontier model," },
  gwT2: { ko: "모든 프런티어 모델.", en: "one launch menu behind." },
  gwLede: {
    ko: "게이트웨이는 API 프록시가 아니라 로컬 Claude Code 엔드포인트입니다. 네이티브 에이전트 루프와 인증은 그대로 보존되고, 비-Anthropic 자격증명은 에이전트 프로세스에 결코 들어가지 않습니다.",
    en: "The gateway is a local Claude Code endpoint, not an API proxy. The native agent loop and authentication are preserved, and non-Anthropic credentials never enter the agent process.",
  },
  gwAria: { ko: "게이트웨이 공급자", en: "Gateway providers" },
  gwModels: { ko: "Models", en: "Models" },
  gwNote: {
    ko: "추론 강도는 모델마다 다르게 열립니다 — 지원하는 모델은 저마다의 사다리를 갖고, 가장 깊은 모델은 <b>MAX</b>와 <b>ULTRACODE</b>(xhigh 강도 + 상시 멀티 에이전트 오케스트레이션)를 정점 게이트 뒤에 드러냅니다.",
    en: "Reasoning effort opens differently per model — those that support it carry their own ladder, and the deepest expose <b>MAX</b> and <b>ULTRACODE</b> (xhigh effort plus standing multi-agent orchestration) behind an apex gate.",
  },
  gwShotCap: {
    ko: "실제 화면 — 캔버스 우클릭 한 번에 열리는 런치 메뉴. Claude, Codex, Cursor, Kimi, OpenCode가 한 목록에.",
    en: "Real capture — the launch menu on one right-click: Claude, Codex, Cursor, Kimi, and OpenCode in a single list.",
  },

  modesEy: { ko: "Canvas modes", en: "Canvas modes" },
  modesT1: { ko: "에이전트 하나에서", en: "A canvas that scales" },
  modesT2: { ko: "함대까지 늘어나는 캔버스.", en: "from one agent to a fleet." },
  modesLede: {
    ko: "Operation은 무한 캔버스 위에 살고, 커맨드 밴드의 스위치가 배치를 어디까지 직접 할지 정합니다.",
    en: "Operations live on an infinite canvas, and a switch in the command band decides how much of the arranging you do yourself.",
  },
  modesAria: { ko: "캔버스 모드", en: "Canvas modes" },
  modesShotCap: {
    ko: "실제 화면 — War Room이 Operation 하나를 스테이지에 올리고, 사이드바는 상태순, 하단 레일은 다음 순서를 쥐고 있다.",
    en: "Real capture — War Room stages one Operation, the sidebar sorts by status, and the bottom rail holds what's up next.",
  },

  railEy: { ko: "Activity Rail", en: "Activity Rail" },
  railT1: { ko: "터미널 옆의", en: "The whole project," },
  railT2: { ko: "프로젝트 전체.", en: "beside the terminal." },
  railLede: {
    ko: "여덟 개의 내장 패널이 감독 중인 Operation을 떠나지 않고 히스토리·워크트리·브랜치·토큰 지출·쿼터를 보여줍니다. 플러그인이 자기 패널을 더할 수 있습니다.",
    en: "Eight built-in panels show history, worktrees, branches, token spend, and quota without leaving the Operation you are supervising. Plugins can contribute their own.",
  },
  railShotCap: {
    ko: "실제 화면 — Repository 패널이 이 저장소의 커밋 그래프·워크트리 5개·브랜치·태그를 라이브 Operation 옆에 펼친 모습.",
    en: "Real capture — the Repository panel with this repo's commit graph, five worktrees, branches, and tags beside live Operations.",
  },
  analystT: { ko: "Session Analyst", en: "Session Analyst" },
  analystB: {
    ko: "Operation 하나에 붙는 읽기 전용 지성. 무슨 일이 있었는지 묻고, 근거가 인용된 아티팩트로 핸드오프 브리핑을 받습니다 — 에이전트는 건드리지 않습니다.",
    en: "Read-only intelligence for a single Operation. Ask what happened and get an evidence-cited handoff brief as an artifact — without disturbing the agent.",
  },

  anyEy: { ko: "Remote access · Experimental", en: "Remote access · Experimental" },
  anyT1: { ko: "주머니 속의", en: "Your fleet," },
  anyT2: { ko: "함대.", en: "in your pocket." },
  anyLede: {
    ko: "원격 접속을 켜면 이 콘솔은 페어링한 기기만 열 수 있습니다. QR 한 번이면 폰이 들어옵니다 — 아래는 전부 Android 에뮬레이터에서 실제 페어링에 성공한 화면입니다.",
    en: "Turn on Remote access and this console opens only to devices you pair. One QR scan brings the phone in — everything below is a real, successful pairing captured on the Android emulator.",
  },
  anyShotCap: {
    ko: "실제 화면 — 페어링된 콘솔 덱, Operations 목록, 그리고 폰 위에서 도는 Claude Code 세션.",
    en: "Real capture — the paired-consoles deck, the Operations list, and a Claude Code session running on the phone.",
  },
  pairT: { ko: "페어링은 세 걸음", en: "Pairing takes three steps" },
  qrCap: {
    ko: "콘솔이 QR 액세스 링크를 띄우고 기기를 기다리는 실제 화면. 링크는 한 번만, 15분만.",
    en: "The console showing a QR access link and waiting for a device — real capture. One use, fifteen minutes.",
  },

  docEy: { ko: "Doctrine", en: "Doctrine" },
  docT1: { ko: "결정은 당신이,", en: "You decide." },
  docT2: { ko: "실행은 함대가.", en: "The fleet executes." },
  docLede: {
    ko: "호스트 에이전트 Admiral이 작업을 분해해 적합한 모델에 위임하고, 여섯 개의 Standing Order가 모든 작업 위에서 상시 작동합니다.",
    en: "The Admiral — the host agent — decomposes work and delegates it to the model that fits, while six Standing Orders run above every task.",
  },
  active: { ko: "Active", en: "Active" },

  cmpEy: { ko: "Landscape", en: "Landscape" },
  cmpTitle: { ko: "에이전트 지형도 위에서.", en: "On the agent-tooling landscape." },
  cmpLede: {
    ko: "비슷한 도구는 많습니다. 그러나 에이전트를 서버가 소유하는 살아 있는 작업 단위로 다루는 도구는 드뭅니다.",
    en: "Plenty of similar tools. Few treat an agent as a live, server-owned unit of work.",
  },

  closerEy: { ko: "Get started", en: "Get started" },
  closerT1: { ko: "콘솔을 켜고,", en: "Start the console," },
  closerT2: { ko: "첫 Operation을 띄우세요.", en: "launch your first Operation." },
  closerSub: {
    ko: "모든 것이 내 머신에서 돕니다. 서버는 기본적으로 루프백에만 바인딩되고, 브라우저는 프로바이더 토큰을 받지 않으며, 원격 접속은 켜야 열리고 — 열려도 페어링한 기기만 들어옵니다.",
    en: "Everything runs on your machine. The server binds to loopback by default, the browser never receives provider tokens, and remote access opens only when you turn it on — and even then, only to devices you've paired.",
  },
  installCmt: { ko: "# install the console", en: "# install the console" },
  startCmt: { ko: "# starts it, and opens it in your browser", en: "# starts it, and opens it in your browser" },
  ctaGithub: { ko: "GitHub에서 보기", en: "View on GitHub" },
  ctaGateway: { ko: "게이트웨이 모델 보기", en: "See the gateway models" },
  footerLine: { ko: "fleet-harness · Fleet Console", en: "fleet-harness · Fleet Console" },
  footerMeta: { ko: "1 콘솔 · 4 프로바이더 · 3 캔버스 모드 · 어떤 화면에서든", en: "one console · four providers · three canvas modes · any screen" },
};

// ───── Data ─────
const PROVIDERS = [
  {
    id: "Codex",
    role: { ko: "OpenAI · ChatGPT 구독", en: "OpenAI · ChatGPT subscription" },
    cred: "subscription",
    color: "#5fd673",
    mission: {
      ko: "GPT-5.6 계열을 Claude Code 표면으로 들여온다. 추론 강도 사다리가 가장 깊은 경로다 — Sol과 Terra는 low부터 ultra까지, Luna는 max까지 노출하므로 같은 모델을 가벼운 작업과 어려운 판단에 다른 강도로 쓸 수 있다.",
      en: "Brings the GPT-5.6 family onto the Claude Code surface, with the deepest reasoning ladder of any provider here: Sol and Terra run from low through ultra, Luna through max, so one model serves both cheap mechanical work and hard judgment.",
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
    cred: "subscription",
    color: "#d4af37",
    mission: {
      ko: "쓰던 Cursor 구독으로 Cursor의 에이전트 라인업에 닿는다. Auto는 작업에 맞는 모델을 Cursor가 스스로 고르는 좌석이고, Composer와 Grok은 Fast 변형까지 따로 선다.",
      en: "Rides the Cursor subscription you already have into Cursor's agent lineup. Auto is the seat where Cursor picks the model for the task; Composer and Grok each stand with their own Fast variant.",
    },
    models: [
      { ko: "Auto — Cursor가 모델을 선택", en: "Auto — Cursor picks the model" },
      { ko: "Composer 2.5 — Fast 변형 포함", en: "Composer 2.5 — Fast variant included" },
      { ko: "Grok 4.5 — Fast 변형 포함", en: "Grok 4.5 — Fast variant included" },
    ],
  },
  {
    id: "Moonshot",
    role: { ko: "Moonshot AI · Kimi API 키", en: "Moonshot AI · Kimi API key" },
    cred: "API key",
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
    cred: "API key",
    color: "#fb7185",
    mission: {
      ko: "오픈 웨이트 모델을 가장 많이 모아 둔 경로. 기계적인 대량 작업을 값싼 신원에 흩뿌릴 때 쓰는 폭이 여기서 나온다.",
      en: "The widest bench of open-weight models. This is where the breadth comes from when mechanical, high-volume work is spread across cheaper identities.",
    },
    models: [
      { ko: "MiniMax M3 · Qwen3.8 Max", en: "MiniMax M3 and Qwen3.8 Max" },
      { ko: "DeepSeek V4 Flash · Pro", en: "DeepSeek V4 Flash and Pro" },
      { ko: "GLM-5.2 · Kimi K3 · HY3", en: "GLM-5.2, Kimi K3, and HY3" },
      { ko: "MiMo V2.5 · Pro", en: "MiMo V2.5 and Pro" },
      { ko: "Grok 4.5 · GPT-5.6 Luna", en: "Grok 4.5 and GPT-5.6 Luna" },
    ],
  },
];

const MODES = [
  {
    name: "Cruise",
    tag: { ko: "기본", en: "Default" },
    kr: { ko: "직접 배치", en: "Place them yourself" },
    keys: null,
    desc: {
      ko: "패널을 원하는 자리에 직접 놓는 기본 모드. 무한 캔버스 위에서 위치와 크기를 스스로 정하고, 그 배치는 다음에 열 때도 그대로 남는다. Station Keeping을 켜면 패널이 서로 겹치지 않게 자동으로 간격을 지킨다.",
      en: "The default: put each panel where you want it. Position and size are yours on the infinite canvas, and the arrangement survives your next visit. Station Keeping, if you turn it on, keeps panels clear of one another.",
    },
    points: [
      { ko: "**무한 캔버스** — 패널마다 위치·크기를 기억한다.", en: "**An infinite canvas** — every panel remembers its own position and size." },
      { ko: "**⌘K**로 모든 Theater에 걸쳐 검색, **⌘P**로 커맨드 팔레트.", en: "**⌘K** searches across every Theater; **⌘P** opens the command palette." },
    ],
  },
  {
    name: "Tactical",
    tag: { ko: "Alt+F", en: "Alt+F" },
    kr: { ko: "한 번에 정렬", en: "Lay them all out" },
    keys: ["Alt", "F"],
    desc: {
      ko: "열려 있는 패널을 그리드·열·행으로 한 번에 정렬해 전부 한 화면에 세운다. 무엇이 떠 있는지부터 확인하고 싶을 때 쓰는 모드다.",
      en: "Lays every open panel out at once — grid, columns, or rows — so the whole set is on screen. This is the mode for finding out what is running before deciding where to look.",
    },
    points: [
      { ko: "**전체 자동 정렬** — 직접 배치한 좌표는 보존되고, Cruise로 돌아오면 되살아난다.", en: "**Everything arranged at once** — hand-placed coordinates survive and come back with Cruise." },
      { ko: "**Alt+S**로 사이드바를 Operation 상태 기준으로 정렬한다.", en: "**Alt+S** sorts the sidebar by operation status." },
    ],
  },
  {
    name: "War Room",
    tag: { ko: "Alt+T", en: "Alt+T" },
    kr: { ko: "한 건씩 처리", en: "One at a time" },
    keys: ["Alt", "T"],
    desc: {
      ko: "여러 에이전트가 동시에 응답을 기다릴 때 고르는 모드. Theater를 가로지르는 대기열에서 Operation을 한 번에 하나씩 무대에 올리고, 무엇부터 볼지 고르는 일 자체를 없앤다.",
      en: "The mode for when several agents are waiting on you. It stages one Operation at a time from a cross-Theater queue, so choosing what to look at stops being a decision.",
    },
    points: [
      { ko: "**한 번에 하나** — 나머지는 대기 큐에 서고, 순서를 잃지 않는다.", en: "**One at a time** — the rest wait in a queue without losing their place." },
      { ko: "**Alt+→**로 지금 것을 뒤로 미룬다. 답할 준비가 안 된 것이 큐를 막지 않는다.", en: "**Alt+→** defers the staged one, so nothing you aren't ready for holds up the queue." },
    ],
  },
];

const PANELS = [
  { n: "Alerts", d: { ko: "알림", en: "notifications" } },
  { n: "Codex", d: { ko: "세션 노트", en: "session notes" } },
  { n: "Shell", d: { ko: "PTY", en: "a real PTY" } },
  { n: "Files", d: { ko: "파일 탐색", en: "file explorer" } },
  { n: "Repository", d: { ko: "git 전부", en: "all of git" } },
  { n: "Skills", d: { ko: "워크플로우", en: "workflows" } },
  { n: "Ledger", d: { ko: "토큰 지출", en: "token spend" } },
  { n: "Usage limits", d: { ko: "쿼터·리스크", en: "quota & risk" } },
];

const PAIR_STEPS = [
  {
    h: { ko: "콘솔이 링크를 발급한다", en: "The console mints a link" },
    p: {
      ko: "Settings → Remote access에서 QR 액세스 링크를 만든다. **한 번만 쓰이고, 안 쓰면 15분에 만료**되며, 정확히 한 기기를 페어링한다.",
      en: "Create a QR access link under Settings → Remote access. It **works once, expires in 15 minutes unused**, and pairs exactly one device.",
    },
  },
  {
    h: { ko: "폰이 신원을 검증한다", en: "The phone verifies identity" },
    p: {
      ko: "링크는 콘솔의 **인증서 지문**을 싣고 다닌다. Android 셸은 WebView가 한 바이트라도 보기 전에 네이티브로 핀을 검증한다 — 다른 인증서로 답하는 콘솔은 열리지 않는다.",
      en: "The link carries the console's **certificate fingerprint**. The Android shell verifies the pin natively before the WebView sees a single byte — a console answering with a different certificate does not open.",
    },
  },
  {
    h: { ko: "페어링은 살아남는다", en: "The pairing survives" },
    p: {
      ko: "링크는 일회용이지만 **페어링은 양쪽의 재시작을 견딘다**. 제어권은 한 번에 한 기기 — 다른 기기가 잡으면 나머지는 명시적인 커튼 뒤에서 관전한다.",
      en: "Links are disposable, but **the pairing survives restarts on both ends**. Control belongs to one device at a time — when another takes it, everyone else watches behind an explicit curtain.",
    },
  },
];

const GUARDS = [
  {
    k: "LISTENER",
    b: { ko: "<b>문은 페어링 하나뿐.</b> 원격 리스너는 세션 없이는 다른 무엇에도 답하지 않고, 페어링 문에는 실패 예산이 걸려 노출된 엔드포인트를 공짜로 두들길 수 없다.", en: "<b>Pairing is the only door.</b> A remote listener answers nothing without a session, and a failure budget on the pairing door means an exposed endpoint cannot be hammered for free." },
  },
  {
    k: "WATCH",
    b: { ko: "<b>보기만 하는 링크가 따로 있다.</b> 모니터링 전용 링크로 페어링한 기기는 관전만 하고, 이 머신에서 명령을 실행할 수 없다.", en: "<b>Watch-only links exist.</b> A device paired with a monitoring-only link can watch but never run commands on this machine." },
  },
  {
    k: "NAT",
    b: { ko: "<b>공개 도달은 이중 옵트인.</b> LAN 수신이 하나의 결정이라면, NAT 경로로 공개 호스트 이름을 광고하는 것은 별도의 확인까지 요구하는 또 하나의 결정이다.", en: "<b>Public reach is a double opt-in.</b> LAN listening is one decision; advertising a public hostname over a NAT route is a second, explicitly acknowledged one." },
  },
];

const TIERS = [
  {
    k: "Tier 01 · Decide",
    name: { ko: "당신", en: "You" },
    p: { ko: "최종 의사 결정자. 무엇을 할지 정하고, 되돌리기 어려운 행동을 승인한다.", en: "The final decision-maker. Sets what gets done and approves anything hard to reverse." },
  },
  {
    k: "Tier 02 · Host agent",
    name: { ko: "Admiral", en: "Admiral" },
    p: { ko: "작업을 분해하고 적합한 모델에 위임하며, 돌아온 결과를 산출물 단위로 검사한 뒤 통합한다.", en: "Decomposes the work, delegates it to the model that fits, then inspects the returned artifacts before integrating them." },
  },
  {
    k: "Tier 03 · Session",
    name: { ko: "Operation", en: "Operation" },
    p: { ko: "실제 터미널 세션. 로컬 서버가 소유하므로 탭을 닫아도 계속 실행되고 출력도 계속 쌓인다.", en: "A real terminal session, owned by the local server — it keeps running and buffering output after the tab closes." },
  },
];

const ORDERS = [
  { name: "Command Integrity", kr: { ko: "명령 무결성", en: "" }, desc: { ko: "결함 있는 명령에는 근거를 갖춰 진언하고, 결정형 모호함은 착수 전에 질문으로 해소하며, 명시 범위 밖 권한을 가정하지 않는다.", en: "Flawed orders get a reasoned pushback, decision-shaped ambiguity is resolved before work starts, and no permission is assumed beyond the granted scope." } },
  { name: "Mission Anchor", kr: { ko: "임무 정렬", en: "" }, desc: { ko: "임무 목표를 한 문장으로 고정하고, 경계마다 복창·자가 점검하며, 표류가 감지되면 즉시 복귀한다.", en: "The mission is pinned to one sentence, recalled at every boundary, and drift halts the work until the objective is recovered." } },
  { name: "Context Confidence", kr: { ko: "맥락 확신", en: "" }, desc: { ko: "결정 경계 전 증거 충분성을 판정한다. 증거 목록 없는 확신은 추측으로 강등되고, 기준 미달이면 정찰로 재진입한다.", en: "Evidence sufficiency is graded before decisions. Confidence with no evidence list is demoted to speculation; below threshold, back to reconnaissance." } },
  { name: "Orchestration Policy", kr: { ko: "오케스트레이션 정책", en: "" }, desc: { ko: "실행은 위임하고 판단은 보유한다. 작업 복잡도에 실행 폭을 비례시키고, 모든 위임은 표면과 신원을 고정한다.", en: "Delegate execution, retain judgment. Size the run to the task, and pin every handoff to an explicit surface and identity." } },
  { name: "Deep Dive", kr: { ko: "딥 다이브", en: "" }, desc: { ko: "추측이 발견되는 즉시 검증을 띄운다. 두 번 재검증해도 불확실하면 미해결로 표시해 사용자에게 회부한다.", en: "Verification launches the moment a guess appears. Still uncertain after two re-checks, it is surfaced as unresolved." } },
  { name: "Result Integrity", kr: { ko: "결과 무결성", en: "" }, desc: { ko: "위임 결과는 관련성·완결성·충돌 3축으로 검사하고, 파일을 바꾼 실행은 서사가 아니라 diff를 직접 읽어 판정한다.", en: "Results are checked for relevance, completeness, and conflicts — and a run that changed files is judged by its diff, never its own summary." } },
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
      { ko: "브라우저·데스크톱·Android", en: "Browser, desktop, and Android" },
    ],
    verdict: { ko: "여러 에이전트를 동시에 감독하는 자리로 설계되었다.", en: "Built to be the place you supervise several agents at once." },
  },
];

// ───── helpers ─────
const strong = (s) => ({ __html: t(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>") });

function Reveal({ children, as: Tag = "div", className = "" }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.classList.add("in");
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { el.classList.add("in"); io.disconnect(); } });
    }, { threshold: 0.12 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <Tag ref={ref} className={"rv " + className}>{children}</Tag>;
}

// ───── Nav ─────
function Nav({ onFlip }) {
  return (
    <header className="topnav">
      <div className="shell topnav-inner">
        <a href="#top" className="brand">
          <span className="dot" aria-hidden="true"></span>
          fleet<span className="muted">-harness</span>
        </a>
        <nav className="nav-links" aria-label={t(UI.primaryAria)}>
          <a href="#gateway">{t(UI.navGateway)}</a>
          <a href="#modes">{t(UI.navModes)}</a>
          <a href="#anywhere">{t(UI.navAnywhere)}</a>
          <a href="#doctrine">{t(UI.navDoctrine)}</a>
          <a href="#compare">{t(UI.navCompare)}</a>
        </nav>
        <div className="nav-side">
          <button className="lang-flip" onClick={onFlip} aria-label={t(UI.langAria)}>
            {lang === "ko" ? "EN" : "한국어"}
          </button>
          <a href="https://github.com/sbluemin/fleet-harness" className="nav-cta" target="_blank" rel="noreferrer">GitHub</a>
        </div>
      </div>
    </header>
  );
}

// ───── Hero ─────
const BOOT_LINES = [
  { cls: "d", text: "$ npm install -g @dotobokuri/fleet-console" },
  { cls: "c", text: "$ fleet console" },
  { cls: "", text: "Fleet Console opened." },
  { cls: "", text: "Fleet Console server: running" },
  { cls: "p", text: "  console    http://127.0.0.1:52696/console/" },
];

function BootTerminal() {
  const [typed, setTyped] = useState(() =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ? BOOT_LINES.length : 0);
  const [chars, setChars] = useState(0);

  useEffect(() => {
    if (typed >= BOOT_LINES.length) return;
    const line = BOOT_LINES[typed];
    const isCommand = line.text.startsWith("$");
    if (isCommand && chars < line.text.length) {
      const id = setTimeout(() => setChars(chars + 1), 26);
      return () => clearTimeout(id);
    }
    const id = setTimeout(() => { setTyped(typed + 1); setChars(0); }, isCommand ? 320 : 150);
    return () => clearTimeout(id);
  }, [typed, chars]);

  return (
    <div className="boot" role="img" aria-label="fleet console starting in a terminal">
      <div className="boot-bar" aria-hidden="true"><i></i><i></i><i></i><span>{t(UI.bootTitle)}</span></div>
      <div className="boot-body" aria-hidden="true">
        {BOOT_LINES.slice(0, typed).map((l, i) => (
          <span key={i} className={l.cls}>{l.text}{"\n"}</span>
        ))}
        {typed < BOOT_LINES.length && BOOT_LINES[typed].text.startsWith("$") && (
          <span className={BOOT_LINES[typed].cls}>{BOOT_LINES[typed].text.slice(0, chars)}</span>
        )}
        <span className="caret"></span>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section className="hero" id="top">
      <div className="shell">
        <div className="hero-eyebrow">
          <span className="pulse" aria-hidden="true"></span>
          {t(UI.heroEyebrow)}
        </div>
        <h1 className="hero-title">
          {t(UI.heroT1)}<br/>{t(UI.heroT2)} <em>{t(UI.heroT3)}</em>
        </h1>
        <p className="hero-sub">{t(UI.heroSub)}</p>

        <div className="hero-row">
          <div className="hero-meta">
            <div className="item">
              <div className="k">{t(UI.metaProviders)}</div>
              <div className="v"><em>4</em> · {t(UI.metaProvidersV)}</div>
            </div>
            <div className="item">
              <div className="k">{t(UI.metaModes)}</div>
              <div className="v"><em>3</em> · {t(UI.metaModesV)}</div>
            </div>
            <div className="item">
              <div className="k">{t(UI.metaScreens)}</div>
              <div className="v"><em>3</em> · {t(UI.metaScreensV)}</div>
            </div>
          </div>
          <BootTerminal />
        </div>

        <Reveal as="figure" className="dock">
          <div className="plate"><img src="assets/console-canvas.png" alt={t(UI.heroCap)} /></div>
          <i className="corner tl" aria-hidden="true"></i><i className="corner tr" aria-hidden="true"></i>
          <i className="corner bl" aria-hidden="true"></i><i className="corner br" aria-hidden="true"></i>
          <figcaption><b>●</b> {t(UI.heroCap)}</figcaption>
        </Reveal>
      </div>
    </section>
  );
}

// ───── Thesis ─────
function Thesis() {
  return (
    <section className="thesis">
      <div className="shell">
        <Reveal>
          <p className="thesis-line">{t(UI.thesis1)}<em>{t(UI.thesisEm)}</em>{t(UI.thesis2)}</p>
          <div className="screens">
            <span className="screen-chip"><i aria-hidden="true"></i>{t(UI.screenBrowser)}</span>
            <span className="screen-chip"><i aria-hidden="true"></i>{t(UI.screenDesktop)}</span>
            <span className="screen-chip soon"><i aria-hidden="true"></i>{t(UI.screenAndroid)} <span className="tag">· {t(UI.screenAndroidTag)}</span></span>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

// ───── Gateway ─────
function Gateway() {
  const [active, setActive] = useState(0);
  const c = PROVIDERS[active];
  return (
    <section className="section" id="gateway">
      <div className="shell">
        <Reveal className="section-head">
          <span className="eyebrow">{t(UI.gwEy)}</span>
          <h2 className="section-title">{t(UI.gwT1)}<br/><em>{t(UI.gwT2)}</em></h2>
          <p className="lede">{t(UI.gwLede)}</p>
        </Reveal>
        <Reveal>
          <div className="gateway-grid">
            <div className="provider-tabs" role="tablist" aria-label={t(UI.gwAria)}>
              {PROVIDERS.map((p, i) => (
                <button key={p.id} role="tab" aria-selected={active === i}
                  className="provider-tab" style={{ "--pv": p.color }}
                  onClick={() => setActive(i)}>
                  <span className="pd" aria-hidden="true"></span>
                  <span><span className="nm">{p.id}</span><span className="rl">{t(p.role)}</span></span>
                </button>
              ))}
            </div>
            <div className="provider-detail" style={{ "--pv": c.color }} key={c.id}>
              <div className="cred">{c.cred}</div>
              <h3>{c.id}</h3>
              <p className="mission">{t(c.mission)}</p>
              <div className="eyebrow" style={{ marginBottom: 10 }}>{t(UI.gwModels)}</div>
              <ul className="model-list">
                {c.models.map((m, i) => <li key={i}>{t(m)}</li>)}
              </ul>
            </div>
          </div>
          <div className="gateway-note" dangerouslySetInnerHTML={{ __html: t(UI.gwNote) }}></div>
        </Reveal>
        <Reveal className="gateway-shot">
          <div className="shot"><img src="assets/console-launch-menu.png" alt={t(UI.gwShotCap)} /></div>
          <div className="shot-cap">● {t(UI.gwShotCap)}</div>
        </Reveal>
      </div>
    </section>
  );
}

// ───── Modes ─────
function Modes() {
  const [active, setActive] = useState(2);
  const m = MODES[active];
  return (
    <section className="section" id="modes">
      <div className="shell">
        <Reveal className="section-head">
          <span className="eyebrow">{t(UI.modesEy)}</span>
          <h2 className="section-title">{t(UI.modesT1)}<br/><em>{t(UI.modesT2)}</em></h2>
          <p className="lede">{t(UI.modesLede)}</p>
        </Reveal>
        <Reveal>
          <div className="mode-band" role="tablist" aria-label={t(UI.modesAria)}>
            {MODES.map((mm, i) => (
              <button key={mm.name} role="tab" aria-selected={active === i}
                className="mode-pill" onClick={() => setActive(i)}>
                {mm.name}
              </button>
            ))}
          </div>
          <div className="mode-split" key={m.name}>
            <div className="mode-copy">
              <h3>{m.name}</h3>
              <div className="kbd-row">
                {m.keys
                  ? m.keys.map((k, i) => <React.Fragment key={k}>{i > 0 && " + "}<kbd>{k}</kbd></React.Fragment>)
                  : <kbd>{t(m.tag)}</kbd>}
                <span style={{ color: "var(--fog)", fontSize: 13, marginLeft: 10 }}>{t(m.kr)}</span>
              </div>
              <p>{t(m.desc)}</p>
              <div className="mode-points">
                {m.points.map((pt, i) => (
                  <div className="pt" key={i}><i aria-hidden="true"></i><span dangerouslySetInnerHTML={strong(pt)}></span></div>
                ))}
              </div>
            </div>
            <div>
              <div className="shot"><img src="assets/console-war-room.png" alt={t(UI.modesShotCap)} /></div>
              <div className="shot-cap">● {t(UI.modesShotCap)}</div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

// ───── Rail ─────
function Rail() {
  return (
    <section className="section" id="rail">
      <div className="shell">
        <Reveal className="section-head">
          <span className="eyebrow">{t(UI.railEy)}</span>
          <h2 className="section-title">{t(UI.railT1)}<br/><em>{t(UI.railT2)}</em></h2>
          <p className="lede">{t(UI.railLede)}</p>
        </Reveal>
        <Reveal>
          <div className="rail-grid">
            <div>
              <div className="shot"><img src="assets/console-repository.png" alt={t(UI.railShotCap)} /></div>
              <div className="shot-cap">● {t(UI.railShotCap)}</div>
            </div>
            <div>
              <div className="panel-list">
                {PANELS.map((p) => (
                  <div className="p" key={p.n}>{p.n} <span>· {t(p.d)}</span></div>
                ))}
              </div>
              <div className="analyst">
                <div className="t">{t(UI.analystT)}</div>
                {t(UI.analystB)}
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

// ───── Anywhere ─────
function Anywhere() {
  return (
    <section className="section" id="anywhere">
      <div className="shell">
        <Reveal className="section-head">
          <span className="eyebrow">{t(UI.anyEy)}</span>
          <h2 className="section-title">{t(UI.anyT1)} <em>{t(UI.anyT2)}</em></h2>
          <p className="lede">{t(UI.anyLede)}</p>
        </Reveal>
        <Reveal className="anywhere-hero">
          <div className="shot"><img src="assets/mobile-android.png" alt={t(UI.anyShotCap)} /></div>
          <div className="shot-cap">● {t(UI.anyShotCap)}</div>
        </Reveal>
        <Reveal>
          <div className="pairing">
            <div>
              <div className="eyebrow" style={{ marginBottom: 6 }}>{t(UI.pairT)}</div>
              <div className="steps">
                {PAIR_STEPS.map((s, i) => (
                  <div className="step" key={i}>
                    <div className="n" aria-hidden="true"></div>
                    <div>
                      <h4>{t(s.h)}</h4>
                      <p dangerouslySetInnerHTML={strong(s.p)}></p>
                    </div>
                  </div>
                ))}
              </div>
              <div className="guard-list">
                {GUARDS.map((g) => (
                  <div className="guard" key={g.k}>
                    <i>{g.k}</i>
                    <span dangerouslySetInnerHTML={{ __html: t(g.b) }}></span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="shot"><img src="assets/console-remote-pairing.png" alt={t(UI.qrCap)} /></div>
              <div className="shot-cap">● {t(UI.qrCap)}</div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

// ───── Doctrine ─────
function Doctrine() {
  return (
    <section className="section" id="doctrine">
      <div className="shell">
        <Reveal className="section-head">
          <span className="eyebrow">{t(UI.docEy)}</span>
          <h2 className="section-title">{t(UI.docT1)} <em>{t(UI.docT2)}</em></h2>
          <p className="lede">{t(UI.docLede)}</p>
        </Reveal>
        <Reveal>
          <div className="tiers">
            {TIERS.map((tr) => (
              <div className="tier" key={tr.k}>
                <div className="k">{tr.k}</div>
                <h4>{t(tr.name)}</h4>
                <p>{t(tr.p)}</p>
              </div>
            ))}
          </div>
          <div className="orders-grid">
            {ORDERS.map((o) => (
              <div className="order" key={o.name}>
                <div className="live-row"><i aria-hidden="true"></i>{t(UI.active)}</div>
                <h4>{o.name}</h4>
                {lang === "ko" && <div className="kr">{t(o.kr)}</div>}
                <p>{t(o.desc)}</p>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

// ───── Compare ─────
function Compare() {
  return (
    <section className="section" id="compare">
      <div className="shell">
        <Reveal className="section-head">
          <span className="eyebrow">{t(UI.cmpEy)}</span>
          <h2 className="section-title">{t(UI.cmpTitle)}</h2>
          <p className="lede">{t(UI.cmpLede)}</p>
        </Reveal>
        <Reveal>
          <div className="compare-grid">
            {COMPARES.map((c) => (
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
        </Reveal>
      </div>
    </section>
  );
}

// ───── Closer ─────
function Closer() {
  return (
    <section className="closer" id="install">
      <div className="shell">
        <Reveal className="closer-card">
          <span className="eyebrow">{t(UI.closerEy)}</span>
          <h2 className="closer-title">{t(UI.closerT1)}<br/><em>{t(UI.closerT2)}</em></h2>
          <p className="closer-sub">{t(UI.closerSub)}</p>
          <div className="install">
            <span className="cm">{t(UI.installCmt)}</span><br/>
            <span className="pr">$</span> npm install -g <span className="ar">@dotobokuri/fleet-console</span><br/>
            <span className="pr">$</span> fleet console  <span className="cm">{t(UI.startCmt)}</span>
          </div>
          <div className="closer-actions">
            <a className="btn-primary" href="https://github.com/sbluemin/fleet-harness" target="_blank" rel="noreferrer">{t(UI.ctaGithub)}</a>
            <a className="btn-secondary" href="#gateway">{t(UI.ctaGateway)}</a>
          </div>
        </Reveal>
        <div className="footer">
          <div>{t(UI.footerLine)}</div>
          <div>{t(UI.footerMeta)}</div>
        </div>
      </div>
    </section>
  );
}

// ───── App ─────
function App() {
  const [, force] = useState(0);
  const flip = () => {
    lang = lang === "ko" ? "en" : "ko";
    document.documentElement.lang = lang;
    const url = new URL(location.href);
    url.searchParams.set("lang", lang);
    history.replaceState(null, "", url);
    force((n) => n + 1);
  };
  return (
    <React.Fragment key={lang}>
      <Nav onFlip={flip} />
      <main>
        <Hero />
        <Thesis />
        <Gateway />
        <Modes />
        <Rail />
        <Anywhere />
        <Doctrine />
        <Compare />
        <Closer />
      </main>
    </React.Fragment>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
