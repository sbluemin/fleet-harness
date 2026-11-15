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
 * `advanced` profile: one commodore per requested state of the per-commodore advanced options (auto memory, base system prompt,
 * subagents), in order. Values: "on" | "off" | "unset" (no saved override; product defaults apply).
 * - "on"/"off" are requests, not raw keys: the product deletes the key when a value is set back to its default (base prompt on,
 *   subagents off), so an absent key does not mean "never saved".
 * - "unset" needs the offline path (`--offline`, a data dir whose Console has not started). The running-Console routes cannot
 *   produce it, because the product's creation step has already stored auto memory false and base prompt "off" there.
 * The third state is skipped by a running-Console run only when `--commodores 2` is given; otherwise it is refused up front.
 */
export const ADVANCED_STATES = [
  { label: "on", autoMemory: "on", basePrompt: "on", subagents: "on" },
  { label: "off", autoMemory: "off", basePrompt: "off", subagents: "off" },
  { label: "unset", autoMemory: "unset", basePrompt: "unset", subagents: "unset" },
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
  // One commodore per ADVANCED_STATES entry, no theater.
  advanced: { commodores: ADVANCED_STATES.length, theaters: 0, objectives: 0, advanced: true },
  inbox: { commodores: 1, theaters: 1, objectives: 0, inbox: true },
  // Owned-slot taskforce experiment on (other experiment fields kept as read), two commodores, one taskforce. No theater. Needs the owned fake agent (same --fake-claude-dir gate); creation wakes members.
  taskforce: { commodores: 2, theaters: 0, objectives: 0, taskforce: true },
  // Fixed shape: 1 commodore, 1 theater, commenced objectives with synthetic commander and member turns (ledger.mjs). No count overrides.
  ledger: { commodores: 1, theaters: 1, objectives: 0, ledger: true },
};

/** Taskforce fixture. Ids come from the run; do not hardcode a commodore. */
export const TASKFORCE_NAME = "Seed taskforce";
export const TASKFORCE_TOPIC = "Seed topic";
