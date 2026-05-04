const _forceLang = new URLSearchParams(location.search).get('lang');
const LANG = _forceLang === 'ko' || _forceLang === 'en'
  ? _forceLang
  : navigator.language.startsWith('ko') ? 'ko' : 'en';
const tr = (ko, en) => LANG === 'ko' ? ko : en;

const { useState, useEffect } = React;

// ───── Data ─────
const HIERARCHY = [
  {
    rank: "Tier 01",
    role: tr("대원수", "Admiral of the Navy"),
    en: "Admiral of the Navy · USER",
    desc: tr(
      "최종 의사 결정자. 임무를 부여하고 함대의 행동을 승인한다.",
      "The final decision-maker. Issues missions and approves fleet actions."
    ),
  },
  {
    rank: "Tier 02",
    role: tr("제독", "Admiral"),
    en: "Admiral · HOST",
    desc: tr(
      "함대 지휘관. 임무를 분해하고 적임 함장에게 위임하며, 결과를 통합·검증한다.",
      "Fleet commander. Breaks missions into tasks, delegates to the right captain, and integrates results."
    ),
  },
  {
    rank: "Tier 03",
    role: tr("함장", "Captain"),
    en: "Captain · CLI AGENT",
    desc: tr(
      "8명의 전문 함장. 각자의 영역에서 단일 CLI 백엔드를 운용해 작전을 수행한다.",
      "8 specialized captains. Each operates a single CLI backend within their dedicated domain."
    ),
  },
];

const CLI_BACKENDS = [
  { num: "01", vendor: "Anthropic", name: "Claude Code", tag: tr("장기 추론·아키텍처 판단의 표준 백엔드", "Standard backend for long-horizon reasoning and architecture"), color: "oklch(78% 0.13 75)" },
  { num: "02", vendor: "Z.AI", name: "Claude Code · GLM", tag: tr("Anthropic 호환 · GLM 구동 코스트 절감 라인", "Anthropic-compatible · GLM-powered cost-efficient line"), color: "oklch(82% 0.13 195)" },
  { num: "03", vendor: "Moonshot", name: "Claude Code · Kimi", tag: tr("Anthropic 호환 · 초장문 컨텍스트 라인", "Anthropic-compatible · ultra-long context line"), color: "oklch(78% 0.14 290)" },
  { num: "04", vendor: "OpenAI", name: "Codex", tag: tr("도구 호출과 실행 위임에 최적화된 작업 함정", "Optimized for tool calls and execution delegation"), color: "oklch(72% 0.17 25)" },
  { num: "05", vendor: "Google", name: "Gemini", tag: tr("외부 인텔리전스 · 대규모 컨텍스트 정찰함", "External intelligence · large-context scout"), color: "oklch(78% 0.14 145)" },
  { num: "06", vendor: "Open Source", name: "OpenCode Go", tag: tr("오픈코어 폴백 · 자체 호스팅 모델 게이트웨이", "Open-core fallback · self-hosted model gateway"), color: "oklch(74% 0.06 248)" },
];

