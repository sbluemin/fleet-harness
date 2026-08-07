import { mkdtemp, rm, stat, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildAgentSessionGoal, readGoalMarkersFromTranscript } from "../server/agent-api/goal-transcript.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("goal transcript reader", () => {
  it("appends only new markers while returning the accumulated list", async () => {
    const transcriptPath = await createTranscript([
      goalLine({ met: false, sentinel: true, condition: "ship it" }),
    ]);
    const first = await readGoalMarkersFromTranscript(transcriptPath);
    expect(first).toEqual([{ met: false, sentinel: true, condition: "ship it" }]);

    await appendFile(transcriptPath, `${goalLine({ met: false, condition: "ship it" })}\n`);
    const second = await readGoalMarkersFromTranscript(transcriptPath);
    expect(second).toEqual([
      { met: false, sentinel: true, condition: "ship it" },
      { met: false, condition: "ship it" },
    ]);
    expect(second[0]).toBe(first[0]);
  });

  it("returns the cache without re-reading when the file size is unchanged", async () => {
    const original = `${goalLine({ met: false, sentinel: true, condition: "alpha" })}\n`;
    const replacement = original.replace("alpha", "bravo");
    expect(replacement).toHaveLength(original.length);
    const transcriptPath = await createRawTranscript(original);

    const first = await readGoalMarkersFromTranscript(transcriptPath);
    await writeFile(transcriptPath, replacement);
    expect((await stat(transcriptPath)).size).toBe(Buffer.byteLength(original));

    const second = await readGoalMarkersFromTranscript(transcriptPath);
    expect(second).toBe(first);
    expect(second[0]?.condition).toBe("alpha");
  });

  it("resets the cursor and re-reads from the start when the file shrinks", async () => {
    const transcriptPath = await createTranscript([
      goalLine({ met: false, sentinel: true, condition: "old goal" }),
      goalLine({ met: false, condition: "old goal" }),
    ]);
    await readGoalMarkersFromTranscript(transcriptPath);

    await writeFile(transcriptPath, `${goalLine({ met: false, sentinel: true, condition: "new" })}\n`);
    await expect(readGoalMarkersFromTranscript(transcriptPath)).resolves.toEqual([
      { met: false, sentinel: true, condition: "new" },
    ]);
  });

  it("returns an empty list and drops the cache when the file is missing", async () => {
    const transcriptPath = await createTranscript([
      goalLine({ met: false, sentinel: true, condition: "ship it" }),
    ]);
    await readGoalMarkersFromTranscript(transcriptPath);
    await rm(transcriptPath);
    await expect(readGoalMarkersFromTranscript(transcriptPath)).resolves.toEqual([]);

    await writeFile(transcriptPath, `${goalLine({ met: false, sentinel: true, condition: "restored" })}\n`);
    await expect(readGoalMarkersFromTranscript(transcriptPath)).resolves.toEqual([
      { met: false, sentinel: true, condition: "restored" },
    ]);
  });

  it("parses a marker split across two reads exactly once", async () => {
    const line = goalLine({ met: false, sentinel: true, condition: "ship it" });
    const splitAt = Math.floor(line.length / 2);
    const transcriptPath = await createRawTranscript(line.slice(0, splitAt));

    await expect(readGoalMarkersFromTranscript(transcriptPath)).resolves.toEqual([]);
    await appendFile(transcriptPath, `${line.slice(splitAt)}\n`);
    await expect(readGoalMarkersFromTranscript(transcriptPath)).resolves.toEqual([
      { met: false, sentinel: true, condition: "ship it" },
    ]);
  });

  // 첫 스냅샷은 커서가 0에서 출발하므로 파일 전체가 한 번에 담기기 쉽다. 청크 경계가
  // 행과 다중바이트 문자 어디에 떨어져도 마커 수와 내용이 같아야 한다.
  it("reads a transcript larger than one chunk without losing or duplicating markers", async () => {
    const filler = { type: "attachment", attachment: { type: "goal_status", met: false, condition: "한글 채움" } };
    const lines = [goalLine({ met: false, sentinel: true, condition: "한글 목표" })];
    while (Buffer.byteLength(lines.join("\n")) < 700_000) lines.push(JSON.stringify(filler));
    lines.push(goalLine({ met: true, condition: "한글 목표", iterations: 2 }));
    const transcriptPath = await createTranscript(lines);

    const markers = await readGoalMarkersFromTranscript(transcriptPath);

    expect(markers).toHaveLength(lines.length);
    expect(markers[0]).toEqual({ met: false, sentinel: true, condition: "한글 목표" });
    expect(markers.at(-1)).toEqual({ met: true, condition: "한글 목표", iterations: 2 });
    expect(markers.filter((marker) => marker.sentinel === true)).toHaveLength(1);
  });

  it("uses the durable marker baseline to ignore an earlier goal", async () => {
    const transcriptPath = await createTranscript([
      goalLine({ met: false, sentinel: true, condition: "old goal" }),
      goalLine({ met: true, condition: "old goal" }),
    ]);
    const goal = {
      origin: "fleet" as const,
      checkLimit: 8,
      requestedAt: 1,
      markerBaseline: 2,
      condition: "new goal",
    };

    await expect(buildAgentSessionGoal({
      goal,
      transcriptPath,
      turnRunning: false,
      backgroundPending: false,
      sessionLive: true,
      launchCheckLimit: 8,
      clearedBaseline: undefined,
    })).resolves.toMatchObject({ state: "requested", condition: "new goal" });

    await appendFile(transcriptPath, `${goalLine({ met: false, sentinel: true, condition: "new goal" })}\n`);
    await expect(buildAgentSessionGoal({
      goal,
      transcriptPath,
      turnRunning: true,
      backgroundPending: false,
      sessionLive: true,
      launchCheckLimit: 8,
      clearedBaseline: undefined,
    })).resolves.toMatchObject({ state: "active", condition: "new goal" });
  });

  // 읽기 경계가 한글 조건문의 다중바이트 문자를 가르면, 조각을 문자열로 캐싱하는 순간
  // U+FFFD로 굳어 sentinel 대조가 어긋난다 — Fleet 소유 목표가 터미널 소유로 강등된다.
  it("keeps a multibyte condition intact when a read boundary splits it", async () => {
    const line = goalLine({ met: false, sentinel: true, condition: "한글 완료 조건" });
    const bytes = Buffer.from(line, "utf8");
    const splitAt = bytes.indexOf(Buffer.from("한", "utf8")) + 1;
    const transcriptPath = await createRawTranscript("");
    await appendFile(transcriptPath, bytes.subarray(0, splitAt));

    await expect(readGoalMarkersFromTranscript(transcriptPath)).resolves.toEqual([]);
    await appendFile(transcriptPath, Buffer.concat([bytes.subarray(splitAt), Buffer.from("\n", "utf8")]));

    await expect(readGoalMarkersFromTranscript(transcriptPath)).resolves.toEqual([
      { met: false, sentinel: true, condition: "한글 완료 조건" },
    ]);
  });

  // 강제되는 한도는 프로세스가 spawn 때 받은 값이다. 살아 있는 세션에 다른 한도를 골라도
  // 눈금은 실제 cap을 세어야 하고, 고른 값은 예약으로만 말해야 한다.
  it("reports the launch-time cap as the enforced limit and the chosen one as pending", async () => {
    const transcriptPath = await createTranscript([
      goalLine({ met: false, sentinel: true, condition: "ship it" }),
    ]);
    const goal = { origin: "fleet" as const, checkLimit: 3, requestedAt: 1, markerBaseline: 0, condition: "ship it" };

    await expect(buildAgentSessionGoal({
      goal,
      transcriptPath,
      turnRunning: true,
      backgroundPending: false,
      sessionLive: true,
      launchCheckLimit: 8,
      clearedBaseline: undefined,
    })).resolves.toMatchObject({ state: "active", checkLimit: 8, pendingCheckLimit: 3 });

    // 휴면 세션에는 강제 중인 프로세스가 없다 — 다음 재개가 쓸 값이 그대로 한도가 된다.
    const dormant = await buildAgentSessionGoal({
      goal,
      transcriptPath,
      turnRunning: false,
      backgroundPending: false,
      sessionLive: false,
      launchCheckLimit: 8,
      clearedBaseline: undefined,
    });
    expect(dormant).toMatchObject({ checkLimit: 3 });
    expect(dormant).not.toHaveProperty("pendingCheckLimit");
  });

  // sentinel 마커는 트랜스크립트에서 지워지지 않는다. 해제 묘비가 없으면 방금 치운 영수증이
  // 다음 파생에서 곧바로 터미널 소유 목표로 되살아난다.
  it("keeps a dismissed goal dismissed once a cleared baseline is recorded", async () => {
    const transcriptPath = await createTranscript([
      goalLine({ met: false, sentinel: true, condition: "ship it" }),
      goalLine({ met: true, condition: "ship it", iterations: 1 }),
    ]);
    const base = {
      goal: undefined,
      transcriptPath,
      turnRunning: false,
      backgroundPending: false,
      sessionLive: true,
      launchCheckLimit: 8,
    };

    // 묘비가 없으면 기록을 지워도 같은 마커가 다시 목표로 읽힌다.
    await expect(buildAgentSessionGoal({ ...base, clearedBaseline: undefined }))
      .resolves.toMatchObject({ state: "met", origin: "terminal" });

    await expect(buildAgentSessionGoal({ ...base, clearedBaseline: 2 })).resolves.toBeUndefined();

    // 묘비 이후에 터미널에서 새로 건 목표는 다시 보여야 한다 — 묘비는 과거만 덮는다.
    await appendFile(transcriptPath, `${goalLine({ met: false, sentinel: true, condition: "typed later" })}\n`);
    await expect(buildAgentSessionGoal({ ...base, clearedBaseline: 2, turnRunning: true }))
      .resolves.toMatchObject({ state: "active", origin: "terminal" });
  });

  it("drops Fleet ownership when the observed condition is not the one Fleet stored", async () => {
    // 사용자가 터미널에서 직접 `/goal`을 다시 쳐 Fleet이 건 목표를 갈아치운 상황.
    // Fleet이 더 이상 소유하지 않는 문장을 현재 목표라고 보여 주면 안 된다.
    const transcriptPath = await createTranscript([
      goalLine({ met: false, sentinel: true, condition: "typed in the terminal" }),
    ]);

    const goal = await buildAgentSessionGoal({
      goal: { origin: "fleet", checkLimit: 8, requestedAt: 1, markerBaseline: 0, condition: "set from Fleet" },
      transcriptPath,
      turnRunning: true,
      backgroundPending: false,
      sessionLive: true,
      launchCheckLimit: 8,
      clearedBaseline: undefined,
    });

    expect(goal).toMatchObject({ state: "active", origin: "terminal" });
    expect(goal).not.toHaveProperty("condition");
  });
});

async function createTranscript(lines: readonly string[]): Promise<string> {
  return createRawTranscript(`${lines.join("\n")}\n`);
}

async function createRawTranscript(content: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fleet-goal-transcript-"));
  temporaryDirectories.push(directory);
  const transcriptPath = path.join(directory, "transcript.jsonl");
  await writeFile(transcriptPath, content);
  return transcriptPath;
}

function goalLine(attachment: Record<string, unknown>): string {
  return JSON.stringify({ type: "attachment", attachment: { type: "goal_status", ...attachment } });
}
