/**
 * 사령관·지휘관이 말풍선에 작은 UI를 그리는 법 — Console 이 `openui-lang` 펜스를 그리는 것은 이 두 화자의 말뿐이다.
 *
 * 사령관은 시스템 프롬프트(`# Record`)에, 지휘관은 계획·개시 턴 프롬프트 끝에 이 문면을 싣는다. 구성원에게는 싣지 않는다.
 * 컴포넌트 이름·인자는 Console 렌더러(`@fleet-console/markdown` 의 OpenUI 라이브러리)와 같아야 한다 — 어긋나면 그 블록은
 * 코드 블록으로 남는다(안전한 실패). 프롬프트 증가분을 작게 두려고 업스트림이 생성하는 전체 문법 설명 대신 시그니처만 싣는다.
 */
export const OPENUI_GUIDE = `# Visual blocks
- When a status overview, metrics or a comparison reads better as a small UI, you may add one fenced \`openui-lang\` block to a reply. The Console draws it; elsewhere it stays code, so state its point in a sentence too.
- One statement per line, \`root = Card(...)\` first, positional arguments, double-quoted strings. Only these render:
  Card(title, children: (Stats | Steps | Bars | Table | Facts | Callout | Progress | Choices | Timeline | Compare | Tags | Sparklines | Button | Form)[])
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
  Button(label, action?)   // action: @OpenUrl("https://…" | "objective:<id>" | "mission:<n>") or @ToAssistant("message")
  Choices(items: Choice[]); Choice(label, reply, why?, effect?)   // one Choices or Form per card; 2-4 items; label <= 40 chars; reply, why, effect: one line, reply <= 200 chars not starting with / or @
  Form(fields: (Input | Select)[], template, submit); Input(name, label); Select(name, label, options: string[])   // template like "Merge {pr} now"; never ask for secrets
- A Choice or Form sends its reply as the person's message when the person clicks it. Offer choices only when you are waiting on the person.`;
