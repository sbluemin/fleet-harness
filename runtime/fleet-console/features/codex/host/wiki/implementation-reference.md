# Fleet Wiki 구현 참조

Wiki 도구 동작·저장 형식·스키마를 변경할 때 해당 절을 읽는다. 쓰기·노출 경계는 이 디렉터리의 `CLAUDE.md`가 소유한다.

## Tools

카탈로그는 12개다. carrier에는 briefing·orient·read·resolve 네 pure-read 도구만 노출하고 나머지는 host-only다. history는 삭제된 본문을 볼 수 있으므로 `wiki_edit action=history`도 host-only다.

- `wiki_briefing`: 주제별 엔트리 검색과 context pack 후보. 기본 `enhanced=false`의 결정적 substring 순위를 유지한다. opt-in enhanced는 alias·type·status·freshness·snippet·graph 순위를 더한다.
- `wiki_drydock`: frontmatter·링크·schema·안전·claims·semantic 진단. `fix`는 기존 중복 frontmatter 정리를 명시적으로 요청한다. 폐지된 검토 데이터가 있으면 `legacy_review_data` info 한 건으로 안내한다.
- `wiki_ingest`: raw 근거를 수집하고 곧바로 엔트리를 쓴다. mode는 auto(기본)·create·update이고 auto의 create fallback을 유지한다. 반환은 ok·mode·op·entry_id·target·version·hash·raw_source_ref·history_ref?·warnings다. duplicate_policy는 reject(기본)·append_evidence이며 후자는 동일 raw 정체성의 모순을 warning으로 알리고 기존 본문을 보존한다. 제거된 queue_conflict는 안내 오류를 낸다.
- `wiki_edit`: entry_id 필수, action은 edit(기본)·delete·history·restore다. edit는 metadata 필드와 body_replace의 정확한 문자열을 고치며 changed_fields·body_replacements·version·hash·history_ref를 돌려준다. delete는 reason?과 제거한 raw·남긴 공유 raw·깨진 backlink ID를 반환한다. history는 최신순 최대 50개이며 history_ref가 있으면 그 본문을 retrieval boundary로 감싼다. restore는 history_ref 필수다.
- `wiki_orient`: schema 요약·index catalog·최근 log·drydock 상태·네 가지 trust boundary와 usage_hints. max_tokens는 결정적으로 자른다.
- `wiki_read`: 여러 엔트리의 full·summary·facts·diffable 읽기. include_raw_source·include_related·max_tokens를 지원한다. 모든 본문은 boundary로 감싸며 raw는 trust="untrusted"다.
- `wiki_resolve`: briefing과 read를 조합한 compact JSON 또는 markdown_pack. freshness와 claims provenance를 반영하고 missing_or_uncertain을 보고한다.
- `wiki_compile_source`: 단일 source 또는 source_ref로 여러 페이지를 만든다. preview(기본)는 쓰지 않고 write는 직접 반영한다. 제거된 stage는 오류다. 모든 제안을 같은 lock에서 검증한 뒤 raw를 한 번 쓰며 엔트리별로 적용한다. entries는 entry_id·op·target·summary·version?이며 중간 I/O 실패는 ok:false·이미 쓴 entries·failed:{target,error}로 드러낸다. 여러 페이지 쓰기는 non-transactional이다.
- `wiki_query`: answer는 context_pack·citations만 반환한다. save_answer_page 또는 save_good_answer=true는 queries/나 synthesis/에 직접 쓰고 saved_entry_id·version을 반환한다. 제거된 stage_answer_page는 오류다. claim sidecars는 자동으로 쓰지 않는다.
- `wiki_schema_list`: workspace schema와 template catalog를 읽는다.
- `wiki_schema_read`: schema/wiki-schema.md나 이름을 지정한 template을 읽는다.
- `wiki_schema_create`: 새 custom template을 직접 생성한다. 기존 template은 절대 덮어쓰지 않는다.

## Key Modules

