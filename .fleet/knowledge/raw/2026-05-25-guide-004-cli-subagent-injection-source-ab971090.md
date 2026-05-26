---
id: "guide-004-cli-subagent-injection-source"
created: "2026-05-25T14:40:55.506Z"
sourceType: "inline"
title: "cli-subagent-injection-research-2026-05-25.md"
tags: ["guide", "cli", "sub-agent", "claude-code", "codex", "opencode", "spawn", "comparison", "carrier", "current"]
contentHash: "ab971090"
---
# Raw research transcript — 2026-05-25

## Claude Code (`claude --help`)

```
--agent <agent>     Agent for the current session. Overrides the 'agent' setting.
--agents <json>     JSON object defining custom agents (e.g.
                    '{"reviewer": {"description": "Reviews code", "prompt": "You are a code reviewer"}}')
```

공식 문서: https://code.claude.com/docs/en/sub-agents
- `--agents`: JSON 객체로 인라인 sub-agent 정의. 세션 한정 휘발성. 파일 저장 안 됨.
- 지원 필드: description, prompt, tools, disallowedTools, model, permissionMode, mcpServers, hooks, maxTurns, skills, initialPrompt, memory, effort, background, isolation, color.
- `--agent` (단수): 이미 등록된 에이전트 이름 선택.

## Codex CLI (`codex --help`)

- `-p, --profile <name>`: 미리 정의된 `~/.codex/config.toml` 프로필 선택만.
- `--profile-v2 <name>`: `$CODEX_HOME/<name>.config.toml` 레이어링.
- `-c, --config <key=value>`: TOML 키 override.
- 부재: `--agents`, `--agent`, `--persona`, `--sub-agent`, `--system-prompt`, `--instructions`.

공식 문서: https://developers.openai.com/codex/subagents, /codex/cli/reference, /codex/config-advanced
- Sub-agent는 `~/.codex/agents/<name>.toml` 또는 `.codex/agents/<name>.toml` 파일 기반 정의.
- 필수 필드: name, description, developer_instructions.
- 호출은 자연어 위임만 — CLI 플래그로 특정 sub-agent 강제 호출 불가.
- 비공식 우회: `-c agents.X.developer_instructions='"..."'` (권장 안 됨).

## OpenCode (`opencode --help`, `opencode run --help`)

- `--agent <name>`: 이름 룩업만 (소스: `pickAgent()` in run.ts). 미발견 시 default 폴백.
- `--prompt`, `-m, --model`, `--variant`, `--command`, `--dir`.
- 부재: `--agents` (인라인 JSON), `--persona`, `--sub-agent`, `--system-prompt`, `--instructions`.

공식 문서: https://opencode.ai/docs/agents/, /docs/cli/, /docs/config/
- Markdown: `~/.config/opencode/agents/<name>.md` (글로벌) 또는 `.opencode/agents/<name>.md` (프로젝트)
  - YAML frontmatter: description, mode (subagent|primary|all), model, temperature, permission. 본문 = 시스템 프롬프트.
- JSON: `opencode.json`의 `"agent": { "<name>": { ... } }` 키.
- 환경변수 3종:
  - `OPENCODE_CONFIG`: config 파일 경로
  - `OPENCODE_CONFIG_DIR`: config 디렉터리
  - `OPENCODE_CONFIG_CONTENT`: Runtime overrides — config JSON 문자열 직접 주입 (인라인에 가장 근접한 공식 채널)

## Sources
- claude --help (local stdout, 2026-05-25)
- codex --help (local stdout, 2026-05-25)
- opencode --help / opencode run --help (local stdout, 2026-05-25)
- https://code.claude.com/docs/en/sub-agents
- https://developers.openai.com/codex/subagents
- https://opencode.ai/docs/agents/
- https://opencode.ai/docs/config/
- https://github.com/sst/opencode (run.ts, agent.ts)