const CAPTAINS = [
  {
    id: "Vanguard",
    role: "Scout Specialist",
    cli: "Codex CLI",
    color: "#5fd673",
    mission: tr(
      "안개를 먼저 가르는 자. 함대 어떤 작전보다 먼저 정찰을 띄운다.",
      "First to cut through the fog. Launches recon before any fleet operation begins."
    ),
    duties: [
      tr("코드베이스 정찰 — 디렉터리·심볼·호출 그래프 추적", "Codebase recon — directory, symbol, call graph tracing"),
      tr("분산 정찰 — 서브-스카우트 동시 파견으로 면적 확보", "Distributed recon — concurrent sub-scouts for wide coverage"),
      tr("웹 리서치 — 외부 레퍼런스·표준·라이브러리 문서 수집", "Web research — external refs, standards, library docs"),
      tr("지식 갭 좌표화 — Reconnaissance 단계 입력으로 환원", "Knowledge gap mapping — feed into Reconnaissance phase"),
    ],
  },
  {
    id: "Tempest",
    role: "External Intelligence Strike",
    cli: "Gemini CLI",
    color: "#3dd5f3",
    mission: tr(
      "수평선 너머의 코드를 가져온다. 외부 저장소·API·SDK는 모두 그의 사정거리.",
      "Brings code from beyond the horizon. External repos, APIs, and SDKs are all within range."
    ),
    duties: [
      tr("GitHub 외부 저장소 조사 및 비교 분석", "GitHub external repo investigation and comparative analysis"),
      tr("API·SDK 시그니처와 의미론 분석", "API/SDK signature and semantic analysis"),
      tr("라이선스·종속성 영향 평가", "License and dependency impact assessment"),
      tr("외부 레퍼런스 → 내부 적용 가능성 보고", "External refs → internal applicability report"),
    ],
  },
  {
    id: "Nimitz",
    role: "Strategic Command & Judgment",
    cli: "Claude Code",
    color: "#d4af37",
    mission: tr(
      "방아쇠를 당기지 않는다. 그러나 어디에 어떻게 당길지를 결정한다. Read-only 전략 사령관.",
      "Never pulls the trigger. But decides where and how it is pulled. Read-only strategic commander."
    ),
    duties: [
      tr("아키텍처 결정 (ADR) — 트레이드오프 및 위험 분석", "Architecture decisions (ADR) — tradeoff and risk analysis"),
      tr("전략 판단 — 대안 비교, 우선순위, 진행 여부", "Strategic judgment — alternative comparison, prioritization, go/no-go"),
      tr("Task Force 합의 — 다중 함장 결과 중재", "Task Force consensus — multi-captain result arbitration"),
      tr("Read-only 모드 — 실행은 위임, 판단만 수행", "Read-only mode — delegates execution, retains judgment only"),
    ],
  },
  {
    id: "Kirov",
    role: "Operational Planning Bridge",
    cli: "Claude Code",
    color: "#e8a854",
    mission: tr(
      "전략을 작전 명령서로 옮긴다. .fleet/plans/*.md — 모든 다단 작전의 단일 진실원.",
      "Translates strategy into operational orders. .fleet/plans/*.md — the single source of truth for all multi-wave ops."
    ),
    duties: [
      tr("작전 계획서(.fleet/plans/*.md) 작성·갱신", "Operational plan authoring/updating (.fleet/plans/*.md)"),
      tr("Wave 분해 · 의존성 그래프 정의", "Wave decomposition · dependency graph definition"),
      tr("Acceptance criteria · 검증 게이트 명시", "Acceptance criteria · validation gate specification"),
      tr("Ohio 등 실행 함장에 plan_file 전달", "Hands plan_file to execution captains (Ohio, etc.)"),
    ],
  },
  {
    id: "Genesis",
    role: "Chief Engineer",
    cli: "Codex CLI",
    color: "#ff6b6b",
    mission: tr(
      "단일 결정타. 신규 모듈·통합·마이그레이션을 한 번의 항해로 종결한다.",
      "One decisive strike. New modules, integrations, and migrations concluded in a single voyage."
    ),
    duties: [
      tr("단일 함정 구현 — 새 기능, 모듈, 시스템 통합", "Single-vessel implementation — new features, modules, system integration"),
      tr("프레임워크 마이그레이션 · 대규모 리팩터", "Framework migration · large-scale refactoring"),
      tr("빌드 게이트 통과를 책임지는 구현 표준", "Implementation standard: owns build gate passage"),
      tr("패치보다 시스템 — 일관성을 잃을 바엔 다시 짠다", "System over patches — rewrite before losing coherence"),
    ],
  },
  {
    id: "Ohio",
    role: "Multi-Wave Strike Execution",
    cli: "Codex CLI",
    color: "#a78bfa",
    mission: tr(
      "Kirov의 명령서를 받아 파(Wave) 단위로 발사한다. 다단 작전의 실집행 잠수함.",
      "Receives Kirov's orders and fires wave by wave. The execution submarine of multi-phase operations."
    ),
    duties: [
      tr("plan_file 수신 → wave별 순차 실행", "Receives plan_file → sequential wave execution"),
      tr("각 wave 후 빌드·테스트·검증 게이트", "Build/test/validation gate after each wave"),
      tr("롤백 가능 단위로 커밋·체크포인트 유지", "Commits and checkpoints in rollback-safe units"),
      tr("장기 다단 마이그레이션의 1차 실집행자", "Primary executor for long-running multi-phase migrations"),
    ],
  },
  {
    id: "Sentinel",
    role: "The Inquisitor · QA & Security Lead",
    cli: "Codex CLI",
    color: "#fb7185",
    mission: tr(
      "함대의 검열관. 어떤 코드도 그의 의심을 거치지 않고는 실전에 투입되지 않는다.",
      "The fleet's inquisitor. No code enters production without passing through his scrutiny."
    ),
    duties: [
      tr("코드 리뷰 — 시맨틱·성능·테스트 커버리지", "Code review — semantics, performance, test coverage"),
      tr("보안 감사 — OWASP Top 10, 권한 모델, 비밀 관리", "Security audit — OWASP Top 10, permission model, secret management"),
      tr("버그 헌팅 · 침투 테스트 시나리오 작성", "Bug hunting · penetration test scenario authoring"),
      tr("Review Cycle에서 Genesis 결과를 병렬 심문", "Parallel interrogation of Genesis output in Review Cycle"),
    ],
  },
  {
    id: "Chronicle",
    role: "Chief Knowledge Officer",
    cli: "Gemini CLI",
    color: "#3dd5f3",
    mission: tr(
      "함대의 기억. 작전이 끝나기 전 마지막으로 항해일지를 닫는 자.",
      "The fleet's memory. The last to close the logbook before an operation concludes."
    ),
    duties: [
      tr("AGENTS.md · 함장 운영 매뉴얼 유지", "AGENTS.md · captain ops manual maintenance"),
      tr("PR 요약 · 변경 영향 감사 보고", "PR summaries · change impact audit reports"),
      tr("문서 SSOT 동기화 — 코드와 일지의 차이 추적", "Doc SSOT sync — tracking divergence between code and logs"),
      tr("Documentation Update 단계의 단독 책임자", "Sole owner of the Documentation Update phase"),
    ],
  },
];

