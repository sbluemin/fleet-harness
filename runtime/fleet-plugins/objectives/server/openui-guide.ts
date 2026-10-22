/**
 * 사령관·지휘관이 말풍선에 작은 UI를 그리는 법 — Console 이 `openui-lang` 펜스를 그리는 것은 이 두 화자의 말뿐이다.
 *
 * 사령관은 시스템 프롬프트(`# Record`)에, 지휘관은 계획·개시 턴 프롬프트 끝에 이 문면을 싣는다. 구성원에게는 싣지 않는다.
 * 컴포넌트 이름·인자는 Console 렌더러(`@fleet-console/markdown` 의 OpenUI 라이브러리)와 같아야 한다 — 어긋나면 그 블록은
 * 코드 블록으로 남는다(안전한 실패). 프롬프트 증가분을 작게 두려고 업스트림이 생성하는 전체 문법 설명 대신 시그니처만 싣는다.
 */
export const OPENUI_GUIDE = `# Visual blocks
- Add at most one fenced \`openui-lang\` block to a reply, and only when it carries what prose would make hard to scan: three or more parallel items (objectives, checks, metrics), a timed flow, a before/after, or a choice you are waiting on the person to make. For a single status, a short answer or a plan the board already shows, write prose without a block.
- The block holds the detail. Around it write only the conclusion and what the person must do, in one to three sentences that stand on their own (elsewhere the block stays code); do not also list the block's items or options in prose. Keep a card to two or three kinds of children.
- One statement per line, \`root = Card(...)\` first, positional arguments, double-quoted strings. Only these render:
  Card(title, children: (Stats | Steps | Bars | Table | Facts | Callout | Progress | Choices | Timeline | Compare | Tags | Sparklines | Button | Form)[])   // at most 8 children
  Stats(items: Stat[]); Stat(label, value, note?, tone?: "good" | "warn" | "bad")
  Steps(items: Step[]); Step(label, state: "todo" | "running" | "waiting" | "done" | "blocked", note?)
  Bars(labels: string[], values: number[], unit?)
  Table(columns: string[], rows: string[][])
  Facts(items: Fact[]); Fact(label, value, tone?)   // up to 8 details such as PR, commit, branch, check result
  Callout(text, tone?)   // one sentence to stand out; no tone = neutral
  Progress(label, done: number, total: number, note?)   // e.g. missions 3 of 5; 0 <= done <= total, total > 0
  Timeline(items: Moment[]); Moment(time, label, state?, note?)   // up to 12 timed events in order; time is short text such as "14:02"
  Compare(before, after, items: Delta[]); Delta(label, before, after, tone?)   // up to 8 rows; before/after name the two columns
  Tags(items: Tag[]); Tag(label, tone?)   // up to 12 labels, each <= 32 chars
  Sparklines(items: Sparkline[]); Sparkline(label, values: number[], unit?)   // up to 4 trends of 2-32 points, oldest first
  Button(label, action?)   // @OpenUrl("https://example.com/path" | "objective:<lowercase UUID>" | "mission:<1-999>") or @ToAssistant("message"); https URLs must be canonical, no credentials/port, lowercase domain host (bare host ends in /)
  Choices(items: Choice[]); Choice(label, reply, why?, effect?)   // one Choices or Form per card; 2-4 items; label <= 40 chars; reply, why, effect: one line; reply <= 200 chars not starting with / or @; why/effect <= 120 chars
  Form(fields: (Input | Select)[], template, submit); Input(name, label); Select(name, label, options: string[])   // 1-4 fields with unique names matching [a-z][a-z0-9_]{0,15}; template <= 160 chars uses every field as {name}, may start with {name}, never / or @; Select has 2-6 distinct options; never ask for secrets
- Optional prose (note, why, effect) may be omitted, null or blank; use null to skip other optional arguments, not an empty enum/action.
- A Choice, a Form or a @ToAssistant Button sends its text as the person's message when clicked; an @OpenUrl Button opens its target. Offer them only when your turn ends waiting on the person's answer, never for a step you may take yourself.`;
