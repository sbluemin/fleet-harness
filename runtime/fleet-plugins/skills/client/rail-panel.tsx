import { useState } from "react";

import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import type { SkillListItem } from "../server/types.js";
import { FindTab } from "./find-tab.js";
import { InstalledTab } from "./installed-tab.js";
import "./skills.css";
import { setActiveTab, useSkillsStore } from "./skills-store.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface SkillsPanelProps {
  readonly ctx: RailPanelContext;
}

// ─── SkillsPanel ─────────────────────────────────────────────────────────────

function SkillsPanel({ ctx }: SkillsPanelProps) {
  const { theaterId } = ctx;
  const { activeTab, installedList } = useSkillsStore();
  const [readMoreSkill, setReadMoreSkill] = useState<SkillListItem | null>(null);

  const installedCount = installedList.length;

  if (!theaterId && activeTab === "installed") {
    // Show empty state with Theater hint — still render tab shell
  }

  return (
    <div className="skills-root">
      <div className="skills-tab-bar" role="tablist" aria-label="Skills panels">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "installed"}
          className={`skills-tab-btn${activeTab === "installed" ? " is-active" : ""}`}
          onClick={() => setActiveTab("installed")}
        >
          Installed{installedCount > 0 ? ` ${installedCount}` : ""}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "find"}
          className={`skills-tab-btn${activeTab === "find" ? " is-active" : ""}`}
          onClick={() => setActiveTab("find")}
        >
          Find
        </button>
      </div>

      {activeTab === "installed" ? (
        <InstalledTab
          theaterId={theaterId}
          onReadMore={setReadMoreSkill}
        />
      ) : (
        <FindTab
          theaterId={theaterId}
          onReadMore={setReadMoreSkill}
        />
      )}

      {/* ReadingOverlay renders here in W3 */}
      {readMoreSkill && (
        <div className="skills-overlay-placeholder" onClick={() => setReadMoreSkill(null)}>
          <div className="skills-overlay-placeholder-inner" onClick={(e) => e.stopPropagation()}>
            <div className="skills-overlay-header">
              <span>{readMoreSkill.name}</span>
              <button type="button" onClick={() => setReadMoreSkill(null)} aria-label="Close">✕</button>
            </div>
            <div className="skills-overlay-body">
              <p className="skills-empty-state">Reading overlay — W3 implementation pending.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── SkillsIcon ──────────────────────────────────────────────────────────────

function SkillsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M9 2L10.854 6.764L16 7.236L12.25 10.764L13.416 16L9 13.25L4.584 16L5.75 10.764L2 7.236L7.146 6.764Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ─── export ──────────────────────────────────────────────────────────────────

export const skillsPanel: RailPanelDescriptor = {
  id: "skills",
  title: "Skills",
  icon: SkillsIcon,
  render: (ctx: RailPanelContext) => <SkillsPanel ctx={ctx} />,
};
