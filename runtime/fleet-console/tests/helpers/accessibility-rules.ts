/**
 * 렌더된 DOM에서 이번에 실제로 출하됐던 접근성 결함 세 가지를 잡는다.
 *
 * 세 가지 모두 코드를 읽어서는 잘 드러나지 않고, 화면을 열어도 눈에는 멀쩡해 보인다 —
 * 보조기술에서만 어긋난다. 그래서 렌더 결과에 대고 검사한다.
 *
 * axe 같은 전면 감사를 대신하지는 않는다. 여기 있는 것은 재발을 막아야 하는 확인된 패턴뿐이다.
 */
const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="switch"]',
].join(",");

export interface AccessibilityViolation {
  readonly rule: "nested-interactive" | "hidden-from-assistive-tech" | "tab-without-panel";
  readonly detail: string;
}

function describe(element: Element): string {
  const role = element.getAttribute("role");
  const label = element.getAttribute("aria-label");
  const className = typeof element.className === "string" ? element.className.split(/\s+/u)[0] : "";
  return [element.tagName.toLowerCase(), role ? `[role=${role}]` : "", className ? `.${className}` : "", label ? ` "${label}"` : ""].join("");
}

export function findAccessibilityViolations(root: ParentNode): readonly AccessibilityViolation[] {
  const violations: AccessibilityViolation[] = [];

  // 1. 활성화 대상이 둘로 갈리는 구조. 보조기술에는 무엇을 누르는 것인지가 모호해지고,
  //    키보드는 부모와 자식 중 어느 쪽이 이벤트를 먹는지에 따라 달라진다.
  for (const outer of root.querySelectorAll(INTERACTIVE_SELECTOR)) {
    for (const inner of outer.querySelectorAll(INTERACTIVE_SELECTOR)) {
      violations.push({
        rule: "nested-interactive",
        detail: `${describe(outer)} contains ${describe(inner)}`,
      });
    }
  }

  // 2. aria-hidden 조상 아래의 대화상자·조작 대상. 시각적으로는 열려 있는데 접근성 트리에는
  //    없다 — 닫기 버튼까지 함께 사라진다.
  for (const element of root.querySelectorAll(`[role="dialog"],${INTERACTIVE_SELECTOR}`)) {
    let ancestor: Element | null = element.parentElement;
    while (ancestor) {
      if (ancestor.getAttribute("aria-hidden") === "true") {
        violations.push({
          rule: "hidden-from-assistive-tech",
          detail: `${describe(element)} sits inside aria-hidden ${describe(ancestor)}`,
        });
        break;
      }
      ancestor = ancestor.parentElement;
    }
  }

  // 3. 선택 상태만 읽어 주고 그 내용과 이어지지 않은 탭.
  for (const tab of root.querySelectorAll('[role="tab"]')) {
    const controls = tab.getAttribute("aria-controls");
    if (!controls) {
      violations.push({ rule: "tab-without-panel", detail: `${describe(tab)} has no aria-controls` });
      continue;
    }
    const owner = tab.ownerDocument ?? (root as Document);
    if (!owner.getElementById(controls)) {
      violations.push({ rule: "tab-without-panel", detail: `${describe(tab)} points at a missing panel #${controls}` });
    }
  }

  return violations;
}

/** 위반을 한 줄씩 적어 assert 실패 메시지로 쓰기 좋게 만든다. */
export function formatAccessibilityViolations(violations: readonly AccessibilityViolation[]): string {
  return violations.map((violation) => `  [${violation.rule}] ${violation.detail}`).join("\n");
}
