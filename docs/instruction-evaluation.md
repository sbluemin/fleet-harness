# 지침의 대표 작업 평가

[instruction-maintenance.md의 개편 검증](instruction-maintenance.md#개편-검증)에서 2단계 대상으로 판정한 변경을 준비·실행할 때 읽는다. 일반 구현이나 의미를 유지하는 문서 정리에 유료 평가를 요구하는 문서가 아니다. 무료 fixture는 요청 구성·도구 호출 경로·CLI 계측을 확인할 뿐, 실제 모델의 행동이나 개선 효과를 입증하지 않는다.

아래는 추출 트리 cwd에서 **도구를 켠** `claude -p`를 기존 claude.ai OAuth 구독으로 돌리고, 도구 호출 기록으로 선택·권한 판단·종료 행동을 비교하는 6단계 경로다. 스킬 자동 선택·참조 읽기, 브라우저 조작, 여러 세션 사이의 실제 메시징의 성공은 입증하지 않는다. 그런 주장은 별도의 실제 실행 증거가 필요하다. Wiki 승인·생성 계약이나 외부 게시 권한을 대체하지 않는다.

성립하지 않거나 이 Theater에서 실행할 수 없는 경로:
- **구성원 세션으로 PR 브랜치 지침을 재는 경로는 성립하지 않는다.** 구성원 세션은 Theater 루트(메인 체크아웃)의 `CLAUDE.md`를 싣고, launch·`console_launch` 입력에 cwd가 없어 워크트리를 cwd로 띄울 수 없다.
- **도구 없는 `claude -p`(`--tools ''`)는 5단계 끝의 변형 한 단락으로만 둔다.** 선언된 선택만 재고 도구 루프(무의미한 명령 반복 등)는 재지 못한다. 나머지 절차는 이 문서와 같다.

## 1. 비교 조건과 과제 고르기

- 이전/이후 커밋, 변경 경계, 작업 프롬프트, 판독 항목, 고정 모델의 전체 ID·effort, CLI 버전, 도구 허용목록·검색 조건을 정한다. 모델 별칭이나 자동 fallback은 쓰지 않는다.
- 이전 지침에서 틀렸을 만한 선택을 포함한 한두 과제를 봉인 전에 시범 판독한다. 기존 출력이나 문서상 점검으로 준비할 수 있지만 이를 실제 모델 표본으로 세지 않는다. 실제 시범 호출도 유료라면 사전 승인이 필요하다.
- 양쪽 모두 만점일 항목은 효과 판정에서 제외하거나 과제를 다시 고른다. 판별할 항목이 없으면 효과 평가 준비가 끝난 것이 아니다. 안전·승인 경계는 차이를 만들려고 빼지 않고 별도의 보존 항목으로 유지한다. 시범 출력은 본 평가 표본에서 제외한다.
- 각 항목에 관찰할 선택과 실패 조건을 적는다. 판정 단위는 계획이 아니라 **실제 도구 호출 기록**(호출·반환·발화·종료 상태)이다. 점수 합계뿐 아니라 무관한 절차 발동, 필요한 참조 누락, 권한 위반, 검증 누락과 조기 종료를 판독하고, 도구 루프 지표(무의미한 명령의 호출 수와 번호 등)는 별도 칸에 센다.
- 장면과 판독 기준은 실제 환경의 구조와 도구 반환값을 따른다. 장면이 언급하는 것(파일, 증거 디렉터리, 워크트리, 커밋, 도구 목록)은 실행 환경에 실제로 있어야 하고, 도구 반환값이 장면과 어긋나면 지침이 아니라 장면 불일치를 잰다. 장면에서 지어낸 이름·구조를 정답으로 삼으면 지침 문장이 아니라 그 이름의 일치를 잰다. 실제 목표 id·세션 이름·사용자 경로는 가상 값으로 바꾼다.
- 여러 문장을 다루면(이 절차로 아직 실행되지 않았다) 문장마다 그 문장만 격리한 전·후 쌍(임시 브랜치의 문장별 격리 커밋)과 과제·판독 항목을 만든다. 한 쌍으로 묶으면 결합 효과만 보고한다.
- 회차 상한은 `--max-turns`다. 상한에 닿은 회차(`error_max_turns`)의 `num_turns`는 상한+1로 찍히므로 장부는 회차당 상한+1로 계상한다. 4턴 상한에서 4회차가 모두 절단되고 둘은 측정할 행동(보고 시도) 전에 끝났다. 이 상한으로 도구 루프 행동을 재려면 필요한 읽기를 프롬프트에 주는 식으로 과제가 첫 한두 턴에 측정 장면에 닿게 설계한다. 절단 수는 전·후 따로 보고한다.
- `N`은 전·후 합계 회차 수로 정하고 짝수로 한다. 표본 수와 최소 관찰 기간, 비용·턴 상한, 제공자별 과금 풀과 승인 범위를 적는다. 자기 세션의 모델 사용량과 의도적인 평가 호출을 구분한다. 모든 평가에 여섯 회를 강요하지 않는다. 사전 등록 판정 규칙(유지·제거 문턱)은 데이터를 보기 전에 장부에 고정한다.

명령은 `claude --help`로 확인한 2.1.292 기준이다. 다른 버전은 도움말을 저장하고 아래 플래그의 존재·의미를 다시 확인한다. 승인되지 않은 모델 호출로 확인하지 않는다.

```bash
OUT=$(claude --version 2>&1); rc=$?; printf '%s\nrc=%s\n' "$OUT" "$rc"
OUT=$(claude --help 2>&1); rc=$?; printf '%s\nrc=%s\n' "$OUT" "$rc"
```

계획과 승인 요청 전에 유료 경로의 자격증명 원천을 무료로 점검한다. 값은 읽거나 기록하지 않고 존재 여부와 종류만 남긴다. 이 문서의 경로는 `authMethod`가 `claude.ai`인 OAuth 로그인을 쓴다.

```bash
OUT=$(claude auth status 2>&1); rc=$?
printf '%s\nrc=%s\n' "$(printf '%s' "$OUT" | jq -c '{loggedIn, authMethod, apiProvider, subscriptionType}' 2>&1)" "$rc"
for v in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN; do
  if printenv "$v" > /dev/null; then echo "$v: set"; else echo "$v: unset"; fi
done
OUT=$(jq 'has("apiKeyHelper")' "$HOME/.claude/settings.json" 2>&1); rc=$?; printf 'apiKeyHelper=%s rc=%s\n' "$OUT" "$rc"
```

OAuth 로그인은 **실제 `HOME`과 `USER`에서만** 성립한다. `env -i PATH HOME USER`는 `loggedIn:true`이고, `USER`가 없거나 `HOME`·`CLAUDE_CONFIG_DIR`을 임시 경로로 바꾸면 `loggedIn:false`다. 그래서 사용자 상태(`~/.claude/CLAUDE.md`, 메모리, 스킬, 플러그인, 훅, MCP) 혼입을 홈 격리가 아니라 3단계의 플래그로 막고, 5단계에서 실행 후 `~/.claude`를 대조한다. 세션의 `ANTHROPIC_BASE_URL`(Fleet 로컬 게이트웨이)은 호출자 자격증명을 전달할 뿐 키 원천이 아니므로 `env -i`로 전달하지 않는다. `--bare`는 `CLAUDE.md` 자동 탐색을 꺼서 이 평가에 쓸 수 없다.

## 2. 두 버전 추출과 장면 구성

구현 worktree에서 시작한다. `SCRATCHPAD`는 현재 세션의 scratchpad 절대 경로, `E`는 그 아래 실행자 전용 증거 디렉터리다(대응표·회차 원문·장부). 목표의 공유 증거 디렉터리는 모든 구성원이 열 수 있으므로 `E`를 거기에 두지 않는다(6절). `BEFORE`·`AFTER`는 비교할 커밋, `MODEL`은 전체 모델 ID로 지정한다. 예시 값은 사용 승인이 아니다.

명령 블록은 bash 스크립트 파일로 이어 붙여 `bash`로 실행한다(zsh 도구에 붙여 넣으면 `exit`가 셸을 끝낸다). 파일은 따옴표 heredoc(`<<'EOF'`)으로 쓴다. 따옴표 없는 heredoc은 셸이 백틱·`$`를 풀어 편집이 조용히 빠지므로, 봉인 전에 파일 내용을 읽어 변경이 들어갔는지 확인한다. 종료 trap이 `$T`를 지우므로 단계를 나눠 실행하면 같은 스크립트를 다시 돌려 재추출한다.

```bash
REPO=$PWD; BEFORE=<이전-커밋>; AFTER=<이후-커밋>
MODEL=claude-sonnet-4-6; EFFORT=high; MAXTURNS=4
mkdir -p "$E"
T=$(mktemp -d "$SCRATCHPAD/instruction-evaluation.XXXXXX")
trap 'rm -rf -- "$T"' EXIT; trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP
for side in before after; do
  if [ "$side" = before ]; then ref=$BEFORE; else ref=$AFTER; fi
  mkdir -p "$T/$side"
  OUT=$(git -C "$REPO" rev-parse "$ref^{commit}" 2>&1); rc=$?
  printf '%s\n' "$OUT" > "$E/$side.commit"; printf '%s\n' "$rc" > "$E/$side.commit.rc"
  [ "$rc" -eq 0 ] || exit "$rc"
  OUT=$(git -C "$REPO" archive --format=tar -o "$T/$side.tar" "$OUT" 2>&1); rc=$?
  printf '%s\n' "$OUT" > "$E/$side.archive.out"; printf '%s\n' "$rc" > "$E/$side.archive.rc"
  [ "$rc" -eq 0 ] || exit "$rc"
  OUT=$(tar -xf "$T/$side.tar" -C "$T/$side" 2>&1); rc=$?
  printf '%s\n' "$OUT" > "$E/$side.extract.out"; printf '%s\n' "$rc" > "$E/$side.extract.rc"
  [ "$rc" -eq 0 ] || exit "$rc"
done
OUT=$(diff -rq "$T/before" "$T/after" 2>&1); rc=$?
printf '%s\n' "$OUT" > "$E/tree-diff.out"; printf '%s\n' "$rc" > "$E/tree-diff.rc"
```

`diff`의 0은 동일, 1은 차이 발견, 2 이상은 실패다. 파일 수만 세지 말고 모든 차이가 선언한 변경 경계에 속하는지 원문으로 확인한다. archive에는 `.git`·설치된 의존성·미커밋 변경이 없다.

**장면**은 회차마다 같은 절대 경로 `SCENE`(scratchpad 아래, 이름에 before/after/eval/커밋 해시 같은 라벨성 낱말을 넣지 않는다)에 새로 만든다. 양쪽이 같은 경로라 경로로 버전이 드러나지 않는다. 지침이 실리는 위치는 `SCENE` 아래 워크트리 `W`(cwd)이며, 추출 트리를 `W`에 풀되 git 추적 밖(`info/exclude`)에 두어 장면의 커밋 해시가 양쪽에서 같게 한다. `SCENE` 상위 경로의 `CLAUDE.md`·`CLAUDE.local.md`가 섞이지 않는지 확인하고, `--add-dir`로 다른 체크아웃을 추가하지 않는다. 하위 `CLAUDE.md`는 모델이 그 폴더의 파일을 읽을 때 지연 적재되므로(전·후 같은 파일이어도 문맥이 늘어 효과가 희석될 수 있다) 적재 여부를 3단계 fixture에서 확인해 기록한다. 과제의 하위 경로가 지침 적재를 결정하면(하위 `CLAUDE.md` 변경 등) 양쪽 모두 `W` 아래 같은 상대 경로를 cwd로 쓰고 그 경로를 봉인 조건에 적는다. 자동 탐색은 유지한다. `--bare`나 별도 시스템 프롬프트에 지침을 주입하면 실제 세션과 지침의 위치·포장이 달라지므로 이 경로와 동등한 평가가 아니다.

```bash
SCENE=$SCRATCHPAD/scene; M=$SCENE/workspace/<저장소>; W=$SCENE/workspace/<저장소>-worktrees/<장면-브랜치>; SCR=$SCENE/scratch
EV=$SCENE/.fleet/<가상 증거 디렉터리 경로>/shared; STMP=$SCENE/tmp; PKEY=$(printf '%s' "$W" | tr -c 'A-Za-z0-9' '-')
build_scene() {  # $1=before|after — 장면 사실(커밋·파일·증거 디렉터리)은 과제문과 일치해야 한다
  rm -rf -- "$SCENE"; mkdir -p "$M" "$(dirname "$W")" "$SCR" "$EV" "$STMP" || return 1
  export GIT_AUTHOR_NAME=member GIT_AUTHOR_EMAIL=member@example.invalid GIT_COMMITTER_NAME=member GIT_COMMITTER_EMAIL=member@example.invalid GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
  git -C "$M" init -q -b canary && printf 'notes\n' > "$M/NOTES.md" && git -C "$M" add NOTES.md || return 1
  GIT_AUTHOR_DATE='2026-10-01T09:00:00+0900' GIT_COMMITTER_DATE='2026-10-01T09:00:00+0900' git -C "$M" commit -q -m 'chore: base' || return 1
  git -C "$M" worktree add -q -b <장면-브랜치> "$W" || return 1
  tar -xf "$T/$1.tar" -C "$W" || return 1
  ( cd "$W" && ls -A | grep -vE '^(\.git|NOTES\.md)$' | sed 's#^#/#' ) > "$M/.git/info/exclude"
  # 장면의 변경 파일을 만들고 고정 날짜로 커밋, 측정 표 등 추적 밖 파일은 $SCR에 만든다
}
```

## 3. 유료 호출 전 무료 요청 fixture

`CLAUDE_BIN`은 확인한 CLI 실행 파일의 절대 경로다. fixture 전에 4단계에서 봉인할 `task.txt` 초안을 `E`에 먼저 쓰고, `PROMPT`는 그 파일에서 읽는다. 그래야 fixture가 유료 회차와 같은 입력을 확인한다. 다음 함수를 fixture와 실제 회차에서 **그대로** 사용한다.

```bash
CLAUDE_BIN=$(command -v claude)
claude_call() {  # $1=before|after, $2=회차 태그
  build_scene "$1" || return 1
  PROMPT=$(< "$E/task.txt")
  ( cd "$W" && perl -e 'alarm 300; exec @ARGV' sandbox-exec -p "$PROFILE" \
    env -i PATH="/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$CLAUDE_BIN")" USER="$USER" LOGNAME="$LOGNAME" HOME="$HOME" TMPDIR="$STMP" \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 "${ENVX[@]}" \
    "$CLAUDE_BIN" -p "$PROMPT" --model "$MODEL" --effort "$EFFORT" \
    --tools "Bash,Read,Write,Edit,SendMessage,ListAgents" --allowedTools Bash Read Write Edit SendMessage ListAgents \
    --permission-mode dontAsk --disable-slash-commands --setting-sources project --settings '{"disableAllHooks":true}' \
    --strict-mcp-config --mcp-config '{"mcpServers":{}}' --no-chrome --prompt-suggestions false --no-session-persistence \
    --output-format stream-json --verbose --max-turns "$MAXTURNS" \
    < /dev/null > "$E/stream-$2.jsonl" 2> "$E/stderr-$2" )
}
```

- `--tools`는 장면의 도구 줄과 같은 목록으로 제한한다. 기본 도구 집합(23개)에는 `SendMessage`·`ListAgents`·`Workflow`·`Cron*`·`WebFetch` 등이 들어 있다. `--allowedTools`는 권한 확인만 건너뛰게 하며 **트리 밖 쓰기를 막지 못한다**(허가를 모두 열면 트리 밖 쓰기가 성공했다). `dontAsk`에서 허가 없는 쓰기는 트리 안이어도 거부된다. 그래서 OS 샌드박스의 쓰기 제한이 필수다.
- `--setting-sources project`로 프로젝트 `CLAUDE.md` 자동 탐색을 유지하고 사용자·로컬 설정을 제외하며, `--disable-slash-commands`·`--strict-mcp-config`·훅 끄기로 스킬·MCP·훅 혼입을 막는다. `--setting-sources ''`와 `--restricted`는 필요한 자동 지침 문맥을 제외하므로 쓰지 않는다. 프로젝트 설정이 provider·환경·plugin·별도 agent를 활성화하거나 조건을 설명할 수 없으면, 또는 적용된 관리 정책이 조건을 바꾸면 중단하고 기록한다.
- `perl alarm`은 너무 좁은 쓰기 프로파일에서 CLI가 멈출 때의 상한이다.

샌드박스 프로파일은 `W`·장면 저장소의 `.git`·증거 디렉터리 `EV`·측정 파일 폴더 `SCR`·장면 tmp `STMP`·CLI 임시 폴더만 쓰기를 허용하고, 세션 간 통로·`gh`·SSH 자격을 막는다. `PKEY`는 `W` 경로의 영숫자가 아닌 문자를 `-`로 바꾼 값이다. fixture는 네트워크를 loopback으로 제한하고 Keychains를 거부하며, 실호출은 네트워크를 열고 Keychain 접근을 막지 않는다(OAuth 때문).

```bash
NET='(allow network*)'; ENVX=()   # 실호출
# fixture: NET='(deny network*) (allow network-outbound (remote ip "localhost:*")) (allow network-inbound (local ip "localhost:*"))'
#          ENVX=(ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" ANTHROPIC_API_KEY=fixture-not-a-real-key), 프로파일에 Keychains 읽기·쓰기 거부 추가
PROFILE="(version 1) (allow default) $NET (deny file-write*)
(allow file-write* (subpath \"$W\") (subpath \"$M/.git\") (subpath \"$EV\") (subpath \"$SCR\") (subpath \"$STMP\") (subpath \"/dev\") (subpath \"/private/var/folders\")
 (subpath \"$HOME/.claude/projects/$PKEY\") (subpath \"/private/tmp/claude-$(id -u)/$PKEY\") (regex #\"^/private/tmp/claude-[0-9a-z]+-cwd\$\"))
(deny network-outbound (remote unix-socket (subpath \"/private/tmp/cc-socks\")))
(deny file-read* file-write* (subpath \"/private/tmp/cc-socks\"))
(deny process-exec (literal \"/opt/homebrew/bin/gh\"))
(deny file-read* (subpath \"$HOME/.config/gh\") (subpath \"$HOME/.ssh\"))"
```

- 이 프로파일은 쓰기만 좁히고 읽기는 막지 않는다(`allow default`). 실호출은 네트워크도 열려 있어 모델이 장면 밖 사용자 파일(다른 저장소, 다른 세션의 증거, 자격 파일)을 읽고 내보낼 수 있다. 과제가 장면 밖을 가리키지 않게 하고, 매 회차 기록에서 장면 밖 경로를 읽은 호출을 찾아 있으면 안전 중단 조건으로 처리한다. 읽기를 장면으로 좁힌 프로파일은 CLI 실행 파일·라이브러리·OAuth 상태 경로를 fixture로 확인하기 전에는 쓰지 않는다(너무 좁은 프로파일은 CLI를 멈추게 했다).
- Bash 도구는 호출마다 cwd 추적 파일 `/private/tmp/claude-<id>-cwd`를 쓴다. 이 쓰기가 막히면 **모든 Bash 호출이 성공해도 `Exit code 1 … operation not permitted`로 돌아와** 모델이 환경 오류에 반응한다(한 회차가 이 결함으로 무효가 됐다). 위 `regex` 한 줄이 필요하다. 이 결함은 반환 끝에 있었으므로 fixture는 반환 전체를 본다.
- 장면 저장소에는 원격을 두지 않고 `gh`를 장면에서 뺀다. 세션 간 통로를 막은 샌드박스는 도달 불가를 실제로 만드는 이중 장치지만, `claude -p` 자식에는 세션 간 메시징이 애초에 없다. 통로 차단을 풀어도 `SendMessage`는 항상 `{"success":false,"message":"No agent named '…' is reachable.\nUse ListAgents to see everyone you can message."}`, `ListAgents`는 `No reachable agents.`를 돌려준다. 실제 사건의 실패 반환(`ECONNREFUSED … peer session is unreachable`)과 다르고 `ListAgents`를 직접 권유하므로, 보고 실패 뒤의 행동을 재는 과제는 이 차이를 한계로 적는다.

무료 스텁은 loopback에만 바인딩하고 요청 본문을 `E`에 저장하며, 모델 대신 **미리 정한 도구 호출 계획**을 순서대로 돌려준다(모델 출력이 아니다). SSE 응답은 `jq`만으로 만들 수 없어 임시 Python 서버를 쓴다. 스크립트는 추출 트리와 별도 디렉터리에 두고 `python3 -I`로 실행한다. 스텁은 인증 헤더를 보지 않으므로 OAuth 경로는 실호출에서만 확인된다.

```bash
cat > "$T/fixture.py" <<'PY'
import json, pathlib, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
root = pathlib.Path(sys.argv[1]); plan = json.loads(pathlib.Path(sys.argv[2]).read_text()); step = [0]
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        n = len(list(root.glob('request-*.json'))) + 1
        (root / f'request-{n}.json').write_text(json.dumps(body, ensure_ascii=False))
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        ev = [('message_start', {'message': {'id': f'msg_{n}', 'type': 'message', 'role': 'assistant', 'model': body['model'], 'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 1, 'output_tokens': 0}}})]
        if body.get('tools') and step[0] < len(plan):   # 보조 요청이 아니라 주 요청에만 계획된 호출을 돌려준다
            t = plan[step[0]]; step[0] += 1
            ev += [('content_block_start', {'index': 0, 'content_block': {'type': 'tool_use', 'id': f'toolu_fx{n}', 'name': t['name'], 'input': {}}}),
                   ('content_block_delta', {'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(t['input'])}}),
                   ('content_block_stop', {'index': 0}), ('message_delta', {'delta': {'stop_reason': 'tool_use', 'stop_sequence': None}, 'usage': {'output_tokens': 1}})]
        else:
            ev += [('content_block_start', {'index': 0, 'content_block': {'type': 'text', 'text': ''}}), ('content_block_delta', {'index': 0, 'delta': {'type': 'text_delta', 'text': 'fixture-only'}}),
                   ('content_block_stop', {'index': 0}), ('message_delta', {'delta': {'stop_reason': 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': 1}})]
        ev.append(('message_stop', {}))
        for k, d in ev:
            d['type'] = k; self.wfile.write(f'event: {k}\ndata: {json.dumps(d)}\n\n'.encode())
        self.wfile.flush()
    def log_message(self, *a): pass
s = HTTPServer(('127.0.0.1', 0), H); (root / 'port').write_text(str(s.server_port)); s.serve_forever()
PY
mkdir -p "$E/fixture"; python3 -I "$T/fixture.py" "$E/fixture" "$E/plan.json" > "$E/fixture-server.out" 2>&1 &
stub=$!
trap 'kill "$stub" 2>/dev/null; wait "$stub" 2>/dev/null; rm -rf -- "$T"' EXIT
for attempt in 1 2 3 4 5 6 7 8 9 10; do [ -s "$E/fixture/port" ] && break; kill -0 "$stub" 2>/dev/null || exit 1; sleep 0.1; done
[ -s "$E/fixture/port" ] || exit 1
PORT=$(< "$E/fixture/port")   # 위 fixture 값으로 NET·ENVX·PROFILE을 만든 뒤 전·후 각각 claude_call 한다
```

**계획(`plan.json`)은 과제가 쓰는 도구를 모두 최소 한 번 부른다**: 정상 경로(증거 디렉터리 `ls`·Write·Read·Edit, `git log/status`, 측정 표 Read), 기대한 거부(트리 밖 Write·Bash 쓰기, `gh`, `git push`), 보고 도구와 `ListAgents`. 실행한 뒤 **모든 도구 반환**에서 `operation not permitted`·`EPERM`·`Exit code`·`No agent named`·`No reachable`·`does not appear to be a git repository`를 grep해 호출별 표를 만든다. 스텁은 전·후마다 새로 띄워 양쪽이 계획 전체를 처음부터 받게 하고, fixture에 한해 `MAXTURNS`를 계획 호출 수+1로 둔다(실제 회차와 다른 플래그는 이것뿐이다). 표의 행 수가 계획의 호출 수와 같아야 하고(빈 표는 오류 0이 아니다), 정상 경로는 오류 0이며 남는 오류는 기대한 거부·미도달뿐이어야 한다. 기대 밖 오류가 하나라도 있으면 봉인하지 않는다.

```bash
jq -r 'select(.type=="user") | .message.content[]? | select(.type=="tool_result") | [(.is_error // false), (.content | if type=="array" then map(.text?) | join(" ") else . end | gsub("\n"; " | ") | .[0:160])] | @tsv' "$E/stream-fx.jsonl"
```

요청 본문은 검색 가능한 문자열로 펼쳐 본다. 건수는 근거 문장의 완전 일치로 센다.

```bash
OUT=$(jq -r '.. | objects | select(.type? == "text") | .text' "$E/fixture/request-1.json" 2>&1); rc=$?
printf '%s\n' "$OUT" > "$E/request-1.text"; printf '%s\n' "$rc" > "$E/request-1.text.rc"
OUT=$(grep -Fc -- "$TARGET_SENTENCE" "$E/request-1.text" 2>&1); rc=$?
printf '%s\n' "$OUT" > "$E/target-count.out"; printf '%s\n' "$rc" > "$E/target-count.rc"
OUT=$(jq -c '[.tools[].name]' "$E/fixture/request-1.json" 2>&1); rc=$?
printf '%s\n' "$OUT" > "$E/tools.out"; printf '%s\n' "$rc" > "$E/tools.rc"
```

전·후 요청의 텍스트 차이가 대상 줄만인지, 대상 문장이 이전 0건·이후 1건인지(`grep`의 1은 일치 없음이므로 기대한 0건과 실행 실패를 구별해 기록한다), 루트 `CLAUDE.md` 출처가 한 건씩인지, `tools`가 허용목록과 같은지, 스킬 목록과 `Memory Index`가 0건인지, 요청에 이전/이후 커밋 해시가 없는지 확인한다. `# Fleet`는 이 저장소 루트의 고유 제목이며 다른 대상이면 그 대상의 제목으로 바꾼다. 제목 횟수는 전문 일치나 출처를 증명하지 않으므로 `request-1.json`에서 위치와 본문도 읽는다. 하위 `CLAUDE.md`는 초기 요청에 없고 파일을 읽은 뒤의 요청에서 적재되는지 본다. 메모리는 `~/.claude/projects/<PKEY>`가 비어 있음을 전제하며, 있으면 같은 내용을 양쪽에 두고 요청에서 대조한다. loopback 도착은 OS 전체 네트워크 차단을 증명하지 않으므로 외부 주소 연결 프로브(`python3 -I -c 'import socket; s=socket.socket(); s.settimeout(1); print(s.connect_ex(("192.0.2.1",443)))'`가 `1`)를 같은 프로파일로 감싸 확인한다. 프로파일은 감싼 프로세스와 자식에만 적용되며 `sandbox-exec`가 없는 플랫폼에서는 동등한 격리를 확보하거나 실행 전에 멈춘다.

이 fixture는 `--max-turns` 값 외에 `claude_call`의 플래그·환경·문맥을 바꾸지 않는다. 실제 회차와의 요청 구성 차이는 엔드포인트·인증(`ENVX`)과 네트워크·Keychains 규칙뿐이며, 이 무료 실행 보호를 유료 실행의 모델 행동 효과로 해석하지 않는다. 실패한 출력, 없는 계측 값, 기대 밖 오류는 고치고 다시 확인한 뒤 봉인한다.

## 4. 과제·판독 기준 봉인

공통 작업 프롬프트 `task.txt`(실제 경로)와 판독용 `task.reader.txt`(경로를 가상 값으로 통일), 판독 기준 `rubric.md`, 시범 판독 결론·표본 수·최소 관찰 기간·모델·CLI·비용/턴 상한을 적은 `conditions.md`, 시범 판독 `pilot.md`, 장면 구성·실행·판독 렌더 스크립트, 샌드박스 프로파일, 3단계 fixture 결과(호출별 grep 표와 0/1 건수)를 증거 디렉터리에 저장한다. 이전 평가의 과제를 재사용하면 원본 대비 diff 문서(변경 사유, 지시한 변경과 안전상 불가피한 변경의 구분)를 함께 봉인한다. 대응표·회차 원문은 `E`에만 둔다. 3단계의 요청·원문·종료 부호를 확인한 뒤, 본 평가 유료 호출이 아직 0인 상태에서 해시와 시각을 기록한다.

`SEAL`은 위 봉인 대상만 모은 디렉터리다. 판독자가 열 수 있는 곳에 둘 수 있으므로 대응표·회차 원문·장부는 넣지 않는다.

```bash
SEAL=$E/seal; mkdir -p "$SEAL"   # 봉인 대상 파일을 이 아래로 복사한 뒤 해시한다
( cd "$SEAL" && find . -type f ! -name sealed.sha256 ! -name sealed-at.out | sort | xargs shasum -a 256 > sealed.sha256 ); rc=$?
printf '%s\n' "$rc" > "$SEAL/sealed.sha256.rc"; [ "$rc" -eq 0 ] || exit "$rc"
OUT=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>&1); rc=$?
printf '%s\n' "$OUT" > "$SEAL/sealed-at.out"; printf '%s\n' "$rc" > "$SEAL/sealed-at.rc"
```

봉인 뒤 과제·기준을 결과에 맞춰 고치지 않는다. 변경이 필요하면 기존 실행과 분리한 새 평가로 다시 봉인한다. **환경 결함**(과제·기준과 무관한 실행 환경 오류)은 예외로, 환경 파일만 고쳐 다시 봉인하고 diff 문서에 "환경 결함 수정, 과제·기준 불변"으로 남기며 결함이 만든 회차는 표본에서 제외하되 비용은 장부에 남긴다. 본 평가 전에 시행한 유료 시범이 있으면 그 비용을 숨기지 않고 별도 장부에 둔다.

## 5. 승인된 반복 실행과 장부

**실제 모델의 반복 실행은 유료 실행 승인 이후에만 진행한다.** 무료 검증만 맡은 세션은 실제 평가를 시작하지 않는다. 승인은 과금 풀을 이름으로 지정해야 한다(구독 OAuth 풀이면 그 구독). fixture와 실제 회차의 차이는 `ENVX`·네트워크·Keychains 규칙뿐이며, 플래그·나머지 환경·메모리·검색 조건·모델·effort를 바꾸지 않는다. provider나 인증 방식 변경이 필요하면 fixture부터 새로 확인한다. 이 문서의 경로는 자격증명 값을 읽거나 기록하지 않는다. 임시 HOME에서 로그인하지 않는다.

전·후를 번갈아 `N`회 실행한다. 실행 전에 `N`, `TURN_LIMIT`, `COST_LIMIT`을 승인된 합계 회차 수·제공자별 턴 상한·달러 상한으로 지정한다. 회차 시작 전에 `누적 턴 + (MAXTURNS+1) ≤ 제공자별 상한`을 확인하고, 회차마다 장면을 새로 만든 뒤 파일 수준으로 지침 적재를 확인한다(이전 0건·이후 1건이 아니면 호출하지 않는다).

```bash
printf 'number\tside\trc\tsubtype\tturns\tcost_usd\tduration_ms\n' > "$E/ledger.tsv"
i=1
while [ "$i" -le "$N" ]; do
  if [ $((i % 2)) -eq 1 ]; then side=before; else side=after; fi
  # 회차 시작 전에 승인된 턴(빈 값은 상한+1로 계상)·비용 상한을 확인한다
  USED=$(awk -F'\t' -v m="$MAXTURNS" 'NR>1 {s+=($5=="" ? m+1 : $5)} END{print s+0}' "$E/ledger.tsv")
  SPENT=$(awk -F'\t' 'NR>1 {s+=$6} END{print s+0}' "$E/ledger.tsv")
  [ $((USED + MAXTURNS + 1)) -le "$TURN_LIMIT" ] || break
  awk -v s="$SPENT" -v c="$COST_LIMIT" 'BEGIN{exit !(s < c)}' || break
  claude_call "$side" "r$i"; rc=$?
  printf '%s\n' "$rc" > "$E/run-$i.rc"
  RES=$(jq -c 'select(.type=="result")' "$E/stream-r$i.jsonl" | tail -1)
  printf '%s\t%s\t%s\t%s\n' "$i" "$side" "$rc" "$(printf '%s' "$RES" | jq -r '[.subtype, .num_turns, .total_cost_usd, .duration_ms] | @tsv')" >> "$E/ledger.tsv"
  i=$((i + 1))
done
```

- 시작 금지 조건: 누적 + 상한+1이 제공자별 상한 초과 / 요청·출력에 상대 쪽 경로·`before`/`after` 라벨·커밋 해시 노출 / 지침 적재가 기대(이전 0·이후 1)와 다름 / 인프라 실패 2회 연속(인증 실패, `rc≠0`이면서 `error_max_turns`가 아닌 것, 환경 오류) / 안전(실제 세션에 메시지가 전달되거나, 트리·지정 경로 밖에 쓰거나, 장면 밖 사용자 파일을 읽음). `error_max_turns`(`rc=1`, `is_error:true`)는 상한 절단이지 인프라 실패가 아니다. 인프라 실패 회차는 같은 쪽으로 한 번만 대체하며 예비 턴을 장부에 미리 둔다.
- `total_cost_usd`는 제공자의 실제 청구 확정값이 아니다. fixture의 토큰·비용은 합성 응답에서 계산한 숫자이므로 실제 사용량으로 합산하지 않는다. `num_turns`가 없거나 조회가 실패하면 1턴으로 추정하지 않고 상한+1로 계상하며 원문·실패 이유를 남긴다. 실패·재시도·시범·판독 호출도 장부에 따로 기록한다.
- 매 회차 뒤 `~/.claude.json` 해시, `~/.claude` 아래 변경 파일 목록, 임시 프로젝트 키(`~/.claude/projects/<PKEY>`)를 대조해 `E`에 남긴다. 다른 살아 있는 세션도 이 파일들을 쓰므로 변경 자체는 위반이 아니다. 자식이 쓸 수 있는 곳은 프로파일의 쓰기 허용 경로뿐이므로 그 근거(거부된 쓰기 반환 수, 허용 경로 안의 변경)를 함께 적는다. 키 디렉터리는 비어 있을 때만 지운다. 샌드박스 없이 실호출하면 `~/.claude/projects`에 임시 키가 생긴다.
- 최소 관찰 기간도 별도로 확인한다.

**도구 없는 변형**(선언된 선택만 비교): `claude_call`에서 `--tools ''`로 바꾸고 `--allowedTools`·`--max-turns`·샌드박스는 빼며 `--output-format json`으로 받는다. 과제는 "실행하지 말고 계획을 번호 목록으로 설명하라" 형태이고 판정 단위는 계획이다. 인증은 이 문서의 OAuth 경로(실제 `HOME`·`USER`; `--tools ''`로는 실호출 미확인이므로 fixture부터 확인)를 쓰거나, (a) 사람이 승인한 API 키를 `ANTHROPIC_API_KEY`에, `https://api.anthropic.com`을 엔드포인트에 두거나 (b) `claude setup-token`(구독 필요)의 장기 토큰을 `CLAUDE_CODE_OAUTH_TOKEN`으로 `env -i`에 넘긴다. 키는 문서·증거 파일·커밋·셸 이력에 넣지 않고 비밀 입력으로 읽어 셸 변수에만 둔다.

## 6. 번호만 보는 판독과 결과

실행 전 판독자는 과제·기준과 출력 번호만 보도록 정한다. 실행 모델과 다른 계열의 모델을 사용하고, 그 판독 호출도 유료면 별도 승인을 받는다. 각 회차의 `stream-r번호.jsonl`을 판독용 기록으로 렌더하고(호출·반환·발화·종료 상태), 판독 번호는 실행 번호에 제약 없는 균등 무작위 순열로 붙여 대응표를 `E`에 둔다. 실행 순서는 전·후 교대라 실행 번호를 그대로 쓰면 홀짝으로 버전이 드러난다. 순열에 고정점 금지 같은 제약을 걸면 판독 번호마다 전·후일 확률이 달라져 오히려 버전이 새므로(`N=2`면 전부 드러난다) 제약을 걸지 않는다. seed는 시각이 아니라 `/dev/urandom`에서 읽고, 파일은 판독 번호 순서로 만들어 생성 시각이 실행 순서를 드러내지 않게 한다.

```bash
jq -r 'if .type=="assistant" then (.message.content[]? | if .type=="tool_use" then "CALL \(.name) \(.input|tojson)" elif .type=="text" then "SAY: \(.text)" else empty end)
  elif .type=="user" then (.message.content[]? | select(.type=="tool_result") | "    RESULT\(if .is_error then " (error)" else "" end): \(.content | if type=="array" then map(.text?) | join(" ") else . end)")
  elif .type=="result" then "END: \(if .subtype=="success" then "ended by itself" elif .subtype=="error_max_turns" then "cut off by the turn limit" else .subtype end)" else empty end' "$E/stream-r$i.jsonl"
```

렌더 기록에서 마스킹한다(판독용 묶음에서만; 원문은 `E`에 둔다). 8단어 창 비교는 `sed` 한 줄로 판정할 수 없어 짧은 `python3 -I` 스크립트를 쓴다.
- 경로: 장면 루트를 가상 루트로 통일한다(`/Users/dev` 등). 판독용 과제문도 같은 값으로 쓴다.
- 대상 문장을 **8단어 이상 연속** 그대로 인용한 구절은 `[quoted instruction masked]`로 바꾼다(한 줄·코드블록·도구 입력/반환 모두). 의역·요약·짧은 구절은 그대로 둔다. 도구 반환에 지침 파일의 해당 줄이 통째로 나오면 그 줄도 가린다. 마스킹 수와 위치는 실행자 장부에만 둔다.
- 반환의 `ls -la` 소유자·시각처럼 **실행 순서를 드러내는 값**(사용자명, 실행 시각)은 렌더 뒤 훑어 찾아 가린다. 가린 곳은 장부에 적는다.

판독자에게는 `blind/`의 번호별 기록과 과제·기준만 전달한다. 실패 원문·종료 부호는 실행 장부에 남기되 판독 입력과 섞지 않는다. 전·후 순서를 아는 지휘관이나 실행자가 판독까지 대신하지 않는다. 판독 중에는 대응표·`run-*`·`ledger.tsv`·커밋 파일·fixture 원문을 판독 세션이 접근하지 않는 위치에 치운다. 목표의 공유 증거 디렉터리에는 `blind/` 묶음과 상태 파일만 두고, 공유 문서에 옮기는 해시·로그에서는 `E`의 절대 경로 접두를 지운다. 판독 세션은 같은 사용자의 파일을 OS로 막을 수 없으므로 열어 본 파일 목록을 판독 기록에 적게 한다. 네이티브 Read가 도구 브리지로 거부될 수 있어(판독 6라운드 중 3라운드가 브리지 도구 탐색에 쓰였다) 지시에 브리지 도구와 라운드 상한을 미리 적는다. 판독 결과를 확정한 뒤에만 대응표를 다시 열어 전·후로 합친다.

결과에는 경계별 실패, 보존한 안전 항목, 표본 수·실제 관찰 기간, **전·후별 절단(`error_max_turns`) 수와 측정할 행동 전에 끝난 회차 수**, 유료 실행·판독 턴과 비용·시간, 무료 fixture와 문서상 판독, 미실행 영역을 구분한다. 양쪽 만점이거나 사전 등록 문턱 아래의 차이면 차이를 입증하지 못했다고 보고한다. 이 결과는 효과 없음의 입증이 아니다: 작은 `N`과 상한은 문장의 효과와 상한의 영향을 구분하지 못한다. 최소 기간·표본을 채우지 못한 부분을 효과 없음으로 단정하지 않는다. 문맥 감소나 한 번의 녹색 결과만으로 개편 완료를 주장하지 않는다.
