---
id: "guide-001-fleet-harness-overview-source"
created: "2026-05-24T07:56:24.926Z"
sourceType: "inline"
title: "guide-001 Alt+1 residual fix — single immutable protocol"
tags: ["guide", "fleet-harness", "overview", "onboarding", "current"]
contentHash: "1544a6b5"
---
Admiral Protocol 영역이 단일 불변 Fleet Action Protocol로 단일화됨에 따라, 기존에 가지고 있던 'Alt+1로 Fleet Action Protocol을 활성화한다' / 단축키 표 'Alt+1 | Fleet Action Protocol 전환' 두 항목은 사실과 어긋난다. 실제 코드에 Alt+1 protocol switching 핸들러는 존재하지 않으며, Fleet Action은 항상 활성 상태인 컴파일 시간 상수다. 두 항목을 사실에 맞게 정정하고, guide 템플릿이 요구하는 Overview / Related 섹션을 schema-compliant 헤더로 정리한다.