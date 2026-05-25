---
id: "prd-admiral-protocol-single-immutable-fleet-action-source"
created: "2026-05-24T07:54:50.816Z"
sourceType: "inline"
title: "PRD body fix — strip duplicated frontmatter"
tags: ["admiral", "protocols", "doctrine", "decision-history", "cognitive-debt"]
contentHash: "8a31833c"
---
초기 ingest 시 Chronicle가 body 안에 frontmatter(`---...---` 블록)를 중복 삽입해 wiki/prd-admiral-protocol-single-immutable-fleet-action.md 디스크 파일에 frontmatter가 두 번 출력됨. wiki_ingest는 envelope frontmatter를 자동 생성하므로 body는 `## Overview`부터 시작해야 함. 본문 내용은 변경하지 않고 body 시작 위치만 정정한다.