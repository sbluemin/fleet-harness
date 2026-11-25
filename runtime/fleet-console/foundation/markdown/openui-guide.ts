/**
 * 사령관·지휘관이 말풍선에 작은 UI를 그리는 법 — Console 이 `openui-lang` 펜스를 그리는 것은 이 두 화자의 말뿐이다.
 *
 * 사령관은 시스템 프롬프트(`# Record`)에, 지휘관은 계획·개시 턴 프롬프트 끝에 이 문면을 싣는다. 구성원에게는 싣지 않는다.
 * 컴포넌트 이름·인자는 같은 패키지의 OpenUI 라이브러리(`openui-library.tsx`)와 같아야 하므로 이 패키지가 문면을 소유한다 — 어긋난 요소는
 * 빠지고(다 빠지면 블록을 숨긴다) 다음 턴 입력으로 모델에게 알린다(openui-feedback). 프롬프트 증가분을 작게 두려고 업스트림이 생성하는 전체 문법 설명 대신 시그니처만 싣는다.
 */
export const OPENUI_GUIDE = `# Visual blocks
- Use at most one fenced \`openui-lang\` block only when clearer than prose for 3+ parallel items, a timed flow, a before/after, or a structured handoff; otherwise use prose, including plans the board already shows.
- Write all titles, labels, badges, notes and button copy in the person's conversation language. Never print raw UUIDs or English-only button labels in non-English replies.
- Keep detail in the block without repeating it outside. Use 2-3 child kinds and 1-3 standalone sentences for the conclusion and required action.
- One statement per line, \`root = Card(...)\` first, positional arguments, double-quoted strings. Only these render:
  Card(title, children[], subtitle?)   // at most 10 children
  EntityCard(target, title?, subtitle?, badge?, tone?); EntityList(items: EntityCard[])   // up to 6 rich links; target is "commodore:<uuid>" | "objective:<uuid>" | "mission:<1-999>" | canonical "https://..."; Console resolves live name, avatar and status automatically
  Actions(items: Button[])   // horizontal row of 1-4 buttons
  Button(label, action?, variant?: "primary" | "draft")   // @OpenUrl(target) or @ToAssistant("message"); variant "draft" fills the person's input box without sending immediately; https URLs canonical, no credentials/port, lowercase domain
  Stats(items: Stat[]); Stat(label, value, note?, tone?: "good" | "warn" | "bad")
  Breakdown(label, segments: Segment[], note?); Segment(label, value: number, tone?: "good" | "warn" | "bad" | "wait")   // 2-6 proportional segments, sum > 0
  Progress(label, done: number, total: number, note?)   // 0 <= done <= total, total > 0
  Steps(items: Step[]); Step(label, state: "todo" | "running" | "waiting" | "done" | "blocked", note?)
  Bars(labels: string[], values: number[], unit?)
  Sparklines(items: Sparkline[]); Sparkline(label, values: number[], unit?, tone?)   // up to 4 trends of 2-32 points, oldest first
  Table(columns: string[], rows: string[][])
  Facts(items: Fact[]); Fact(label, value, tone?, copyable?: boolean)   // up to 8 details; set copyable=true for paths, PRs or commit hashes
  Compare(before, after, items: Delta[]); Delta(label, before, after, tone?)   // up to 8 rows
  Callout(text, tone?, title?)   // concise highlight; no tone = neutral
  Timeline(items: Moment[]); Moment(time, label, state?, note?)   // up to 12 timed events
  Tags(items: Tag[]); Tag(label, tone?)   // up to 12 labels, each <= 32 chars
  Snippet(label, code, kind?: "path" | "command" | "diff" | "code")   // copyable path, command or short diff (<= 16 lines, <= 1200 chars)
  Tabs(items: Tab[]); Tab(label, children[])   // 2-4 tabs, each 1-4 static children (no nested Tabs/Collapsible/Form/Checklist)
  Collapsible(label, children[], open?: boolean)   // expandable detail section, 1-4 static children
  Checklist(items: CheckItem[], template, submit); CheckItem(label, value?, checked?: boolean, note?)   // 2-8 items; template <= 160 chars uses {selected} once, never / or @
  Form(fields: (Input | Select)[], template, submit); Input(name, label, placeholder?); Select(name, label, options: string[])   // one Form per card; 1-4 fields with unique names matching [a-z][a-z0-9_]{0,15}; template <= 160 chars uses every field as {name}, never / or @; never ask for secrets
- Optional prose may be omitted, null or blank; use null to skip other optional arguments, not an empty enum/action.
- Prefer EntityCard for Commodore/Objective/Mission/URL navigation, Actions for multiple buttons, and variant "draft" when the person may want to edit before sending. Offer Form, Checklist or @ToAssistant buttons only when waiting on the person's answer, never for a step you may take yourself.`;
