import { useCallback, useLayoutEffect, useState } from "react";

import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import type { InstalledSkillSearchResult, Scope, SkillListItem } from "../server/types.js";
import { FindTab } from "./find-tab.js";
import { getT } from "./i18n/index.js";
import { InstalledTab } from "./installed-tab.js";
import { ReadingOverlay } from "./reading-overlay.js";
import "./skills.css";
import {
  hasInstalledStateForContext,
  resetProjectContextState,
  setActiveTab,
  setFilterText,
  setInstallFormOpenId,
  setScope,
  skillsContextKey,
  useSkillsStore,
} from "./skills-store.js";
import { activateSkillSearchTarget, consumeSkillSearchTarget, useSkillSearchTarget } from "./search-navigation.js";
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
  const t = getT(ctx.language);
  const state = useSkillsStore();
  const { activeTab } = state;
  const contextKey = skillsContextKey(ctx.theaterId);
  const [readMoreEntry, setReadMoreEntry] = useState<ReadMoreEntry | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [installedRefreshKey, setInstalledRefreshKey] = useState(0);
  const searchTarget = useSkillSearchTarget();

  const installedCount = hasInstalledStateForContext(state, contextKey) ? state.installedList.length : 0;

  useLayoutEffect(() => {
    resetProjectContextState(contextKey);
  }, [contextKey]);

  useLayoutEffect(() => {
    if (!searchTarget || searchTarget.theaterId !== theaterId) return;
    setActiveTab("installed");
    setScope(searchTarget.scope);
    setFilterText("");
  }, [searchTarget, theaterId]);

  useLayoutEffect(() => {
    if (
      !searchTarget
      || searchTarget.theaterId !== theaterId
      || !hasInstalledStateForContext(state, contextKey)
      || state.installedLoading
    ) return;
    const skill = state.installedList.find((candidate) => candidate.name === searchTarget.name && candidate.scope === searchTarget.scope);
    if (!skill) return;
    setReadMoreEntry({ skill, isInstalled: true });
    consumeSkillSearchTarget(searchTarget);
  }, [contextKey, searchTarget, state, theaterId]);

  const handleReadMoreInstalled = useCallback((skill: SkillListItem) => {
    setReadMoreEntry({ skill, isInstalled: true });
  }, []);

  const handleReadMoreFind = useCallback((skill: SkillListItem, registryId: string) => {
    setReadMoreEntry({ skill, isInstalled: false, registryId });
  }, []);

  const handleInstallSuccess = useCallback((skillName: string, scope: Scope) => {
    // en 토스트는 소문자 scope 토큰을 유지하고, ko는 번역된 스코프 라벨을 넣는다.
    const scopeLabel = (ctx.language ?? "en") === "en"
      ? scope
      : t(scope === "project" ? "skills.scope.project" : "skills.scope.global");
    setToastMessage(t("skills.toast.installed", { name: skillName, scope: scopeLabel }));
    setInstalledRefreshKey((k) => k + 1);
    setActiveTab("installed");
  }, [ctx.language, t]);

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
          {t("skills.tab.installed")}{installedCount > 0 ? ` ${installedCount}` : ""}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "find"}
          className={`skills-tab-btn${activeTab === "find" ? " is-active" : ""}`}
          onClick={() => setActiveTab("find")}
        >
          {t("skills.tab.find")}
        </button>
      </div>

      {activeTab === "installed" ? (
        <InstalledTab
          theaterId={theaterId}
          onReadMore={handleReadMoreInstalled}
          refreshKey={installedRefreshKey}
          t={t}
          language={ctx.language}
        />
      ) : (
        <FindTab
          theaterId={theaterId}
          onReadMore={handleReadMoreFind}
          onInstallSuccess={handleInstallSuccess}
          t={t}
        />
      )}

      <Toast message={toastMessage} onDismiss={() => setToastMessage(null)} />

      <ReadingOverlay
        skill={readMoreEntry?.skill ?? null}
        isInstalled={readMoreEntry?.isInstalled ?? false}
        theaterId={theaterId}
        onClose={() => setReadMoreEntry(null)}
        onInstall={handleOverlayInstall}
        t={t}
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
  title: (locale) => getT(locale)("skills.panel.title"),
  defaultWidth: 360,
  icon: SkillsIcon,
  render: (ctx: RailPanelContext) => <SkillsPanel ctx={ctx} />,
  search: async ({ query, theaterId, limit, signal }) => {
    const response = await fetch("/plugins/skills/palette-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theaterId, query, limit }),
      signal,
    });
    if (!response.ok) throw new Error("skills_search_failed");
    const result = await response.json() as InstalledSkillSearchResult;
    return result.skills.map((skill) => ({
      id: `${skill.scope}:${skill.name}`,
      title: skill.name,
      subtitle: skill.scope,
      activate: () => activateSkillSearchTarget(theaterId, skill.name, skill.scope),
    }));
  },
};
