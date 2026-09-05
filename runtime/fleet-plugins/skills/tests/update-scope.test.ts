import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { getT } from "../client/i18n/index.js";
import { InstalledTab } from "../client/installed-tab.js";
import { resetSkillsStateForTest, resetProjectContextState, setInstalledState, setScope, skillsContextKey } from "../client/skills-store.js";

const job = vi.hoisted(() => ({ status: "running", lines: [], start: vi.fn(), reset: vi.fn() }));
vi.mock("../client/use-job-log.js", () => ({ useJobLog: () => job }));

describe("다른 범위의 업데이트 중복 실행", () => {
  it.each(["project", "global"] as const)("작업 중이면 %s 범위에서도 업데이트를 비활성화한다", (scope) => {
    resetSkillsStateForTest();
    const context = skillsContextKey("owned-theater");
    resetProjectContextState(context);
    setInstalledState(context, [{ name: "review", scope, agents: ["claude-code"], displayPath: "" }], false);
    setScope(scope);
    job.status = "running";
    const html = renderToStaticMarkup(createElement(InstalledTab, {
      theaterId: "owned-theater", onReadMore: () => {}, t: getT("en"), language: "en",
    }));
    const shelf = html.match(/<div class="skills-scope-shelf">(.*?)<\/div>/)?.[1];
    expect(shelf).toMatch(/<button[^>]*disabled=""/);
  });
});
