---
id: "prd-fleet-agent-composition-root-consolidation-source"
created: "2026-05-23T12:36:14.913Z"
sourceType: "inline"
title: "PRD: fleet-agent 난집 Composition Root 확립과 module-level singleton 전면 제거"
tags: ["fleet-agent", "dependency-injection", "composition-root", "architecture", "singleton-elimination", "shipped"]
contentHash: "8d7d8d61"
---
PRD: fleet-agent 내부 Composition Root 확립과 module-level singleton 전면 제거

Fleet Wiki history entry documenting the decision to eliminate hidden module-level mutable singletons inside fleet-agent and establish it as a true pure-factory DI Composition Root, closing the gap between the top-level architecture mandate (prd-core-dismantling-di-architecture) and the actual internal implementation inertia within fleet-agent.

Decision context: Nimitz Task Force 2-backend cross-validation, Kirov 4-wave plan, Ohio sequential execution.

Related: prd-core-dismantling-di-architecture, prd-core-infra-extraction, prd-carrier-runtime-migration, prd-infra-agent-executor-migration, prd-carrier-persona-extraction.