const PHASES = [
  {
    n: "01",
    name: "Reconnaissance",
    kr: "정찰",
    tag: tr("필수", "Required"),
    required: true,
    desc: tr(
      "모든 작전은 정찰로 시작한다. 임무 목표를 한 문장 북극성으로 고정하고, 알고 있는 것·모르는 것·확인이 필요한 것을 분리한 뒤 Vanguard를 띄운다.",
      "Every operation begins with recon. Lock the mission objective to a single North Star sentence, separate what you know from what you don't, then launch Vanguard."
    ),
    points: [
      { m: "ANCHOR", t: tr("**Mission Objective Anchor** — 임무를 단 한 문장의 북극성으로 환원. 이후 모든 결정의 기준선.", "**Mission Objective Anchor** — Reduce the mission to a single North Star sentence. Baseline for all future decisions.") },
      { m: "AUDIT",  t: tr("**Internal Knowledge Audit** — 함대가 이미 아는 사실을 명시적으로 기술. 추측을 사실로 위장하는 위험 차단.", "**Internal Knowledge Audit** — Explicitly state what the fleet already knows. Blocks assumptions from masquerading as facts.") },
      { m: "GAP",    t: tr("**Knowledge Gap Identification** — Blocking(작전 진행 불가) vs Confirmatory(검증 필요) 두 부류로 분류.", "**Knowledge Gap Identification** — Classify gaps as Blocking (can't proceed) vs Confirmatory (needs verification).") },
      { m: "DEPLOY", t: tr("**Vanguard 분산 정찰** — 서브-스카우트 병렬 파견으로 면적을 빠르게 확보.", "**Vanguard Distributed Recon** — Parallel sub-scouts for rapid area coverage.") },
    ],
  },
  {
    n: "02",
    name: "Architecture Review",
    kr: "아키텍처 리뷰",
    tag: tr("조건부", "Conditional"),
    required: false,
    desc: tr(
      "구조에 손이 닿는 작전이라면, Nimitz가 ADR을 발행하기 전엔 한 줄도 쓰지 않는다. 단순 패치라면 이 단계는 통과한다.",
      "If the operation touches structure, not a single line is written before Nimitz issues the ADR. Simple patches skip this phase."
    ),
    points: [
      { m: "TRIGGER", t: tr("데이터 모델·경계·계약을 건드리는 변경에서만 진입.", "Enter only for changes that touch data models, boundaries, or contracts.") },
      { m: "ADR",     t: tr("Nimitz가 트레이드오프와 대안을 명시한 결정 기록을 작성.", "Nimitz authors the decision record with explicit tradeoffs and alternatives.") },
      { m: "GATE",    t: tr("Architecture sign-off 없이는 다음 단계로 진행 불가.", "Cannot proceed to next phase without Architecture sign-off.") },
    ],
  },
  {
    n: "03",
    name: "Work Plan",
    kr: "작전 계획",
    tag: "Wave",
    required: false,
    desc: tr(
      "Inline plan은 한 함장이 머릿속에 들고 가는 단순 항해. Structured plan은 Kirov가 .fleet/plans/*.md로 발행하는 다단 작전 계획서.",
      "Inline plan is a simple voyage one captain holds in their head. Structured plan is Kirov's multi-wave operational document issued as .fleet/plans/*.md."
    ),
    points: [
      { m: "INLINE",     t: tr("**Inline** — 단일 함장, 단일 wave, 즉시 실행.", "**Inline** — Single captain, single wave, immediate execution.") },
      { m: "STRUCTURED", t: tr("**Structured** — Kirov가 plan_file 발행, Ohio가 수신·실행.", "**Structured** — Kirov issues plan_file, Ohio receives and executes.") },
      { m: "CRITERIA",   t: tr("Acceptance criteria · 빌드 게이트 · 롤백 단위 명시.", "Specify acceptance criteria · build gates · rollback units.") },
    ],
  },
  {
    n: "04",
    name: "Execution",
    kr: "실집행",
    tag: tr("행동", "Action"),
    required: true,
    desc: tr(
      "계획이 잉크에서 강철로 바뀌는 단계. Genesis 또는 Ohio가 실제 변경을 가하고, 각 wave 끝에서 빌드 게이트를 통과한다.",
      "Where plans turn from ink to steel. Genesis or Ohio applies real changes, passing the build gate at the end of each wave."
    ),
    points: [
      { m: "WAVE",  t: tr("Wave 단위 커밋 — 각 wave는 자체적으로 컴파일·테스트 통과.", "Wave-unit commits — each wave compiles and tests on its own.") },
      { m: "GATE",  t: tr("빌드 게이트 강제 — 실패 wave는 다음으로 넘기지 않는다.", "Build gate enforced — a failing wave does not advance.") },
      { m: "TRACE", t: tr("변경 트레이스 보존 — Documentation 단계에서 Chronicle이 회수.", "Change trace preserved — Chronicle retrieves it in the Documentation phase.") },
    ],
  },
  {
    n: "05",
    name: "Refactoring",
    kr: "정리",
    tag: tr("조건부", "Conditional"),
    required: false,
    desc: tr(
      "구현 중 누적된 부채가 임계치를 넘었을 때만 진입. 행동을 바꾸지 않고 구조만 정돈한다.",
      "Enter only when accumulated debt exceeds the threshold. Restructure without changing behavior."
    ),
    points: [
      { m: "SCOPE",    t: tr("동작 보존 변경에 한정 — 새 기능 끼워 넣기 금지.", "Limited to behavior-preserving changes — no new features allowed.") },
      { m: "BOUNDARY", t: tr("리팩터링과 기능 변경은 동일 wave에 섞지 않는다.", "Refactoring and feature changes are never mixed in the same wave.") },
    ],
  },
  {
    n: "06",
    name: "Review Cycle",
    kr: "심문 단계",
    tag: tr("병렬", "Parallel"),
    required: true,
    desc: tr(
      "Sentinel가 두 줄기로 동시에 검열한다. Code Review와 Security Review가 병렬로 진행되며, 양쪽 모두의 통과 도장 없이는 작전이 닫히지 않는다.",
      "Sentinel runs two streams simultaneously. Code Review and Security Review proceed in parallel — both stamps required before the operation closes."
    ),
    points: [
      { m: "CODE",     t: tr("**Code Review** — 시맨틱·성능·테스트 커버리지·가독성.", "**Code Review** — semantics, performance, test coverage, readability.") },
      { m: "SECURITY", t: tr("**Security Review** — OWASP Top 10·권한·비밀·공급망.", "**Security Review** — OWASP Top 10, permissions, secrets, supply chain.") },
      { m: "PARALLEL", t: tr("두 리뷰는 병렬 — 차단된 줄기는 즉시 Genesis로 반려.", "Both reviews run in parallel — a blocked stream is immediately sent back to Genesis.") },
    ],
  },
  {
    n: "07",
    name: "Documentation Update",
    kr: "항해일지 갱신",
    tag: tr("필수", "Required"),
    required: true,
    desc: tr(
      "Chronicle이 마지막으로 일지를 닫는다. 코드와 문서의 진실원이 어긋나면 작전은 미완료다.",
      "Chronicle closes the logbook last. If code and docs diverge, the operation is incomplete."
    ),
    points: [
      { m: "PR",     t: tr("PR 요약 — Why·What·Risk·Rollback 4축 보고서.", "PR summary — 4-axis report: Why · What · Risk · Rollback.") },
      { m: "AGENTS", t: tr("AGENTS.md — 새로 도입된 함장 운영 규칙 반영.", "AGENTS.md — reflect newly introduced captain operation rules.") },
      { m: "AUDIT",  t: tr("변경 영향 감사 — 외부 계약과 내부 가정의 충돌 확인.", "Change impact audit — verify conflicts between external contracts and internal assumptions.") },
    ],
  },
];

