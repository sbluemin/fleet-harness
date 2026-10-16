/** 카탈로그가 읽기라고 선언한 경로만 관찰 세션에 연다. GET 이라는 이유만으로는 열지 않는다. */
export function isDeclaredObserverRead(entries: readonly { readonly method: string; readonly path: string; readonly readOnly?: boolean }[], method: string, pathname: string): boolean {
  const verb = method === "HEAD" ? "GET" : method;
  return entries.some((entry) => entry.readOnly === true && entry.method === verb && catalogPathMatches(entry.path, pathname));
}

function catalogPathMatches(pattern: string, pathname: string): boolean {
  const left = pattern.split("/");
  const right = pathname.split("/");
  if (left.length !== right.length) return false;
  return left.every((segment, index) => {
    const actual = right[index] ?? "";
    if (segment.startsWith(":")) return actual.length > 0 && !actual.includes("/");
    return segment === actual;
  });
}
