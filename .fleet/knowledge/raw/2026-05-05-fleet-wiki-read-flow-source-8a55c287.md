---
id: "fleet-wiki-read-flow-source"
created: "2026-05-05T09:59:00.098Z"
sourceType: "inline"
title: "Fleet Wiki read flow guide"
tags: ["fleet-wiki", "read-flow", "retrieval", "current"]
contentHash: "8a55c287"
---
Read flow 는 wiki 에서 정보를 꺼내는 비파괴 흐름이다. wiki_orient 로 워크스페이스 전체 지형을 파악하고, wiki_briefing 으로 후보 entry 를 검색하고, wiki_resolve 로 여러 entry 를 묶은 context pack 을 합성하고, wiki_read 로 정밀 본문을 읽는다. 모든 출력은 trust boundary 로 wrap 된다.