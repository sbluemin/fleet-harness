import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 멘션 전달의 소유권 계약. 세 가지가 한 자리에서 갈리므로 문면으로 못 박는다 — 셋 중 하나만
 * 어긋나도 실패가 조용하다(사용자의 문장이 사라지거나, 바가 잠긴 채 남거나, 도착한 답이 어디에도
 * 서지 못한다).
 */
const flock = readFileSync(resolve(process.cwd(), "client/flock.tsx"), "utf8");
const bubble = readFileSync(resolve(process.cwd(), "client/answer-bubble.tsx"), "utf8");

describe("mention delivery ownership", () => {
  it("refuses a mention to an aide that is still answering", () => {
    // ChatSession.ask는 starting/thinking 단계에서 아무 일도 하지 않고 그냥 돌아온다. 그대로
    // 성공으로 넘기면 컴포저가 초안을 지워 사용자의 문장이 사라진다.
    expect(flock).toMatch(/const phase = sessions\[index\]!\.snapshot\(\)\.state\.phase;/u);
    expect(flock).toMatch(/if \(phase === "starting" \|\| phase === "thinking"\) throw new Error\("destination_busy"\);/u);
  });

  it("does not make the composer wait for the answer", () => {
    // 닫히는 컴포저가 스트림을 소유하면, SSE가 끝내 열리지 않는 회차에서 그 약속이 정착하지 않아
    // 제출 잠금이 영영 풀리지 않는다. 전달의 의미는 "부관이 질문을 맡았다"까지다.
    expect(flock).toMatch(/void sessions\[index\]!\.ask\(text\);/u);
    expect(flock).not.toMatch(/await sessions\[index\]!\.ask\(text\)/u);
  });

  it("keeps one answer slot per aide instead of one for the flock", () => {
    expect(flock).toMatch(/React\.useState<readonly AdmiralId\[\]>\(\[\]\)/u);
    expect(flock).toMatch(/answering\.filter\(\(admiral\) => admiral !== openAdmiral\)\.map\(/u);
  });

  it("releases the mention moor whenever an answer leaves, including on a settings toggle", () => {
    expect(flock).toMatch(/const closeAnswer = React\.useCallback\(\(admiral: AdmiralId\) => \{/u);
    expect(flock).toMatch(/for \(const admiral of current\) if \(!settings\[admiral\]\) releaseMentionMoor\(admiral\);/u);
  });

  it("never releases a moor the user set themselves", () => {
    expect(flock).toMatch(/if \(!current\) mentionMooredRef\.current\.add\(admiral\);/u);
    expect(flock).toMatch(/if \(!mentionMooredRef\.current\.delete\(admiral\)\) return;/u);
    expect(flock).toMatch(/getScuttlebuttSettings\(\)\.stayPut\[admiral\]\.enabled/u);
  });

  it("persists a user stay-put switch and never persists a mention moor", () => {
    expect(flock).toMatch(/writeAideStayPut\(/u);
    const mention = flock.match(/const askFromMention = React\.useCallback\(async \(admiral: AdmiralId, text: string\) => \{[\s\S]*?\}, \[applyMoored, sessions\]\);/u);
    expect(mention?.[0]).toBeTruthy();
    expect(mention?.[0]).not.toMatch(/writeAideStayPut/u);
    const release = flock.match(/const releaseMentionMoor = React\.useCallback\(\(admiral: AdmiralId\) => \{[\s\S]*?\}, \[applyMoored\]\);/u);
    expect(release?.[0]).toBeTruthy();
    expect(release?.[0]).not.toMatch(/writeAideStayPut/u);
  });

  it("returns focus to the aide only when the answer was closed from the keyboard", () => {
    // 마우스로 닫고도 포커스를 되돌리면 :focus-visible 링이 새를 감싼 채 남는다 — 포인터
    // 사용자는 그것을 부른 적이 없어 다른 곳을 눌러야 지워진다.
    expect(bubble).toMatch(/onClick=\{\(event\) => onDismiss\(event\.detail === 0\)\}/u);
    expect(bubble).toMatch(/onDismiss\(true\);/u);
    expect(flock).toMatch(/if \(restoreFocus\) focusAdmiral\(admiral\);/u);
  });

  it("announces the settled answer once instead of every streamed chunk", () => {
    // 보이는 문단이 라이브 영역이면 청크마다 전체가 다시 읽힌다.
    expect(bubble).not.toMatch(/className="scuttlebutt-answer-bubble"[\s\S]{0,200}aria-live/u);
    expect(bubble).toMatch(/className="scuttlebutt-answer-announce" aria-live="polite" aria-atomic="true"/u);
    expect(bubble).toMatch(/\{working \? "" : answer \?\? ""\}/u);
  });
});
