import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

// ─── types ───────────────────────────────────────────────────────────────────

interface SkillsPanelProps {
  readonly ctx: RailPanelContext;
}

// ─── SkillsPanel ─────────────────────────────────────────────────────────────

function SkillsPanel({ ctx: _ctx }: SkillsPanelProps) {
  return (
    <div className="skills-root skills-placeholder">
      <p className="skills-placeholder-text">Skills panel — W2 implementation pending.</p>
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
        fill="none"
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
