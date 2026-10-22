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
  Card(title, children: (Stats | Steps | Bars | Table | Choices)[])
  Stats(items: Stat[]); Stat(label, value, note?, tone?: "good" | "warn" | "bad")
  Steps(items: Step[]); Step(label, state: "todo" | "running" | "waiting" | "done" | "blocked", note?)
  Bars(labels: string[], values: number[], unit?)
  Table(columns: string[], rows: string[][])
  Choices(items: Choice[]); Choice(label, reply)   // one Choices per card with 2-4 items; label <= 40 chars; reply: one line <= 200 chars, not starting with / or @
- A Choice only puts its reply in the person's composer; reply is sent only after the person confirms, as their own words. Offer choices only when you are waiting on the person.`;
