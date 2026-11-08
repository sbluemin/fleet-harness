// Declarative seed profiles. Counts are overridable with --commodores / --theaters / --objectives.
// The commander model comes from the Console's own candidates; members use the default launch. No agent model is required for empty/basic/multi; `objectives` needs the owned fake agent (see ../../references/seed.md).
export const PROFILES = {
  empty: { commodores: 0, theaters: 0, objectives: 0 },
  basic: { commodores: 1, theaters: 1, objectives: 0 },
  multi: { commodores: 3, theaters: 2, objectives: 0 },
  objectives: {
    commodores: 1, theaters: 1, objectives: 2,
    members: [{ role: "worker" }],
    missions: [{ text: "Fixture mission one" }, { text: "Fixture mission two" }],
  },
};
