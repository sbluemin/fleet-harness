import { useCallback, useLayoutEffect, useState } from "react";

import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import type { Scope, SkillListItem } from "../server/types.js";
import { FindTab } from "./find-tab.js";
import { InstalledTab } from "./installed-tab.js";
import { ReadingOverlay } from "./reading-overlay.js";
import "./skills.css";
import {
  hasInstalledStateForContext,
  resetProjectContextState,
  setActiveTab,
  setInstallFormOpenId,
  skillsContextKey,
  useSkillsStore,
} from "./skills-store.js";
import { Toast } from "./toast.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface SkillsPanelProps {
  readonly ctx: RailPanelContext;
}

interface ReadMoreEntry {
  readonly skill: SkillListItem;
  readonly isInstalled: boolean;
  readonly registryId?: string;
}

// ─── SkillsPanel ─────────────────────────────────────────────────────────────

function SkillsPanel({ ctx }: SkillsPanelProps) {
  const contextKey = skillsContextKey(ctx.theaterId);

  return <SkillsPanelBody key={contextKey} ctx={ctx} />;
}

function SkillsPanelBody({ ctx }: SkillsPanelProps) {
  const { theaterId } = ctx;
  const state = useSkillsStore();
  const { activeTab } = state;
  const contextKey = skillsContextKey(ctx.theaterId);
  const [readMoreEntry, setReadMoreEntry] = useState<ReadMoreEntry | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [installedRefreshKey, setInstalledRefreshKey] = useState(0);

  const installedCount = hasInstalledStateForContext(state, contextKey) ? state.installedList.length : 0;

  useLayoutEffect(() => {
    resetProjectContextState(contextKey);
  }, [contextKey]);

  const handleReadMoreInstalled = useCallback((skill: SkillListItem) => {
    setReadMoreEntry({ skill, isInstalled: true });
  }, []);

  const handleReadMoreFind = useCallback((skill: SkillListItem, registryId: string) => {
    setReadMoreEntry({ skill, isInstalled: false, registryId });
  }, []);

  const handleInstallSuccess = useCallback((skillName: string, scope: Scope) => {
    setToastMessage(`Installed ${skillName} to ${scope}`);
    setInstalledRefreshKey((k) => k + 1);
    setActiveTab("installed");
  }, []);

  const handleOverlayInstall = useCallback(() => {
    if (readMoreEntry?.registryId) {
      setInstallFormOpenId(readMoreEntry.registryId);
      setActiveTab("find");
    }
    setReadMoreEntry(null);
  }, [readMoreEntry]);

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
          onReadMore={handleReadMoreInstalled}
          refreshKey={installedRefreshKey}
        />
      ) : (
        <FindTab
          theaterId={theaterId}
          onReadMore={handleReadMoreFind}
          onInstallSuccess={handleInstallSuccess}
        />
      )}

      <Toast message={toastMessage} onDismiss={() => setToastMessage(null)} />

      <ReadingOverlay
        skill={readMoreEntry?.skill ?? null}
        isInstalled={readMoreEntry?.isInstalled ?? false}
        theaterId={theaterId}
        onClose={() => setReadMoreEntry(null)}
        onInstall={handleOverlayInstall}
      />
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
  defaultWidth: 360,
  icon: SkillsIcon,
  render: (ctx: RailPanelContext) => <SkillsPanel ctx={ctx} />,
};