- `write.ts`: knowledge root realpath를 key로 한 단일 write lock Map과 writeEntry·deleteEntry·restoreEntry. 계획·현재본 재읽기·기준 검사·적용·index 재생성·raw 고아 계산을 같은 root lock에서 처리한다. 프로세스 간 보장은 없다. caller별·entry별 lock으로 나누지 않는다.
- `history.ts`: overwritten/deleted snapshot의 생성·검증·최신 목록·읽기. 보관 실패 시 변경을 중단한다.
- `store.ts`: 엔트리·raw 저장과 index.json·wiki/index.md 생성. index가 낡으면 재귀 검색한다. writeWikiEntry는 본문 선두 중복 frontmatter를 제거한다. canonical `[[wiki:id]]` 파싱과 retrieval/raw boundary의 단일 원천이다.
- `paths.ts`: MemoryPaths 해석·초기화와 lexical/realpath containment·symlink 검사. 새 root는 raw·wiki·schema·history만 만든다.
- `workspace-resolver.ts`: 사령관 id → 지식 root 해석과 옛 workspace 위키의 저널 기반 이주(아래 "사령관 지식 위치와 이주").
- `log.ts`: append-only log.md. multiline 값은 escape하므로 사용자 입력이 단일 bullet을 깨지 못한다. 과거 patch/conflict 이벤트는 계속 읽힌다.
- `schema.ts`: schema bootstrap·catalog·읽기·create-only template 검증. 누락 기본 파일을 만든다. a96db4cf 기본값의 SHA-256과 기존 바이트가 일치할 때만 세 기본 문서를 교체하고 `schema default upgraded`를 기록한다. 사용자가 고친 문서는 보존한다.
- `claims.ts`: 선택적 wiki/.claims/{id}.json provenance. resolve는 sidecar가 없으면 summary로 fallback한다.
- `search.ts`: briefing의 선택적 enhanced ranker. 기본 ranker는 briefing.ts의 결정적 substring scorer다.
- `drydock.ts`: 링크·schema·안전·semantic·claim 진단. 레거시 디렉터리는 pending/unresolved metadata만 오류를 건너뛰며 센다. 내용이 손상되어도 정상 읽기·쓰기를 막지 않는다.
- `prompts.ts`: 도구 설명·guidelines·TypeBox schema. workspace schema를 참조한다.

## 쓰기·복구·감사

base_version·base_hash는 선택 인자다. lock 안의 현재본과 다르면 stale 오류를 내며 raw·history·log를 쓰지 않는다. 기준을 생략하면 lock 안의 현재본에 마지막 쓰기가 이긴다. 성공한 변경은 version을 올리고 updated를 갱신한다(touch_updated=false 제외). 엔트리 I/O가 raw 뒤 실패하면 고아 raw가 남을 수 있다.

snapshot은 `history/<entryId>/<compactISO>-<op>-v<version>/`에 기록한다. 같은 이름이 겹치면 -2 등 suffix를 붙인다. history_ref는 knowledge-root 기준 POSIX 상대 경로다.

- entry.md는 이전 파일의 정확한 바이트다. create는 이전 파일이 없으므로 snapshot이 없다.
- meta.json은 schemaVersion:1·entryId·target·op·actor·at·version·hash·reason?·raw:[ref]다. 완성된 snapshot만 목록에 보인다.
- delete는 claims.json(있을 때)과 이번 삭제로 고아가 되는 raw/<원래 상대 경로>도 보관한다. snapshot 완료 뒤에만 entry·claims·비공유 raw를 제거하고 index를 재생성한다. 공유 raw는 남긴다.
- restore는 ref의 형식·entry prefix·symlink·본문 1MiB 상한을 확인한다. 현재본이 있으면 먼저 op=restore snapshot을 남긴다. version은 max(current?.version ?? 0, snapshot.version)+1이다. claims와 raw는 없을 때만 되살리고 같은 경로의 다른 내용은 warning과 함께 보존한다.
- history는 자동 정리하지 않으며 watcher와 drydock은 검사하지 않는다. HTTP는 history 본문을 반환하지 않는다.
- log 이벤트는 entry created·updated·deleted·restored와 source compiled다. actor는 proposer 또는 tool:<name>, Console은 console:codex-reader다. 공통 필드 actor·tool·entry_id·target·version·previous_version·previous_hash·hash·history_ref·raw_source_ref·reason·changed_fields 중 해당 없는 값은 null이다.

