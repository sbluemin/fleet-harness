---
id: "prd-infra-durable-store-primitive-source"
created: "2026-06-02T15:51:43.029Z"
sourceType: "inline"
title: "prd-infra-durable-store-primitive"
tags: ["prd", "fleet-infra", "durable-io", "primitive", "architecture", "decision-history", "cognitive-debt"]
contentHash: "9c23c940"
---
Fleet의 durable-I/O 기계장치(원자쓰기 temp+rename+fsync, 디렉터리 락, 보안 파일모드)를 fleet-infra가 소유하는 단일 재사용 primitive로 통합하고, preset·auth·fleet-carriers store·fleet-wiki store가 이를 주입받아 소비하도록 정한 아키텍처 결정. 기각된 대안: preset을 fleet-carriers로 이동시키는 방안은 I/O 구현을 더 흩뿌려 산개를 심화하므로 반대 방향(단일 primitive 소유)으로 결정.