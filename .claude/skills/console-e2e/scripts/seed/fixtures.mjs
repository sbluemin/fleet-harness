// Declarative seed profiles. Counts are overridable with --commodores / --theaters / --objectives.
// Objectives are created without a Commander model; it is chosen at plan or commence. Members use the default launch. No agent model is required for empty/basic/multi; `objectives`, `activity` and `inbox` need the owned fake agent (see ../../references/seed.md).
const objectives = {
  commodores: 1, theaters: 1, objectives: 2,
  members: [{ role: "worker" }],
  missions: [{ text: "Fixture mission one" }, { text: "Fixture mission two" }],
};

/** Sidebar section created by the `activity` profile. Local `commodore/sidebar` only — not a remote host. */
export const ACTIVITY_SECTION = "Seed section";
/** Commodore transcript line produced by the live fake-claude turn (`reply.md`), not a restored file. */
export const ACTIVITY_REPLY = "Synthetic commodore reply (no provider).";

/**
 * `advanced` profile: one commodore per state of the per-commodore advanced options, in order. Values: "on" | "off" only.
 * "unset" (a stored key that is absent) is rejected for all three: creation stores auto memory false and base prompt mode "off",
 * and the public routes cannot remove an auto-memory field; base prompt "on" and subagents "off" delete their key, which is the
 * product default but cannot be told apart from never having been saved. The seed will not call that "unset".
 */
export const ADVANCED_STATES = [
  { label: "on", autoMemory: "on", basePrompt: "on", subagents: "on" },
  { label: "off", autoMemory: "off", basePrompt: "off", subagents: "off" },
];

export const PROFILES = {
  empty: { commodores: 0, theaters: 0, objectives: 0 },
  basic: { commodores: 1, theaters: 1, objectives: 0 },
  multi: { commodores: 3, theaters: 2, objectives: 0 },
  objectives,
  // Same board as `objectives`, then a live no-provider commander, the commodore's synthetic reply, and one sidebar section.
  activity: { ...objectives, activity: true },
  // One in-progress objective with briefing, criteria, completion records, sealed results and shared files.
  details: { ...objectives, objectives: 1, activity: true, details: true },
  // Person inbox: one criteria proposal, one review, one open follow-up, one ask. No section, no transcript.
  // Three commodores, no theater: advanced options explicit on and explicit off (see ADVANCED_STATES).
  advanced: { commodores: ADVANCED_STATES.length, theaters: 0, objectives: 0, advanced: true },
  inbox: { commodores: 1, theaters: 1, objectives: 0, inbox: true },
};
