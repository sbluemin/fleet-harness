# 지침의 대표 작업 평가

[instruction-maintenance.md의 개편 검증](instruction-maintenance.md#개편-검증)에서 2단계 대상으로 판정한 변경을 준비·실행할 때 읽는다. 일반 구현이나 의미를 유지하는 문서 정리에 유료 평가를 요구하는 문서가 아니다. 무료 fixture는 요청 구성과 CLI 계측을 확인할 뿐, 실제 모델의 행동이나 개선 효과를 입증하지 않는다.

아래는 도구 없는 `claude -p` 응답으로 선택·권한 판단·완료 조건을 비교하는 6단계 경로다. 실제 파일 수정, 스킬 자동 선택·참조 읽기, 브라우저 조작의 성공은 입증하지 않는다. 그런 주장은 해당 작업의 실제 실행 증거가 별도로 필요하다. Wiki 승인·생성 계약이나 외부 게시 권한을 대체하지 않는다.

## 1. 비교 조건과 과제 고르기

- 이전/이후 커밋, 변경 경계, 작업 프롬프트, 판독 항목, 고정 모델의 전체 ID·effort, CLI 버전, 도구·검색 조건을 정한다. 모델 별칭이나 자동 fallback은 쓰지 않는다.
- 이전 지침에서 틀렸을 만한 선택을 포함한 한두 과제를 봉인 전에 시범 판독한다. 기존 출력이나 문서상 점검으로 준비할 수 있지만 이를 실제 모델 표본으로 세지 않는다. 실제 시범 호출도 유료라면 사전 승인이 필요하다.
- 양쪽 모두 만점일 항목은 효과 판정에서 제외하거나 과제를 다시 고른다. 판별할 항목이 없으면 효과 평가 준비가 끝난 것이 아니다. 안전·승인 경계는 차이를 만들려고 빼지 않고 별도의 보존 항목으로 유지한다. 시범 출력은 본 평가 표본에서 제외한다.
- 각 항목에 관찰할 선택과 실패 조건을 적는다. 점수 합계뿐 아니라 무관한 절차 발동, 필요한 참조 누락, 권한 위반, 검증 누락과 조기 종료를 판독한다.
- 장면과 판독 기준은 실제 환경의 구조와 도구 반환값을 따른다. 장면에서 지어낸 이름·구조를 정답으로 삼으면 지침 문장이 아니라 그 이름의 일치를 잰다(예: 증거 디렉터리 도구가 `shared/`를 돌려주는데 `evidence/` 하위 폴더를 만들어 그곳에 남기는지로 판정). 실제 목표 id·세션 이름·사용자 경로는 가상 값으로 바꾼다.
- 한 평가에서 여러 문장을 다뤄야 하면(이 절차로 아직 실행되지 않았다) 문장마다 그 문장만 격리한 전·후 쌍을 만들고(커밋이 섞여 있으면 임시 브랜치에 문장별 격리 커밋) 과제·판독 항목도 문장별로 나눈다. 한 쌍으로 묶어 돌리면 결합 효과만 보고한다.
- `N`은 전·후 합계 회차 수로 정하고 짝수로 한다. 표본 수와 최소 관찰 기간, 비용·턴 상한, 실행·판독에 쓰는 모델/제공자별 과금 풀과 승인 범위를 적는다. 자기 세션의 모델 사용량과 의도적인 평가 호출을 구분한다. 모든 평가에 여섯 회를 강요하지 않는다.

명령은 `claude --help`로 확인한 2.1.292 기준이다. 다른 버전은 도움말을 저장하고 아래 플래그의 존재·의미를 다시 확인한다. 승인되지 않은 모델 호출로 확인하지 않는다.

```bash
OUT=$(claude --version 2>&1); rc=$?; printf '%s\nrc=%s\n' "$OUT" "$rc"
OUT=$(claude --help 2>&1); rc=$?; printf '%s\nrc=%s\n' "$OUT" "$rc"
```

계획과 승인 요청 전에 유료 경로의 자격증명 원천을 무료로 점검한다. 값은 읽거나 기록하지 않고 존재 여부와 종류만 남긴다. 판정은 5단계가 소유한다.

```bash
OUT=$(claude auth status 2>&1); rc=$?
printf '%s\nrc=%s\n' "$(printf '%s' "$OUT" | jq -c '{loggedIn, authMethod, apiProvider, subscriptionType}' 2>&1)" "$rc"
for v in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN; do
  if printenv "$v" > /dev/null; then echo "$v: set"; else echo "$v: unset"; fi
done
OUT=$(jq 'has("apiKeyHelper")' "$HOME/.claude/settings.json" 2>&1); rc=$?; printf 'apiKeyHelper=%s rc=%s\n' "$OUT" "$rc"
```

## 2. 두 버전 추출과 전수 대조

구현 worktree에서 시작한다. `SCRATCHPAD`는 현재 세션의 scratchpad 절대 경로, `E`는 그 아래 실행자 전용 증거 디렉터리다. 목표의 공유 증거 디렉터리는 모든 구성원이 열 수 있으므로 `E`를 거기에 두지 않는다(6절). `BEFORE`·`AFTER`는 비교할 커밋, `MODEL`은 전체 모델 ID로 지정한다. 예시 값은 고정 모델을 지정하는 형식이지 사용 승인이 아니다.

명령 블록은 bash 스크립트 파일로 이어 붙여 `bash`로 실행한다. zsh 도구에 붙여 넣으면 `exit`가 셸을 끝내고 무일치 glob이 오류를 낸다. 종료 trap이 `$T`를 지우므로 단계를 나눠 실행하면 같은 스크립트를 다시 돌려 재추출한다. 추출 디렉터리 이름은 길이가 같은 중립 무작위 값이라 요청 본문의 경로로 버전이 드러나지 않고, 이름 대응표는 `E`에 한 번만 만들어 재사용한다.

```bash
REPO=$PWD
BEFORE=<이전-커밋>
AFTER=<이후-커밋>
MODEL=claude-sonnet-4-6
EFFORT=high
TASK_DIR=.
mkdir -p "$E"
printf '%s\n' "$TASK_DIR" > "$E/task-dir.txt"
if [ ! -s "$E/unblind-dirnames.txt" ]; then
  nb=ws-$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 6)
  na=ws-$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 6)
  [ "$nb" != "$na" ] || exit 1
  printf 'before=%s\nafter=%s\n' "$nb" "$na" > "$E/unblind-dirnames.txt"
fi
DIR_before=$(sed -n 's/^before=//p' "$E/unblind-dirnames.txt")
DIR_after=$(sed -n 's/^after=//p' "$E/unblind-dirnames.txt")
T=$(mktemp -d "$SCRATCHPAD/instruction-evaluation.XXXXXX")
trap 'rm -rf -- "$T"' EXIT; trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP
mkdir -p "$T/$DIR_before" "$T/$DIR_after" "$T/home" "$T/config" "$T/tmp" "$T/scripts"
for side in before after; do
  if [ "$side" = before ]; then ref=$BEFORE; dir=$DIR_before; else ref=$AFTER; dir=$DIR_after; fi
  OUT=$(git -C "$REPO" rev-parse "$ref^{commit}" 2>&1); rc=$?
  printf '%s\n' "$OUT" > "$E/$side.commit"; printf '%s\n' "$rc" > "$E/$side.commit.rc"
  [ "$rc" -eq 0 ] || exit "$rc"
  OUT=$(git -C "$REPO" archive --format=tar -o "$T/$side.tar" "$OUT" 2>&1); rc=$?
  printf '%s\n' "$OUT" > "$E/$side.archive.out"; printf '%s\n' "$rc" > "$E/$side.archive.rc"
  [ "$rc" -eq 0 ] || exit "$rc"
  OUT=$(tar -xf "$T/$side.tar" -C "$T/$dir" 2>&1); rc=$?
  printf '%s\n' "$OUT" > "$E/$side.extract.out"; printf '%s\n' "$rc" > "$E/$side.extract.rc"
  [ "$rc" -eq 0 ] || exit "$rc"
done
OUT=$(diff -rq "$T/$DIR_before" "$T/$DIR_after" 2>&1); rc=$?
printf '%s\n' "$OUT" > "$E/tree-diff.out"; printf '%s\n' "$rc" > "$E/tree-diff.rc"
```

`diff`의 0은 동일, 1은 차이 발견, 2 이상은 실패다. 파일 수만 세지 말고 모든 차이가 선언한 변경 경계에 속하는지 원문으로 확인한다. archive에는 `.git`·설치된 의존성·미커밋 변경이 없다. 추출 트리는 기존 체크아웃 아래에 두지 않는다. 추출 디렉터리와 그 상위 경로의 `CLAUDE.md`·`CLAUDE.local.md`가 의도치 않게 섞이지 않는지 확인하고, **각 회차는 해당 추출 트리 안에서 실행**한다. `--add-dir`로 다른 체크아웃을 추가하지 않는다. 과제의 하위 경로가 지침 로드를 결정하면(하위 `CLAUDE.md` 변경 등) 그 저장소 상대 경로를 `TASK_DIR`로 정한다. 값은 `task-dir.txt`에 기록해 4단계에서 함께 봉인하고, 메모리 경로 키와 3단계의 `claude_call`은 셸 변수가 아니라 그 파일에서 읽어 양쪽에서 같은 하위 경로로 실행한다. 기본값은 루트(`.`)다.

자동 탐색은 유지한다. `--bare`나 별도 시스템 프롬프트에 지침을 주입하는 방식으로 바꾸면 실제 세션과 지침의 위치·포장이 달라지므로 이 경로와 동등한 평가가 아니다. 도구를 끈 상태에서 참조 문서가 필요한 과제는 선택한 참조의 **각 버전 원문**을 입력 문맥으로 함께 제공한다. 선택 목록과 순서는 고정하고 요청 본문에서 차이를 확인한다. 이것은 고정 검색 조건의 응답 평가이지 모델이 실제로 참조를 열었다는 증거가 아니다.

사용자 상태를 직접 사용하는 대신 필요한 메모리만 읽기 전용 스냅샷으로 고정한다. 사용자 홈·자격증명·설정 전체를 복사하지 않는다. 다음은 같은 사용자 `MEMORY.md`를 양쪽 임시 프로젝트 경로에 놓는 명령이다. 실제 로드 여부와 경로 키는 3단계 요청에서 확인한다. 하위 메모리 파일까지 과제에 필요하면 그 목록도 고정한다. 메모리가 없는 과제는 `MEMORY_SOURCE`를 비워 두고, 양쪽에 메모리를 두지 않은 부재 표식을 `common-memory.md`로 봉인한다.

```bash
if [ -n "${MEMORY_SOURCE:-}" ]; then
  cp "$MEMORY_SOURCE" "$E/common-memory.md" || exit 1
  for dir in "$DIR_before" "$DIR_after"; do
    launch=$(cd "$T/$dir/$(< "$E/task-dir.txt")" && pwd -P) || exit 1
    key=$(printf '%s' "$launch" | tr '/.' '--')
    mkdir -p "$T/config/projects/$key/memory"
    cp "$E/common-memory.md" "$T/config/projects/$key/memory/MEMORY.md" || exit 1
  done
else
  printf 'no-user-memory\n' > "$E/common-memory.md"
fi
OUT=$(shasum -a 256 "$E/common-memory.md" 2>&1); rc=$?
printf '%s\n' "$OUT" > "$E/memory.sha256"; printf '%s\n' "$rc" > "$E/memory.sha256.rc"
```

## 3. 유료 호출 전 무료 요청 fixture

`CLAUDE_BIN`은 확인한 CLI 실행 파일의 절대 경로다. fixture 전에 4단계에서 봉인할 `task.txt`와 `context-paths.txt`(선택 참조가 없으면 빈 파일) 초안을 증거 디렉터리에 먼저 쓰고, `PROMPT`는 그 `task.txt`에서 읽는다. 그래야 fixture가 유료 회차와 같은 입력을 확인한다. 다음 함수를 fixture와 실제 회차에서 **그대로** 사용한다. 도구·스킬·훅·MCP·Chrome·세션 저장을 끄고 모델과 effort를 고정한다. `--setting-sources project`로 프로젝트 CLAUDE.md 자동 탐색을 유지하고 사용자·로컬 설정을 제외한다. 실행 전에 양쪽 프로젝트 설정의 존재와 내용을 확인한다. provider·환경·plugin·별도 agent 등을 활성화하는 설정이 있거나 조건을 설명할 수 없으면 이 명령으로 시작하지 않는다. 설정을 임의로 편집해 맞추지도 않는다. `--setting-sources ''`와 `--restricted`는 이 버전의 fixture에서 필요한 자동 지침 문맥을 제외했으므로 쓰지 않는다. 관리 정책 우회가 아니며, 적용된 관리 정책이 조건을 바꾸면 중단하고 기록한다.

```bash
CLAUDE_BIN=$(command -v claude)
claude_call() {
  if [ "$1" = before ]; then d=$DIR_before; else d=$DIR_after; fi
  (cd "$T/$d/$(< "$E/task-dir.txt")" || exit
    [ -n "$PROMPT" ] && [ -f "$E/context-paths.txt" ] || exit 1
    INPUT=$PROMPT
    while IFS= read -r path; do
      [ -n "$path" ] || continue
      [ -f "$T/$d/$path" ] || exit 1
      INPUT="$INPUT
문맥: $path
$(< "$T/$d/$path")"
    done < "$E/context-paths.txt"
    printf '%s\n' "$INPUT" > "$E/input-$1.txt"
    env -i PATH="$PATH" HOME="$T/home" TMPDIR="$T/tmp" \
    CLAUDE_CONFIG_DIR="$T/config" CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    ANTHROPIC_BASE_URL="$ENDPOINT" ANTHROPIC_API_KEY="$API_KEY" \
    "$CLAUDE_BIN" -p "$INPUT" --model "$MODEL" --effort "$EFFORT" \
    --tools '' --disable-slash-commands --settings '{"disableAllHooks":true}' \
    --setting-sources project --permission-mode dontAsk \
    --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
    --no-chrome --prompt-suggestions false --no-session-persistence --output-format json)
}
```

`$1`은 `before`/`after` 라벨이고 디렉터리는 위 대응표를 따른다. `input-before.txt`·`input-after.txt`는 실행자 파일이며 내용에 라벨이 없다. 스텁은 인증 헤더 종류(`auth_scheme`, `x_api_key_present`)도 기록하므로 OAuth 토큰 경로의 fixture도 같은 스텁으로 확인한다.

`env -i`는 부모 세션의 실제 키·OAuth·provider·프록시·secure-storage 환경을 전달하지 않는다. 임시 `HOME`·`CLAUDE_CONFIG_DIR`도 함께 쓰지만, 이 명령만으로 실제 Keychain 접근이나 외부 네트워크가 차단되는 것은 아니다. macOS의 무료 fixture는 아래 실행 보호 래퍼까지 읽고 적용한 뒤 시작한다. `--no-session-persistence`만으로 사용자 상태가 격리되는 것도 아니다. 실행 파일이나 정책이 자격증명·상태 경계를 바꾸면 진행하지 않는다. 이 예시는 API-key 경로이며 OAuth 로그인·토큰 갱신이나 다른 provider 경로는 검증하지 않는다.

무료 스텁은 loopback에만 바인딩하고 요청 본문을 증거 디렉터리에 저장한다. HTTP 요청 수신과 SSE 응답은 `jq`만으로 만들 수 없어 아래 임시 Python 서버를 사용한다. 저장한 응답은 모델 출력이 아니라 고정 fixture다. 스크립트는 추출 트리와 별도 디렉터리에 두고, Python은 `-I`로 실행한다.

```bash
cat > "$T/scripts/fixture.py" <<'PY'
import json, pathlib, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
root = pathlib.Path(sys.argv[1])
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        n = len(list(root.glob('request-*.json'))) + 1
        (root / f'request-{n}.json').write_text(json.dumps(body, ensure_ascii=False))
        (root / f'http-{n}.json').write_text(json.dumps({
            'path': self.path, 'host': self.headers.get('Host'),
            'fixture_key': self.headers.get('x-api-key') == 'fixture-not-a-real-key',
            'auth_scheme': (self.headers.get('Authorization') or '').split(' ')[0] or None,
            'x_api_key_present': self.headers.get('x-api-key') is not None}))
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        events = [
            ('message_start', {'message': {'id': f'msg_fixture_{n}', 'type': 'message',
                'role': 'assistant', 'model': body['model'], 'content': [],
                'stop_reason': None, 'stop_sequence': None,
                'usage': {'input_tokens': 1, 'output_tokens': 0}}}),
            ('content_block_start', {'index': 0, 'content_block': {'type': 'text', 'text': ''}}),
            ('content_block_delta', {'index': 0, 'delta': {'type': 'text_delta', 'text': 'fixture-only'}}),
            ('content_block_stop', {'index': 0}),
            ('message_delta', {'delta': {'stop_reason': 'end_turn', 'stop_sequence': None},
                'usage': {'output_tokens': 1}}),
            ('message_stop', {})]
        for kind, data in events:
            data['type'] = kind
            self.wfile.write(f'event: {kind}\ndata: {json.dumps(data)}\n\n'.encode())
        self.wfile.flush()
    def log_message(self, *args):
        pass
server = HTTPServer(('127.0.0.1', 0), Handler)
(root / 'port').write_text(str(server.server_port))
server.serve_forever()
PY
mkdir -p "$E/fixture"
python3 -I "$T/scripts/fixture.py" "$E/fixture" > "$E/fixture-server.out" 2>&1 &
stub=$!
trap 'kill "$stub" 2>/dev/null; wait "$stub" 2>/dev/null; rm -rf -- "$T"' EXIT
# port가 생성된 뒤 진행한다. 서버가 종료되거나 준비되지 않으면 CLI를 실행하지 않는다.
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  [ -s "$E/fixture/port" ] && break
  kill -0 "$stub" 2>/dev/null || exit 1
  sleep 0.1
done
[ -s "$E/fixture/port" ] || exit 1
ENDPOINT="http://127.0.0.1:$(< "$E/fixture/port")"
API_KEY=fixture-not-a-real-key
PROMPT=$(< "$E/task.txt") || exit 1
for side in before after; do
  OUT=$(claude_call "$side" 2> "$E/fixture-$side.stderr"); rc=$?
  printf '%s\n' "$OUT" > "$E/fixture-$side.json"; printf '%s\n' "$rc" > "$E/fixture-$side.rc"
  [ "$rc" -eq 0 ] || exit "$rc"
done
```

이전 증거 디렉터리를 재사용하지 않고 실행마다 분리한다. 다음 짧은 점검은 본문을 검색 가능한 문자열로 펼친다. 건수는 근거 문장의 완전 일치로 센다.

```bash
for n in 1 2; do
  OUT=$(jq -r '.. | objects | select(.type? == "text") | .text' "$E/fixture/request-$n.json" 2>&1); rc=$?
  printf '%s\n' "$OUT" > "$E/request-$n.text"; printf '%s\n' "$rc" > "$E/request-$n.text.rc"
done
OUT=$(grep -Fxc '# Fleet' "$E/request-1.text" "$E/request-2.text" 2>&1); rc=$?
printf '%s\n' "$OUT" > "$E/claude-count.out"; printf '%s\n' "$rc" > "$E/claude-count.rc"
OUT=$(grep -Fc -- "$TARGET_SENTENCE" "$E/request-1.text" "$E/request-2.text" 2>&1); rc=$?
printf '%s\n' "$OUT" > "$E/target-count.out"; printf '%s\n' "$rc" > "$E/target-count.rc"
OUT=$(jq '{model, tools, system, messages}' "$E/fixture/request-1.json" "$E/fixture/request-2.json" 2>&1); rc=$?
printf '%s\n' "$OUT" > "$E/request-context.json"; printf '%s\n' "$rc" > "$E/request-context.rc"
sed "s#$DIR_before#<DIR>#g" "$E/request-1.text" > "$E/request-1.masked"
sed "s#$DIR_after#<DIR>#g" "$E/request-2.text" > "$E/request-2.masked"
OUT=$(diff "$E/request-1.masked" "$E/request-2.masked" 2>&1); rc=$?
printf '%s\n' "$OUT" > "$E/masked-diff.out"; printf '%s\n' "$rc" > "$E/masked-diff.rc"
for n in 1 2; do
  OUT=$(jq -r '.. | objects | select(.type? == "text") | .text | select(contains("# Memory Index")) | split("# Memory Index")[1]' "$E/fixture/request-$n.json" 2>&1); rc=$?
  printf '%s\n' "$OUT" > "$E/request-$n.memory"; printf '%s\n' "$rc" > "$E/request-$n.memory.rc"
done
OUT=$(cmp "$E/request-1.memory" "$E/request-2.memory" 2>&1); rc=$?
printf '%s\n' "$OUT" > "$E/memory-compare.out"; printf '%s\n' "$rc" > "$E/memory-compare.rc"
OUT=$(jq '{num_turns, total_cost_usd, duration_ms, usage, is_error, result}' "$E/fixture-before.json" "$E/fixture-after.json" 2>&1); rc=$?
printf '%s\n' "$OUT" > "$E/fixture-metrics.json"; printf '%s\n' "$rc" > "$E/fixture-metrics.rc"
```

`# Memory Index`는 고정한 메모리의 제목에 맞추며, 양쪽 추출 파일이 비어 있지 않은지도 본문으로 확인한다. 양쪽 모두 빈 파일이라는 사실만으로 메모리 로드를 입증하지 않는다. 메모리가 없는 과제는 `grep -c 'Memory Index'`가 양쪽 0건인지 확인한다(이때 `memory-compare`의 빈 파일 비교는 의미가 없다). 요청에는 메모리 부재여도 `# Memory` 섹션과 임시 config 아래 경로가 실리므로 이를 메모리 로드로 읽지 않는다. 두 요청의 텍스트 차이는 `masked-diff.out`이 대상 줄만 보이는지로 확인한다. 중립 디렉터리 이름을 가린 뒤에도 남는 차이는 예정한 변경인지 읽고 판정한다. `# Fleet`는 이 저장소 루트의 고유 제목이다. 다른 대상이면 그 대상의 고유 제목으로 바꾼다. 제목 횟수만으로 전문 일치나 출처를 증명하지는 못하므로 `request-context.json`에서 위치와 본문도 읽는다. 루트만 적용되는 과제에서는 CLAUDE.md가 한 부만, 평가 대상 문장은 기대한 횟수만 실렸는지 확인한다. 하위 지침도 필요하면 의도한 파일 목록·횟수에 맞춘다. `tools`가 비어 있거나 생략되었는지, 사용자 메모리 본문이 같은지, 경로·시각 외에 예정하지 않은 문맥 차이가 없는지 확인한다. `grep`의 1은 일치 없음이므로 기대한 0건과 실행 실패를 구별해 기록한다.

수신한 host·path·fixture_key와 허용한 환경을 기록하고 실제 키·provider URL을 상속하지 않았는지 확인한다. loopback 도착만으로 OS 전체 네트워크 차단을 주장하지 않는다. 다음은 macOS 무료 fixture 전용 실행 보호 래퍼다. 위의 준비·fixture 명령을 세션 scratchpad의 스크립트에 두고 `FIXTURE_SCRIPT`를 그 절대 경로로 지정한 뒤 이 래퍼로 실행한다. 스크립트는 loopback 엔드포인트와 fixture 키만 사용해야 하며, 실제 평가나 인증 단계는 포함하지 않는다. `REAL_HOME`은 임시 HOME으로 바꾸기 전 실제 사용자 홈이다.

```bash
REAL_HOME=$HOME
mkdir -p "$E"
FIXTURE_PROFILE="(version 1) (allow default) (deny network*)
(allow network-outbound (remote ip \"localhost:*\"))
(allow network-inbound (local ip \"localhost:*\"))
(deny file-write* (subpath \"$REAL_HOME/.claude\") (literal \"$REAL_HOME/.claude.json\"))
(deny file-read* file-write* (subpath \"$REAL_HOME/Library/Keychains\"))"
printf '%s\n' "$FIXTURE_PROFILE" > "$E/fixture-sandbox-profile.txt"
OUT=$(sandbox-exec -p "$FIXTURE_PROFILE" python3 -I -c 'import socket; s=socket.socket(); s.settimeout(1); r=s.connect_ex(("192.0.2.1",443)); print("connect_ex_errno="+str(r)); assert r==1' 2>&1); rc=$?
printf '%s\n' "$OUT" > "$E/network-denial-probe.out"; printf '%s\n' "$rc" > "$E/network-denial-probe.rc"
[ "$rc" -eq 0 ] || exit "$rc"
OUT=$(sandbox-exec -p "$FIXTURE_PROFILE" /bin/bash "$FIXTURE_SCRIPT" 2>&1); rc=$?
printf '%s\n' "$OUT" > "$E/fixture-wrapper.out"; printf '%s\n' "$rc" > "$E/fixture-wrapper.rc"
[ "$rc" -eq 0 ] || exit "$rc"
```

외부 주소 연결 프로브의 `connect_ex_errno=1`은 이 래퍼 안에서 연결이 거절되었음을 뜻한다. 프로브나 loopback 스텁 도착 확인이 실패하면 CLI 호출을 계속하지 않는다. 파일 보호는 실제 `.claude` 쓰기와 Keychains 읽기·쓰기를 거절하며, 실제 파일에 쓰거나 Keychain 자격증명을 읽어 시험하지 않는다. 프로파일은 OS 전체가 아니라 감싼 프로세스와 자식에게 적용된다. `sandbox-exec`가 없거나 정책을 적용할 수 없는 플랫폼에서는 동등한 격리를 확보하거나 실행 전에 멈춘다. 래퍼 산출물(`fixture-wrapper.*`, `network-denial-probe.*`, `fixture-sandbox-profile.txt`)은 고정 이름이라 같은 `E`에서 다시 돌리면 덮인다. 다시 돌리기 전에 이전 산출물을 별도 폴더로 옮긴다.

이 래퍼는 `claude_call` 밖에 있으며 **무료 fixture에만** 씌운다. 요청을 만드는 `claude_call`의 플래그·환경·문맥은 바꾸지 않는다. 실제 회차와 비교할 때 요청 구성의 차이는 앞서 정한 엔드포인트·키 두 값뿐이고, 이 무료 실행 보호 정책을 유료 실행의 네트워크 조건이나 모델 행동 효과로 해석하지 않는다. 실패한 JSON 출력, 없는 계측 값, 다른 메모리는 고치고 다시 확인한 뒤 봉인한다.

## 4. 과제·판독 기준 봉인

공통 작업 프롬프트 `task.txt`, 선택 참조 목록 `context-paths.txt`, 판독 기준 `rubric.md`, 시범 판독 결론·표본 수·최소 관찰 기간·모델·CLI·비용/턴 상한을 적은 `conditions.md`를 증거 디렉터리에 저장한다. 시범 판독 `pilot.md`와 디렉터리 이름 대응표 `unblind-dirnames.txt`도 함께 해시해 봉인 뒤 바꿀 수 없게 한다. 선택 참조가 있으면 양쪽에서 조립한 입력 문맥도 보관한다. 3단계의 요청·원문·종료 부호를 확인한 뒤, 본 평가 유료 호출이 아직 0인 상태에서 해시와 시각을 기록한다.

```bash
OUT=$(shasum -a 256 "$E/task.txt" "$E/context-paths.txt" "$E/rubric.md" "$E/conditions.md" "$E/before.commit" "$E/after.commit" "$E/common-memory.md" "$E/input-before.txt" "$E/input-after.txt" "$E/task-dir.txt" "$E/pilot.md" "$E/unblind-dirnames.txt" 2>&1); rc=$?
printf '%s\n' "$OUT" > "$E/sealed.sha256"; printf '%s\n' "$rc" > "$E/sealed.sha256.rc"
[ "$rc" -eq 0 ] || exit "$rc"
OUT=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>&1); rc=$?
printf '%s\n' "$OUT" > "$E/sealed-at.out"; printf '%s\n' "$rc" > "$E/sealed-at.rc"
```

봉인 뒤 과제·기준을 결과에 맞춰 고치지 않는다. 변경이 필요하면 기존 실행과 분리한 새 평가로 다시 봉인한다. 본 평가 전에 시행한 유료 시범이 있으면 그 비용을 숨기지 않고 별도 장부에 둔다.

## 5. 승인된 반복 실행과 장부

**실제 모델의 반복 실행은 유료 실행 승인 이후에만 진행한다.** 무료 검증만 맡은 세션은 실제 평가를 시작하지 않는다. 장부·상한 조회·번호별 출력 분리 명령 자체는 `ENDPOINT`를 loopback 스텁, `API_KEY`를 fixture 값으로 유지하여 무료로 확인할 수 있다. 이때 회차와 비용은 합성 fixture 장부라고 표시하고 실제 모델 표본과 섞지 않는다. 실제 호출에는 사람이 승인한 자격증명 경로가 필요하다. 1단계 사전 점검에서 키 원천(`ANTHROPIC_API_KEY`·`apiKeyHelper`)이 없고 `claude auth status`가 OAuth(`claude.ai`) 로그인뿐이면 이 문서의 비교는 실행할 수 없다. 사람의 행동이 필요하다고 판정하고 1~4단계 무료 산출물과 미실행 계획값만 남긴다. 경로는 둘이다. (a) 사람이 API 키를 비밀 입력으로 제공하고 `ENDPOINT=https://api.anthropic.com`을 쓴다. (b) `claude setup-token`(구독 필요)의 장기 토큰을 `claude_call`의 `ANTHROPIC_API_KEY="$API_KEY"` 자리에 `CLAUDE_CODE_OAUTH_TOKEN`으로 `env -i`에 넘긴다. (b)는 무료 fixture에서 임시 HOME 로그인 요구 없이 스텁에 `Authorization: Bearer` 요청 1건만 보내고 다른 요청은 없음까지만 확인했다. 실제 토큰의 유효성·갱신과 구독 과금 풀은 확인하지 않았으므로 승인이 그 풀을 이름으로 지정해야 한다. 세션의 `ANTHROPIC_BASE_URL`(Fleet 로컬 게이트웨이)은 호출자 자격증명을 전달할 뿐 키 원천이 아니고, `--bare`는 `CLAUDE.md` 자동 탐색을 꺼서 이 평가에 쓸 수 없다. 키를 문서·증거 파일·커밋·셸 이력에 넣지 말고, 예를 들어 비밀 입력으로 읽어 셸 변수에만 둔다. 임시 HOME에서 로그인하거나 실제 사용자 설정으로 되돌아가지 않는다. fixture와 실제 회차의 차이는 이 두 값뿐이며, `claude_call`의 플래그·나머지 환경·메모리·검색 조건·모델·effort를 바꾸지 않는다. provider나 인증 방식 변경이 필요하면 fixture부터 새로 확인한다.

전·후를 번갈아 `N`회 실행한다. `task.txt`는 공통 작업 프롬프트이며, `claude_call`이 `context-paths.txt`의 같은 상대 경로 목록·순서로 각 버전 참조 원문을 덧붙인다. 참조 원문의 차이를 봉인하고 이를 공통 작업 프롬프트 변경과 혼동하지 않는다. 실행 전에 `N`, `TURN_LIMIT`, `COST_LIMIT`을 승인된 합계 회차 수·턴 상한·달러 상한으로 지정한다.

```bash
PROMPT=$(< "$E/task.txt")
printf 'number\tside\trc\tturns\tcost_usd\tduration_ms\n' > "$E/ledger.tsv"
i=1
while [ "$i" -le "$N" ]; do
  if [ $((i % 2)) -eq 1 ]; then side=before; else side=after; fi
  OUT=$(claude_call "$side" 2> "$E/run-$i.stderr"); rc=$?
  printf '%s\n' "$OUT" > "$E/run-$i.json"; printf '%s\n' "$rc" > "$E/run-$i.rc"
  METRICS=$(jq -er 'select(.num_turns != null and .total_cost_usd != null and .duration_ms != null) | [.num_turns, .total_cost_usd, .duration_ms] | @tsv' "$E/run-$i.json" 2>&1); metrics_rc=$?
  printf '%s\n' "$metrics_rc" > "$E/run-$i.metrics.rc"
  printf '%s\t%s\t%s\t%s\n' "$i" "$side" "$rc" "$METRICS" >> "$E/ledger.tsv"
  [ "$rc" -eq 0 ] && [ "$metrics_rc" -eq 0 ] || break
  LIMIT_OK=$(jq -e -s --argjson turns "$TURN_LIMIT" --argjson cost "$COST_LIMIT" '([.[].num_turns] | add) < $turns and ([.[].total_cost_usd] | add) < $cost' "$E"/run-*.json 2>&1); limit_rc=$?
  printf '%s\n' "$LIMIT_OK" > "$E/run-$i.limit.out"; printf '%s\n' "$limit_rc" > "$E/run-$i.limit.rc"
  [ "$limit_rc" -eq 0 ] || break
  i=$((i + 1))
done
unset API_KEY
```

루프는 회차 사이에 상한을 대조한다. 상한을 초과하는 한 회차 자체를 사후 계산으로 막을 수는 없으므로, 남은 예산이 다음 회차를 감당하지 못하면 시작하지 않는다. 최소 관찰 기간도 별도로 확인한다. 상한에 닿으면 다음 회차를 시작하지 않는다. 실패·재시도·시범·판독 호출도 장부에 따로 기록한다. CLI의 `total_cost_usd`는 제공자의 실제 청구 확정값이 아니다. fixture의 토큰·비용은 합성 응답에서 계산한 숫자이므로 실제 사용량으로 합산하지 않는다. `num_turns`가 없거나 조회가 실패하면 1턴으로 추정하지 않고 원문·실패 이유를 남긴다.

## 6. 번호만 보는 판독과 결과

실행 전 판독자는 과제·기준과 출력 번호만 보도록 정한다. 실행 모델과 다른 계열의 모델을 사용하고, 그 판독 호출도 유료면 별도 승인을 받는다. 각 `run-번호.json`의 `result`만 무작위 판독 번호의 `번호.txt`로 추출한다. 실행 순서는 전·후 교대라 이 문서를 읽은 판독자가 실행 번호의 홀짝으로 버전을 알아낼 수 있으므로, 판독 번호는 실행 번호와 다른 무작위 순열로 붙이고 그 대응표는 `unblind/`에 둔다. 파일은 판독 번호 순서로 만들어 생성 시각이 실행 순서를 드러내지 않게 하고, 순열의 seed는 시각이 아니라 `/dev/urandom`에서 읽어 판독자에게 넘긴 파일의 시각으로 재현할 수 없게 한다. 버전·모델·경로·시간·비용을 드러내는 CLI 메타데이터와 대응표는 판독자에게 주지 않는다. 출력 자체가 버전을 드러내면 마스킹 여부를 사전에 정하고 눈가림의 한계를 보고한다.

```bash
mkdir -p "$E/blind" "$E/unblind"
SEED=$(od -An -N4 -tu4 /dev/urandom) || exit 1
OUT=$(awk -v n="$N" -v seed="$SEED" 'BEGIN { srand(seed + 0); for (i = 1; i <= n; i++) a[i] = i
  for (i = n; i > 1; i--) { j = int(rand() * i) + 1; t = a[i]; a[i] = a[j]; a[j] = t }
  for (i = 1; i <= n; i++) print i "\t" a[i] }' 2>&1); rc=$?
printf '%s\n' "$OUT" > "$E/unblind/blind-map.tsv"; printf '%s\n' "$rc" > "$E/unblind/blind-map.rc"
[ "$rc" -eq 0 ] || exit "$rc"
label=1
while [ "$label" -le "$N" ]; do
  i=$(awk -F '\t' -v l="$label" '$2 == l { print $1 }' "$E/unblind/blind-map.tsv")
  OUT=$(jq -er '.result' "$E/run-$i.json" 2>&1); rc=$?
  printf '%s\n' "$OUT" > "$E/blind/$label.txt"; printf '%s\n' "$rc" > "$E/unblind/blind-$i.rc"
  [ "$rc" -eq 0 ] || exit "$rc"
  label=$((label + 1))
done
```

판독자에게는 `blind/`의 번호별 출력과 과제·기준만 전달한다. 실패 원문·종료 부호는 실행 장부에 남기되 판독 입력과 섞지 않는다. 전·후 순서를 아는 지휘관이 판독까지 대신하지 않는다. 판독 중에는 `unblind/`·`run-*`·`ledger.tsv`·commit 파일·fixture 원문·`unblind-dirnames.txt`를 판독 세션이 접근하지 않는 위치에 치운다. 목표의 공유 증거 디렉터리에는 `blind/` 묶음과 상태 파일만 두고, 공유 문서에 옮기는 해시·로그에서는 `E`의 절대 경로 접두를 지운다. 권한이 제한된 판독 세션에는 과제·기준과 번호별 출력만 전달하며, 그 세션이 못 여는 원래 보드를 읽으라고 시키지 않는다. 판독 결과를 확정한 뒤에만 대응표를 다시 열어 전·후로 합친다.

결과에는 경계별 실패, 보존한 안전 항목, 표본 수·실제 관찰 기간, 유료 실행·판독 턴과 비용·시간, 무료 fixture와 문서상 판독, 미실행 영역을 구분한다. 양쪽 만점이면 차이를 입증하지 못했다고 보고한다. 최소 기간·표본을 채우지 못한 부분을 효과 없음으로 단정하지 않는다. 문맥 감소나 한 번의 녹색 결과만으로 개편 완료를 주장하지 않는다.