const ORDERS = [
  {
    name: "Delegation Policy",
    kr: tr("위임 정책", "Delegation Policy"),
    desc: tr(
      "제독은 결정한다. 함장은 실행한다. 호스트는 판단을 유지하고 행동은 가장 적합한 CLI 백엔드에 위임한다.",
      "The Admiral decides. Captains execute. The host retains judgment and delegates action to the most suitable CLI backend."
    ),
  },
  {
    name: "Deep Dive",
    kr: tr("딥 다이브", "Deep Dive"),
    desc: tr(
      "추측이 발견되는 즉시 자동 검증을 띄운다. 동일 가정에 대해 최대 2회까지 재검증, 그래도 불확실하면 Admiral에게 회부.",
      "Triggers automatic verification the moment an assumption is detected. Re-verifies the same assumption up to twice; escalates to Admiral if still uncertain."
    ),
  },
  {
    name: "Result Integrity",
    kr: tr("결과 무결성", "Result Integrity"),
    desc: tr(
      "함장이 가져온 결과는 관련성·완결성·내부 충돌 3축으로 검사된다. 어느 하나라도 어긋나면 자동 재시도.",
      "Captain results are checked on 3 axes: relevance, completeness, and internal consistency. Any failure triggers automatic retry."
    ),
  },
];

