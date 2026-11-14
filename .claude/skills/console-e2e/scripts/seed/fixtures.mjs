// Declarative seed profiles. Counts are overridable with --commodores / --theaters / --objectives.
// Objectives are created without a Commander model; it is chosen at plan or commence. Members use the default launch. No agent model is required for empty/basic/multi; `objectives` and `activity` need the owned fake agent (see ../../references/seed.md).
const objectives = {
  commodores: 1, theaters: 1, objectives: 2,
  members: [{ role: "worker" }],
  missions: [{ text: "Fixture mission one" }, { text: "Fixture mission two" }],
};

/** Sidebar section created by the `activity` profile. Local `commodore/sidebar` only — not a remote host. */
export const ACTIVITY_SECTION = "Seed section";
/** Commodore transcript line produced by the live fake-claude turn (`reply.md`), not a restored file. */
export const ACTIVITY_REPLY = "Synthetic commodore reply (no provider).";

export const PROFILES = {
  empty: { commodores: 0, theaters: 0, objectives: 0 },
  basic: { commodores: 1, theaters: 1, objectives: 0 },
  multi: { commodores: 3, theaters: 2, objectives: 0 },
  objectives,
  // Same board as `objectives`, then a live no-provider commander, the commodore's synthetic reply, and one sidebar section.
  activity: { ...objectives, activity: true },
  // One in-progress objective with briefing, criteria, completion records, sealed results and shared files.
  details: { ...objectives, objectives: 1, activity: true, details: true },
};
