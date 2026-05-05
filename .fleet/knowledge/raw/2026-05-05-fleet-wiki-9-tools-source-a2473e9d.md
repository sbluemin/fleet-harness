---
id: "fleet-wiki-9-tools-source"
created: "2026-05-05T09:58:48.249Z"
sourceType: "inline"
title: "Fleet Wiki 9-tool suite (P0+P1+P2 통합)"
tags: ["fleet-wiki", "tools", "architecture", "current"]
contentHash: "a2473e9d"
---
Fleet Wiki 의 9개 MCP 도구는 read flow / write flow / citation flow / integrity 4개 카테고리로 분류된다. read flow 는 orient → briefing → resolve → read 의 비파괴 검색 흐름이고, write flow 는 ingest → patch_queue approve → archive 의 human approval 흐름이다. citation flow 는 query 를 통한 답변 컨텍스트 추출과 wiki/queries/* 으로의 writeback 을 다룬다. integrity 는 drydock 의 25+ lint code 로 정합성 보장.