const DIFFS = [
  {
    n: "01",
    name: "Multi-CLI Orchestration",
    kr: tr("멀티-CLI 오케스트레이션", "Multi-CLI Orchestration"),
    body: tr(
      "단일 인터페이스 아래 6개의 CLI 백엔드 — Claude Code 라인 3종, Codex, Gemini, OpenCode Go — 가 함께 실행된다. 모델별 강점을 작전 단위로 골라 쓴다.",
      "6 CLI backends run together under a single interface — 3 Claude Code variants, Codex, Gemini, OpenCode Go. Each model's strengths are selected per operation."
    ),
  },
  {
    n: "02",
    name: "Naval Metaphor as Contract",
    kr: tr("운영 가능한 해군 메타포", "Naval Metaphor as Contract"),
    body: tr(
      "장식이 아니다. 8명 함장은 각자 서로 겹치지 않는 책임 영역을 가진 운영 계약이다. Vanguard에게 ADR을 시키지 않고, Nimitz에게 코드를 쓰게 하지 않는다.",
      "Not decoration. 8 captains each hold non-overlapping operational contracts. Vanguard is never asked for ADRs. Nimitz never writes code."
    ),
  },
  {
    n: "03",
    name: "Task Force & Squadron",
    kr: "Wave",
    body: tr(
      "Task Force는 여러 백엔드의 결과를 합의 알고리즘으로 통합. Squadron은 동일 작전을 병렬 분기로 동시에 시도하고 가장 우수한 줄기를 채택한다.",
      "Task Force integrates results from multiple backends via consensus algorithm. Squadron runs the same operation on parallel branches simultaneously and adopts the superior output."
    ),
  },
  {
    n: "04",
    name: "Architectural Discipline",
    kr: tr("아키텍처 규율", "Architectural Discipline"),
    body: tr(
      "빌드 게이트는 협상 불가. SSOT(.fleet/plans/*.md, AGENTS.md, ADR)는 강제 동기화. 각 wave는 그 자체로 컴파일·테스트를 통과해야 다음으로 진행한다.",
      "Build gates are non-negotiable. SSOT (.fleet/plans/*.md, AGENTS.md, ADR) is enforced synchronization. Each wave must compile and test on its own before advancing."
    ),
  },
];

