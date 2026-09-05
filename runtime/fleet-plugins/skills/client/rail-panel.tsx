import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useJobLog } from "./use-job-log.js";
import { JobStatusDock } from "./skill-feedback.js";
import type { AgentId } from "../server/skill-types.js";

import type { PaneContext, PaneDescriptor } from "@fleet-console/sdk/pane";
import type { RailEntryDescriptor } from "@fleet-console/sdk/rail";

import type { InstalledSkillSearchResult, Scope, SkillListItem } from "../server/skill-types.js";
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
  setScope,
  skillsContextKey,
  useSkillsStore,
} from "./skills-store.js";
import { activateSkillSearchTarget, consumeSkillSearchTarget, useSkillSearchTarget } from "./search-navigation.js";
import { Toast } from "./skill-feedback.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface SkillsPanelProps {
  readonly ctx: PaneContext;
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
  const tabId = useId();
  const tabBarRef = useRef<HTMLDivElement>(null);
  const installLog = useJobLog();
  const [installTarget, setInstallTarget] = useState<{ name: string; scope: Scope } | null>(null);
  const closeOverlay = useCallback(() => setReadMoreEntry(null), []);

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

  useEffect(() => {
    if (installLog.status !== "done" || !installTarget) return;
    handleInstallSuccess(installTarget.name, installTarget.scope);
    setScope(installTarget.scope);
    setInstallTarget(null);
    setReadMoreEntry(null);
  }, [installLog.status, installTarget, handleInstallSuccess]);

  const handleOverlayInstall = useCallback((scope: Scope, agents: AgentId[]) => {
    if (!readMoreEntry || installLog.status === "running") return;
    const skill = readMoreEntry.skill;
    setInstallTarget({ name: skill.name, scope });
    installLog.start("/plugins/skills/install", {
      source: skill.source, skill: skill.name, scope, agents,
      ...(scope === "project" ? { theaterId } : {}),
    });
  }, [readMoreEntry, installLog, theaterId]);

  return (
    <div className="skills-root">
      <div ref={tabBarRef} className="skills-tab-bar" role="tablist" aria-label={t("skills.tab.panelsAria")}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? "installed" : event.key === "End" ? "find" : activeTab === "installed" ? "find" : "installed";
          setActiveTab(next);
          tabBarRef.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next === "installed" ? 0 : 1]?.focus();
        }}>
        <button
          type="button"
          role="tab"
          id={`${tabId}-installed`}
          tabIndex={activeTab === "installed" ? 0 : -1}
          aria-selected={activeTab === "installed"}
          aria-controls={`${tabId}-panel`}
          className={`skills-tab-btn${activeTab === "installed" ? " is-active" : ""}`}
          onClick={() => setActiveTab("installed")}
        >
          {t("skills.tab.installed")}{installedCount > 0 ? ` ${installedCount}` : ""}
        </button>
        <button
          type="button"
          role="tab"
          id={`${tabId}-find`}
          tabIndex={activeTab === "find" ? 0 : -1}
          aria-selected={activeTab === "find"}
          aria-controls={`${tabId}-panel`}
          className={`skills-tab-btn${activeTab === "find" ? " is-active" : ""}`}
          onClick={() => setActiveTab("find")}
        >
          {t("skills.tab.find")}
        </button>
      </div>

      {/* 탭이 선택 상태를 읽어 주어도 그 내용과 이어져 있지 않으면 보조기술은 무엇이 바뀌었는지
          알 수 없다. 두 탭은 같은 자리를 갈아 끼우므로 패널도 하나다. */}
      <div
        role="tabpanel"
        id={`${tabId}-panel`}
        aria-labelledby={`${tabId}-${activeTab}`}
        className="skills-tabpanel"
      >
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
            onReadMore={handleReadMoreFind}
            t={t}
          />
        )}
      </div>

      <Toast message={toastMessage} onDismiss={() => setToastMessage(null)} />

      <JobStatusDock status={installLog.status} lines={installLog.lines}
        runningLabel={t("skills.status.installingNamed", { name: installTarget?.name ?? "" })}
        doneLabel={t("skills.status.installed")} errorLabel={t("skills.status.installFailed")}
        onDismiss={installLog.reset} t={t} />
      {readMoreEntry && <ReadingOverlay
        key={`${readMoreEntry.isInstalled}:${readMoreEntry.skill.scope}:${readMoreEntry.skill.name}`}
        skill={readMoreEntry.skill}
        isInstalled={readMoreEntry.isInstalled}
        theaterId={theaterId}
        onClose={closeOverlay}
        onInstall={handleOverlayInstall}
        installLog={installLog}
        onRemoved={() => {
          setReadMoreEntry((entry) => entry === readMoreEntry ? null : entry);
          setInstalledRefreshKey((key) => key + 1);
        }}
        t={t}
        language={ctx.language}
      />}
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

export const skillsEntry: RailEntryDescriptor = {
  id: "skills",
  title: (locale) => getT(locale)("skills.panel.title"),
  icon: SkillsIcon,
  panes: ["skills"],
};

/**
 * 스킬 목록 한 열. 설치됨/찾기 탭은 같은 자리를 갈아끼우는 내용 전환이라 본문에 남고,
 * 읽기 오버레이는 포커스를 가두는 모달이므로 페인이 아니다 — 360px 열에 720px 시트를
 * 넣을 수 없고, 확대 표면으로 옮기면 비모달이 되어 차단성을 잃는다.
 */
export const skillsPane: PaneDescriptor = {
  id: "skills",
  role: "primary",
  mounts: ["rail"],
  title: (ctx) => getT(ctx.language ?? "en")("skills.panel.title"),
  render: (ctx) => <SkillsPanel ctx={ctx} />,
  defaultWidth: 360,
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
      activate: () => {
        // 호스트 팔레트가 PaneTarget을 소비하기 전까지는 이 싱글턴이 실제 착지를 맡는다.
        activateSkillSearchTarget(theaterId, skill.name, skill.scope);
        return { paneId: "skills", theaterId, params: { skill: skill.name, scope: skill.scope } };
      },
    }));
  },
};
