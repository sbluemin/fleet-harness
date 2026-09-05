import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { getT } from "../client/i18n/index.js";
import { InstallFlow } from "../client/install-flow.js";
import { SkillCard } from "../client/skill-card.js";

const t = getT("en");

describe("Skills A안 표면", () => {
  it("설치 목록의 행 전체가 상세를 여는 단일 버튼이다", () => {
    const html = renderToStaticMarkup(createElement(SkillCard, {
      skill: { name: "review", description: "Review changes", scope: "project", agents: ["claude-code", "codex"], source: "demo/tools", displayPath: "" },
      onReadMore: () => {}, shadowsOtherScope: true, t,
    }));
    expect(html.match(/<button\b/g)).toHaveLength(1);
    expect(html).toContain("Review changes");
    expect(html).toContain("Claude · Codex");
    expect(html).toContain("shadows global");
    expect(html).not.toContain("Remove");
  });

  it("설명이나 출처를 알 수 없으면 만들어서 표시하지 않는다", () => {
    const html = renderToStaticMarkup(createElement(SkillCard, {
      skill: { name: "review", scope: "global", agents: [], displayPath: "" }, onReadMore: () => {}, t,
    }));
    expect(html).not.toContain("skills-card-desc");
    expect(html).not.toContain(">local<");
  });

  it("Theater가 없으면 프로젝트 설치를 비활성화하고 전역을 선택한다", () => {
    const html = renderToStaticMarkup(createElement(InstallFlow, { theaterId: null, onCancel: () => {}, onInstall: () => {}, disabled: false, t }));
    expect(html).toMatch(/type="radio"[^>]*disabled=""[^>]*value="project"/);
    expect(html).toMatch(/type="radio"[^>]*checked=""[^>]*value="global"/);
    expect(html.match(/type="checkbox"/g)).toHaveLength(4);
    expect(html).toContain("Install to Global · 4 agents");
    expect(html.match(/>Cancel<\/button>/g)).toHaveLength(1);
  });

  it("설치 중에는 취소를 암시하지 않고 설정 닫기로 표시한다", () => {
    const html = renderToStaticMarkup(createElement(InstallFlow, { theaterId: "owned", onCancel: () => {}, onInstall: () => {}, disabled: true, t }));
    expect(html).toContain("<fieldset disabled=\"\"");
    expect(html).toContain(">Close</button>");
    expect(html).not.toContain(">Cancel</button>");
  });
});
