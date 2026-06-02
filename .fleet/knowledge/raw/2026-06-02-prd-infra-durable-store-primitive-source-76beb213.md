---
id: "prd-infra-durable-store-primitive-source"
created: "2026-06-02T16:19:35.816Z"
sourceType: "inline"
title: "prd-infra-durable-store-primitive-v2"
tags: ["prd", "fleet-infra", "durable-io", "primitive", "architecture", "decision-history", "cognitive-debt"]
contentHash: "76beb213"
---
fleet-wiki를 범위에서 제외하는 후속 결정 반영. fleet-wiki는 자체 도그마상 다른 워크스페이스 패키지 의존을 금지하므로 fs-store primitive를 소비하지 않고 자체 async 원자쓰기를 유지한다.