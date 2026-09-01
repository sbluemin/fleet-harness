const EVIDENCE_TOKEN = /\[(e\d+)\]/g;
const EVIDENCE_PROBE = /\[e\d+\]/;
/* 모델이 아티팩트 관례(<cite>eN</cite>)를 채팅 응답에 흘리면 sanitizer가 태그를 벗기거나
   이스케이프해 "e1</cite>" 같은 원문이 그대로 노출된다(2026-09-01 라이브 턴 실측).
   sanitize 뒤의 텍스트 노드에서 그 잔해를 [eN]으로 정규화한 뒤 같은 칩 경로를 태운다.
   "e2e" 같은 일상 토큰은 cite 문맥이 없으면 건드리지 않는다. */
const CITE_RESIDUE = /<cite>\s*(e\d{1,4})\s*<\/cite>|\b(e\d{1,4})\s*<\/cite>|<cite>\s*(e\d{1,4})\b/g;
const CITE_RESIDUE_PROBE = /<\/?cite>/;

const CITE_REFERENCE = /^e\d{1,4}$/;

/* [eN] 인용 토큰을 증거 칩으로 승격한다 — sanitize 이후의 HTML에 정적 버튼만 더하므로
   새 실행 표면이 생기지 않는다(핸들러는 트랜스크립트 위임 클릭이 data 속성으로 받는다).
   코드·링크 안의 토큰은 저작물 본문이므로 건드리지 않는다. */
export function decorateEvidenceHtml(html: string, title: string): string {
  if ((!EVIDENCE_PROBE.test(html) && !CITE_RESIDUE_PROBE.test(html)) || typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  // 온전한 <cite>eN</cite>는 sanitizer(DOMPurify 기본 허용목록)를 통과해 요소로 살아남는다 —
  // 텍스트 워커에는 "eN"만 보이므로, 요소 자체를 같은 칩으로 승격한다.
  for (const cite of Array.from(doc.body.querySelectorAll("cite"))) {
    if (cite.closest("code, pre, a")) continue;
    const reference = cite.textContent?.trim() ?? "";
    if (!CITE_REFERENCE.test(reference)) continue;
    cite.replaceWith(evidenceChip(doc, reference, title));
  }
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (text.parentElement?.closest("code, pre, a")) continue;
    if (CITE_RESIDUE_PROBE.test(text.data)) {
      text.data = text.data.replace(CITE_RESIDUE, (_, full, tail, head) => `[${full ?? tail ?? head}]`);
    }
    if (!EVIDENCE_PROBE.test(text.data)) continue;
    targets.push(text);
  }
  for (const text of targets) {
    const fragment = doc.createDocumentFragment();
    let consumed = 0;
    for (const match of text.data.matchAll(EVIDENCE_TOKEN)) {
      const index = match.index ?? 0;
      if (index > consumed) fragment.append(doc.createTextNode(text.data.slice(consumed, index)));
      fragment.append(evidenceChip(doc, match[1] ?? "", title));
      consumed = index + match[0].length;
    }
    if (consumed < text.data.length) fragment.append(doc.createTextNode(text.data.slice(consumed)));
    text.replaceWith(fragment);
  }
  return doc.body.innerHTML;
}

function evidenceChip(doc: Document, reference: string, title: string): HTMLButtonElement {
  const chip = doc.createElement("button");
  chip.type = "button";
  chip.className = "session-analyst__ev";
  chip.title = title;
  chip.setAttribute("data-analysis-evidence", reference);
  chip.textContent = reference;
  return chip;
}
