import { Fragment, type ReactNode } from "react";

// 번역 문자열의 {name} 자리에 React 노드를 끼워 넣는다. 문자열 조각과 노드를 섞은
// 배열을 반환하므로 <strong> 같은 강조 마크업을 로케일별 문장 구조 안에서 유지할 수 있다.
export function renderMessage(template: string, nodes: Readonly<Record<string, ReactNode>>): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /\{([^{}]+)\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let occurrence = 0;
  while ((match = pattern.exec(template)) !== null) {
    if (match.index > lastIndex) {
      parts.push(template.slice(lastIndex, match.index));
    }
    const name = match[1]!;
    const node = nodes[name];
    if (node !== undefined) {
      parts.push(<Fragment key={`rich:${name}:${occurrence}`}>{node}</Fragment>);
    } else {
      parts.push(match[0]);
    }
    occurrence += 1;
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < template.length) {
    parts.push(template.slice(lastIndex));
  }
  return parts;
}