Console 삭제는 POST /api/entry/:id/delete의 expectedHash 필수, 선택적 reason ≤256이다. stale hash는 409 entry_changed와 currentHash다. POST /api/entry/:id/restore는 historyRef 필수이며 현재본이 있으면 409 entry_exists다. 두 경로는 기존 admitted loopback → Origin → JSON → body 상한 가드를 그대로 쓴다.

기존 queue/·archive/·conflicts/는 옮기거나 지우거나 자동 적용하지 않는다. 레거시 데이터가 존재해도 정상 엔트리 작업은 이 디렉터리를 열지 않는다.

## 사령관 지식 위치와 이주

- Wiki 위치의 정체성은 사령관 id 하나다. root는 Console 조합이 Codex feature에 주입한 지식 root 포트(`knowledge.root(commodoreId)`) = `<consoleDataDir>/commodore/{uuid}/knowledge`다. Codex는 Theater·cwd를 위치 입력으로 받지 않는다. MCP 도구는 호스트가 실어 준 `context.commodoreId`(Operation 세션은 세션 소속의 사령관, 사령관 세션은 `bindCommodore`)만 쓰고, 없으면 `knowledge_unavailable`이다. 화면 맥락→사령관 대응(`commodoreForContext`)과 발급은 호스트가 한다.
- 옛 위키(`workspaces/<cwd 키>/knowledge`)는 `legacyKnowledgeSources(commodoreId)`가 내는 원본 중 내용이 있는 첫 것 하나만 옮긴다. 이 대응은 이주에만 쓴다. 기동 시 Codex 등록 첫머리의 `migrateAll()`이 모든 사령관을 옮기고, resolve는 프로세스에서 처음 볼 때 같은 절차를 한 번 더 확인한다.
- 디렉터리 lock은 쓰지 않는다. 슬롯 writer는 `console.lock` 소유 프로세스 하나이고 이주는 동기다. 중단 재개는 `<사령관 디렉터리>/knowledge.migration.json` 저널(`prepared`→`committed`→`source-retiring`)이 맡고 커밋점은 rename 한 번이다. EXDEV에서는 `knowledge.migrating-<tx>`로 복사·인벤토리 대조 후 rename하고, 커밋된 사본과 바이트가 같을 때만 원본을 `knowledge.retired-<tx>`로 치운 뒤 지운다.
- 새 root에 이미 내용이 있으면 옛 원본은 건드리지 않고 경고만 남긴다. 원본·대상에 절대·탈출·dangling·디렉터리 링크나 특수 파일이 있으면 아무것도 쓰기 전에 그 사령관을 fail-closed로 막는다. 트리 안 일반 파일을 가리키는 상대 링크는 링크로 옮긴다.
- 프로젝트 안 옛 `.fleet/knowledge/`는 이주하지 않고 표식도 쓰지 않는다. 옛 workspace에 남은 `knowledge.migration.lock`·`knowledge.migrating-*`·`knowledge.migrated.json` 잔재는 읽지도 지우지도 않는다.

## Schema & Documentation

workspace schema는 schema/wiki-schema.md, maintainer 지침은 schema/AGENTS.md다. canonical Wiki 링크는 `[[wiki:id]]`다. wiki/index.md는 ID 순서와 태그별 catalog를 결정적으로 생성한다.

선택적 claims sidecar 형식은 `{entryId, claims:[{id,text,sourceRefs:[{ref,quote,span}],confidence}]}`다. query가 sidecar를 자동 동기화한다고 가정하지 않는다.