const COMPARES = [
  {
    cat: tr("단일 LLM", "Single LLM"),
    name: "Claude Code · Cursor · Aider",
    bullets: [
      tr("1 모델 ↔ 1 컨텍스트", "1 model ↔ 1 context"),
      tr("사용자가 역할 분리", "User manually separates roles"),
      tr("수동 컨텍스트 전환", "Manual context switching"),
    ],
    verdict: tr("한 명의 천재. 그러나 함장이 아니라 일등 항해사다.", "One genius. But a first mate, not a captain."),
  },
  {
    cat: tr("멀티 에이전트 프레임", "Multi-Agent Framework"),
    name: "AutoGen · CrewAI · LangGraph",
    bullets: [
      tr("역할 정의 자유도 높음", "High role definition flexibility"),
      tr("그래프·메시지 기반", "Graph and message-based"),
      tr("프레임워크 학습 비용", "Framework learning overhead"),
    ],
    verdict: tr("설계도는 강하다. 하지만 실제 함정은 직접 띄워야 한다.", "Strong blueprints. But you still have to build your own ships."),
  },
  {
    cat: tr("컨테이너 격리형", "Containerized"),
    name: "OpenHands · Devin",
    bullets: [
      tr("가상 환경에서 자율 실행", "Autonomous execution in virtual environment"),
      tr("엔드-투-엔드 지향", "End-to-end oriented"),
      tr("백엔드 모델 단일/제한", "Single or limited backend models"),
    ],
    verdict: tr("강력한 단일 함정. 함대는 아니다.", "A powerful single vessel. Not a fleet."),
  },
  {
    cat: "fleet-harness",
    name: "Fleet Action Protocol",
    us: true,
    bullets: [
      tr("6 CLI 백엔드 동시 지휘", "6 CLI backends, simultaneous command"),
      tr("8 함장 명시적 책임 분리", "8 captains with explicit role separation"),
      tr("7-단계 작전 프로토콜", "7-phase operation protocol"),
    ],
    verdict: tr("처음부터 함대로 설계되었다.", "Designed as a fleet from day one."),
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
        <nav className="nav-links" aria-label="Primary">
          <a href="#hierarchy">{tr("지휘 체계", "Chain of Command")}</a>
          <a href="#captains">{tr("8 함장", "8 Captains")}</a>
          <a href="#protocol">{tr("7 단계", "7 Phases")}</a>
          <a href="#diffs">{tr("차별점", "Differentiators")}</a>
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

  return (
    <section className="hero section" id="top">
      <div className="shell">
        <div className="hero-grid">
          <div>
            <div className="hero-eyebrow">
              <span className="pulse" aria-hidden="true"></span>
              <span className="eyebrow">Fleet Action Protocol · v1</span>
            </div>
            <h1 className="hero-title">
              {tr("단일 인터페이스에서", "Command the entire fleet")}<br/>
              {tr("함대 전체를 지휘하라.", "from a single interface.")}
            </h1>
            <p className="hero-desc">
              {tr(
                <>fleet-harness는 pi-coding-agent 기반의 멀티-LLM 오케스트레이션 하네스입니다. 사용자는 <em style={{color:"var(--brass-bright)", fontStyle:"italic"}}>대원수</em>로서 임무를 부여하고, 호스트인 <em style={{color:"var(--brass-bright)", fontStyle:"italic"}}>제독</em>이 8명의 <em style={{color:"var(--brass-bright)", fontStyle:"italic"}}>함장</em>에게 책임을 위임해 작전을 종결합니다.</>,
                <>fleet-harness is a multi-LLM orchestration harness built on pi-coding-agent. As the <em style={{color:"var(--brass-bright)", fontStyle:"italic"}}>Admiral of the Navy</em>, you issue missions. The host <em style={{color:"var(--brass-bright)", fontStyle:"italic"}}>Admiral</em> delegates to 8 <em style={{color:"var(--brass-bright)", fontStyle:"italic"}}>Captains</em> to close each operation.</>
              )}
            </p>
            <div className="hero-actions">
              <a className="btn-primary" href="https://github.com/sbluemin/fleet-harness.git" target="_blank" rel="noreferrer">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.7.5.5 5.7.5 12c0 5 3.3 9.3 7.8 10.8.6.1.8-.3.8-.6v-2.1c-3.2.7-3.9-1.5-3.9-1.5-.5-1.4-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.8-1.6-2.6-.3-5.4-1.3-5.4-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.2 1.2.9-.3 1.9-.4 2.9-.4s2 .1 2.9.4c2.2-1.5 3.2-1.2 3.2-1.2.6 1.7.2 2.9.1 3.2.7.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.4 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6 4.5-1.5 7.8-5.8 7.8-10.8C23.5 5.7 18.3.5 12 .5z" /></svg>
                {tr("저장소 살펴보기", "Browse Repository")}
              </a>
              <a className="btn-secondary" href="#captains">{tr("함장 명단 보기", "See Captain Roster")}</a>
            </div>
            <div className="hero-meta">
              <div className="hero-meta-item">
                <div className="label">CLI Backends</div>
                <div className="value"><em>6</em> · Anthropic / OpenAI / Google / OSS</div>
              </div>
              <div className="hero-meta-item">
                <div className="label">Captains</div>
                <div className="value"><em>8</em> · {tr("명시적 책임 분리", "explicit role separation")}</div>
              </div>
              <div className="hero-meta-item">
                <div className="label">Protocol</div>
                <div className="value"><em>7</em> · Reconnaissance → Documentation</div>
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
                <div className="name">제독<br/>HOST</div>
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
          <span className="eyebrow">Chain of Command</span>
          <div className="divider"></div>
          <h2 className="section-title">{tr("3-단 지휘 체계", "3-Tier Chain of Command")}</h2>
          <p className="lede">{tr("사용자는 코드를 쓰지 않는다. 결정한다. 함대는 그 결정을 작전으로 환원한다.", "The user writes no code. They decide. The fleet converts that decision into operations.")}</p>
        </div>
        <div className="hierarchy">
          {HIERARCHY.map((t, i) => (
            <div className="tier" key={t.role}>
              <div className="tier-rank">{t.rank}</div>
              <div className="tier-role">{t.role}</div>
              <div className="tier-en">{t.en}</div>
              <div className="tier-desc">{t.desc}</div>
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
  return (
    <section className="section" id="backends">
      <div className="shell">
        <div className="section-head">
          <span className="eyebrow">CLI Backends · 06</span>
          <div className="divider"></div>
          <h2 className="section-title">
            {tr("여섯 개의 CLI,", "Six CLIs,")}<br/>
            {tr("한 명의 제독.", "one Admiral.")}
          </h2>
          <p className="lede">{tr("한 모델로 모든 작전을 수행하지 않는다. 각 백엔드는 자신이 가장 잘하는 항해를 맡는다.", "No single model handles every operation. Each backend takes the voyage it does best.")}</p>
        </div>
        <div className="cli-grid">
          {CLI_BACKENDS.map(c => (
            <div className="cli" key={c.name} style={{ "--cli-color": c.color }}>
              <div className="cli-head">
                <span className="cli-num">No. {c.num}</span>
                <span className="cli-vendor">{c.vendor}</span>
              </div>
              <div className="cli-name">{c.name}</div>
              <div className="cli-tag">{c.tag}</div>
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
  return (
    <section className="section" id="captains">
      <div className="shell">
        <div className="section-head">
          <span className="eyebrow">Captains Roster · 08</span>
          <div className="divider"></div>
          <h2 className="section-title">
            {tr("여덟 명의 함장,", "Eight captains,")}<br/>
            {tr("겹치지 않는 여덟 개의 책임.", "eight non-overlapping responsibilities.")}
          </h2>
          <p className="lede">{tr("함장은 장식이 아닌 운영 계약이다. 좌측에서 함장을 선택하면 임무 강령과 책임 명세가 펼쳐진다.", "Captains are operational contracts, not decoration. Select a captain on the left to reveal their mission brief and responsibility spec.")}</p>
        </div>
        <div className="captains-wrap">
          <div className="captain-list" role="tablist" aria-label={tr("함장 명단", "Captain Roster")}>
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
                  <span className="captain-list-role">{cap.role}</span>
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
                  <div className="captain-id"><span>Captain</span> · {c.id.toUpperCase()}</div>
                  <h3 className="captain-name">{c.id}</h3>
                  <div className="captain-role">{c.role}</div>
                </div>
                <div className="captain-cli-badge">
                  <span className="ind" aria-hidden="true"></span>
                  {c.cli}
                </div>
              </div>
              <div className="captain-body">
                <div className="captain-mission">"{c.mission}"</div>
                <div>
                  <div className="captain-resp-title">Responsibilities</div>
                  <ul className="captain-resp-list">
                    {c.duties.map((d, i) => <li key={i}>{d}</li>)}
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

// ───── Protocol (7 phases) ─────
function Protocol() {
  const [active, setActive] = useState(0);
  const p = PHASES[active];
  return (
    <section className="section" id="protocol">
      <div className="shell">
        <div className="section-head">
          <span className="eyebrow">Fleet Action Protocol · 07</span>
          <div className="divider"></div>
          <h2 className="section-title">
            {tr("하나의 작전,", "One operation,")}<br/>
            {tr("일곱 단계의 항해.", "seven phases of voyage.")}
          </h2>
          <p className="lede">{tr("정찰에서 시작해 항해일지로 닫는다. 어떤 임무도 이 골격을 벗어나지 않는다.", "Begins with recon, closes with the logbook. No mission escapes this framework.")}</p>
        </div>
        <div className="phases-wrap">
          <div className="phase-rail" role="tablist" aria-label={tr("Fleet Action Protocol 단계", "Fleet Action Protocol Phases")}>
            {PHASES.map((ph, i) => (
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
                  <span className="phase-step-tag">· {ph.tag}{LANG === 'ko' ? ` · ${ph.kr}` : ''}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="phase-detail" key={p.n}>
            <div style={{animation: "codex-pop 320ms var(--ease-spring) both"}}>
              <div className="phase-detail-num" aria-hidden="true">{p.n}</div>
              <div className="phase-detail-eyebrow">
                <span>Phase {p.n}</span>
                <span style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: p.required ? "var(--coral)" : "var(--aurora)",
                  boxShadow: `0 0 8px ${p.required ? "var(--coral)" : "var(--aurora)"}`,
                }}></span>
                <span style={{color: p.required ? "var(--coral)" : "var(--aurora)"}}>{p.tag}</span>
              </div>
              <h3 className="phase-detail-title">{p.name}{LANG === 'ko' && <span style={{color:"var(--ink-fog)", fontWeight:300}}> · {p.kr}</span>}</h3>
              <p className="phase-detail-desc">{p.desc}</p>
              <div className="phase-detail-points">
                {p.points.map((pt, i) => (
                  <div className="phase-detail-point" key={i}>
                    <span className="pt-marker">{pt.m}</span>
                    <span dangerouslySetInnerHTML={{__html: pt.t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}}></span>
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
  return (
    <section className="section" id="orders">
      <div className="shell">
        <div className="section-head">
          <span className="eyebrow">Standing Orders · Always Active</span>
          <div className="divider"></div>
          <h2 className="section-title">
            {tr("항상 켜져 있는", "Three orders,")}<br/>
            {tr("세 개의 명령.", "always active.")}
          </h2>
          <p className="lede">{tr("단계에 종속되지 않고 모든 작전 위에 상시 작동하는 호스트 차원의 안전 장치.", "Host-level safeguards that operate above all phases, independent of any stage.")}</p>
        </div>
        <div className="orders-grid">
          {ORDERS.map(o => (
            <div className="order" key={o.name}>
              <div className="order-glow" aria-hidden="true"></div>
              <div className="order-status">
                <span className="live" aria-hidden="true"></span> Active
              </div>
              <div className="order-name">
                {o.name}
                <span>· {o.kr}</span>
              </div>
              <div className="order-desc">{o.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ───── Differentiators ─────
function Diffs() {
  return (
    <section className="section" id="diffs">
      <div className="shell">
        <div className="section-head">
          <span className="eyebrow">What sets it apart · 04</span>
          <div className="divider"></div>
          <h2 className="section-title">
            {tr("왜 또 하나의", "Why this is not")}<br/>
            {tr("에이전트 프레임워크가 아닌가.", "just another agent framework.")}
          </h2>
        </div>
        <div className="diff-list">
          {DIFFS.map(d => (
            <div className="diff-row" key={d.n}>
              <div className="diff-num">{d.n}</div>
              <div className="diff-name">
                <span>{d.kr}</span>
                {d.name}
              </div>
              <div className="diff-body">{d.body}</div>
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
          <span className="eyebrow">Landscape</span>
          <div className="divider"></div>
          <h2 className="section-title">{tr("에이전트 지형도 위에서.", "On the agent landscape.")}</h2>
          <p className="lede">{tr("비슷한 도구는 많다. 그러나 처음부터 함대로 설계된 도구는 드물다.", "Many similar tools exist. But few were designed as a fleet from the start.")}</p>
        </div>
        <div className="compare-grid">
          {COMPARES.map(c => (
            <div className={"compare-col " + (c.us ? "us" : "")} key={c.cat}>
              <div className="compare-cat">{c.cat}</div>
              <div className="compare-name">{c.name}</div>
              <ul className="compare-list">
                {c.bullets.map((b, i) => <li key={i}>{b}</li>)}
              </ul>
              <div className="compare-verdict">{c.verdict}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ───── Closer ─────
function Closer() {
  return (
    <section className="closer" id="install">
      <div className="shell">
        <div className="closer-card">
          <div className="closer-eyebrow">Mission Brief · Ready</div>
          <h2 className="closer-title">
            {tr("함대는", "The fleet")}<br/>
            {tr("당신의 명령을 기다린다.", "awaits your command.")}
          </h2>
          <p className="closer-sub">
            {tr(
              "저장소를 살펴보고, 첫 임무를 부여하라. 정찰부터 항해일지까지, 함대가 알아서 끝낸다.",
              "Browse the repository, issue your first mission. From recon to logbook, the fleet handles the rest."
            )}
          </p>
          <div className="code-block" style={{textAlign:"left", maxWidth: 540, margin: "0 auto 36px"}}>
            <span className="cm"># clone the harness</span><br/>
            <span className="pr">$</span> git clone <span className="ar">https://github.com/sbluemin/fleet-harness.git</span><br/>
            <span className="pr">$</span> cd fleet-harness<br/>
            <span className="pr">$</span> fleet <span className="cm"># Set sail on your first mission, Admiral.</span>
          </div>
          <div className="closer-actions">
            <a className="btn-primary" href="https://github.com/sbluemin/fleet-harness.git" target="_blank" rel="noreferrer">
              {tr("GitHub에서 보기", "View on GitHub")}
            </a>
            <a className="btn-secondary" href="https://github.com/badlogic/pi-mono" target="_blank" rel="noreferrer">
              pi-coding-agent
            </a>
          </div>
        </div>
        <div className="footer">
          <div>fleet-harness · Fleet Action Protocol v1</div>
          <div className="footer-meta">
            <span>built on pi-coding-agent</span>
            <span>· 6 CLI · 8 Captains · 7 Phases</span>
          </div>
        </div>
      </div>
    </section>
  );
}

// ───── App ─────
function App() {
  useEffect(() => {
    document.documentElement.lang = LANG;
    document.title = tr('fleet-harness — 함대를 지휘하라', 'fleet-harness — Command the Fleet');
  }, []);

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
