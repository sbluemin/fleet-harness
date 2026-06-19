---
id: "guide-008-development-release-workflow-source"
created: "2026-06-19T14:27:24.277Z"
sourceType: "inline"
title: "Guide - 008 Development & Release Workflow"
tags: ["guide", "changelog", "release", "ci", "workflow", "contributing"]
contentHash: "843e9231"
---
Fleet-harness 개발·릴리스 워크플로우 가이드. 브랜치 전략(canary 기반 통합, main 릴리스 채널), PR 워크플로우(Conventional Commits 제목, changelog-fragment 게이트, no-changelog 라벨), .changelog.d/ 조각 SSoT 작성 규칙(frontmatter section, 8개 package tag vocabulary), 릴리스 자동화(stable-release.yml, compile-changelog-fragments.mjs, release-version-update 스킬), 통합 단일 버전 및 publish 전략(fleet-cli/fleet-console 2개 publish, tsup noExternal 번들 흡수, publish helper 불변), @changesets 미사용 원칙을 정리.