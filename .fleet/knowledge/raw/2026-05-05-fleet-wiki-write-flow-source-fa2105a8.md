---
id: "fleet-wiki-write-flow-source"
created: "2026-05-05T09:59:12.767Z"
sourceType: "inline"
title: "Fleet Wiki write flow guide"
tags: ["fleet-wiki", "write-flow", "approval-gate", "current"]
contentHash: "fa2105a8"
---
Write flow 는 wiki 에 새 지식을 영구 저장하는 흐름이다. LLM 이 직접 wiki 를 mutate 하지 못하고 모든 변경은 patch queue 를 거쳐 human approval 후 archive 로 이동한다. wiki_ingest 가 단일 entry, wiki_compile_source 가 다중 페이지 patch_set, wiki_patch_queue 가 approve/reject 를 처리한다.