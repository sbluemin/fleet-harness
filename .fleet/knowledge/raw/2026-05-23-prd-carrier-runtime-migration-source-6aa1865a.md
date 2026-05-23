---
id: "prd-carrier-runtime-migration-source"
created: "2026-05-23T07:54:10.365Z"
sourceType: "inline"
title: "prd-carrier-runtime-migration frontmatter 중복 제거"
tags: ["carrier", "fleet-carriers", "fleet-core", "fleet-infra", "carrier-runtime", "package-migration", "architecture", "dependency-injection"]
contentHash: "6aa1865a"
---
prd-carrier-runtime-migration 본문 내 중복 YAML frontmatter 제거 — 파일 frontmatter(1~10줄)와 본문 내 YAML 블록(11~28줄)이 이중으로 존재하여, 본문 내 중복 블록을 삭제함.