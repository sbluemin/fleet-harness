export function buildValidPlan(): string {
  return `# Objective

Build deterministic Fleet Plan storage and tools.

# File Ownership

- W1-A owns packages/core-infra/src/workspace-dir/**
- W1-B owns packages/fleet-plans/**

# Execution Topology

- Execution mode: Parallel
- Shared mutable resources: none

# Waves

## Wave 1 — Domain foundations

### Lane W1-A — Workspace directory

- Exact write set:
  - packages/core-infra/src/workspace-dir/**
- Read dependencies:
  - packages/core-infra/src/data-dir/**
- Dependency/start condition: Architecture settled
- Eligible concurrent lanes: W1-B
- Integration gate: core-infra tests pass
- Handoff: Public WorkspaceDir export
- Rollback unit: WorkspaceDir source and tests
- Implementation summary:
  - [ ] W1-A-T1 — Implement cwd sanitization
  - [ ] W1-A-T2 — Persist cwd identity
  - [ ] W1-A-T3 — Add cross-platform tests
- Verification/static checks:
  - pnpm --filter @dotobokuri/core-infra test
- Escalation triggers: Workspace identity collision

### Lane W1-B — Plan domain

- Exact write set:
  - packages/fleet-plans/**
- Read dependencies:
  - packages/core-infra/src/workspace-dir/**
- Dependency/start condition: WorkspaceDir API agreed
- Eligible concurrent lanes: W1-A
- Integration gate: fleet-plans tests pass
- Handoff: Plan tool specifications
- Rollback unit: fleet-plans package
- Implementation summary:
  - [ ] W1-B-T1 — Implement PlanRef parsing
  - [ ] W1-B-T2 — Implement deterministic lint
  - [ ] W1-B-T3 — Implement Plan tools
- Verification/static checks:
  - pnpm --filter @dotobokuri/fleet-plans test
- Escalation triggers: Plan schema cannot represent a required contract

# Dispatch Manifest

- Full-plan execution: unavailable; dispatch explicit same-Lane TaskRefs only
- Lane W1-A — exact write set, dependencies, gate, handoff, and rollback from W1-A
- Lane W1-B — exact write set, dependencies, gate, handoff, and rollback from W1-B

# QA Gates

- Each Lane passes its declared tests before task completion is marked.

# Acceptance Criteria

- Plan tools enforce their mutation authority and preserve valid files on lint failure.

# Documentation Updates

- Update host and Carrier Plan workflow documentation.

# Final Review Loop

- Host inspects artifacts, runs Plan verification, and routes findings back to Genesis.
`;
}

export function buildMultiWavePlan(): string {
  return buildValidPlan()
    .replace(
      "- W1-B owns packages/fleet-plans/**",
      "- W1-B owns packages/fleet-plans/**\n- W2-A owns docs/**",
    )
    .replace(
      "\n# Dispatch Manifest\n",
      `
## Wave 2 — Documentation handoff

### Lane W2-A — Workflow documentation

- Exact write set:
  - docs/**
- Read dependencies:
  - packages/fleet-plans/**
- Dependency/start condition: W1-A and W1-B integration gates pass
- Eligible concurrent lanes: none
- Integration gate: documentation checks pass
- Handoff: Published Plan workflow reference
- Rollback unit: workflow documentation
- Implementation summary:
  - [ ] W2-A-T1 — Document the compact execution view
  - [ ] W2-A-T2 — Document one-read dispatch behavior
  - [ ] W2-A-T3 — Verify cross-links
- Verification/static checks:
  - pnpm docs:check
- Escalation triggers: Plan workflow cannot be described without implementation details

# Dispatch Manifest
`,
    )
    .replace(
      "- Lane W1-B — exact write set, dependencies, gate, handoff, and rollback from W1-B",
      "- Lane W1-B — exact write set, dependencies, gate, handoff, and rollback from W1-B\n- Lane W2-A — exact write set, dependencies, gate, handoff, and rollback from W2-A",
    );
}
