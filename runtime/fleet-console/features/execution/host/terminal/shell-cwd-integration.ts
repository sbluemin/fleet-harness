import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { TerminalLaunchSpec } from "./terminal-types.js";

/**
 * 전역 Shell이 자기 cwd를 OSC 7로 보고하게 만드는 rc 주입.
 *
 * 사용자 홈에는 아무것도 쓰지 않는다. 래퍼 파일은 Console 데이터 디렉터리 아래에 두고, 셸이 그것을
 * 먼저 읽게 한 뒤 사용자의 원래 rc로 넘긴다. 주입하는 것은 두 가지다.
 * - cwd 보고 `ESC ] 7 ; file://<경로> BEL` — 프롬프트마다, 그리고 zsh는 디렉터리를 옮길 때마다(chpwd).
 * - 프롬프트 표식 `ESC ] 133 ; A BEL` — 프롬프트를 그리기 직전에만(zsh precmd, bash PROMPT_COMMAND).
 *   cwd 보고는 명령 도중에도 나오므로(`cd /tmp; read x`) 서버는 이 표식만 "프롬프트에 돌아왔다"로 읽는다.
 *   rc 실행이 끝나기 전에는 나오지 않으므로, 첫 표식 전의 셸에는 아무것도 주입하지 않는다. 호스트 부분을 비워 두는 이유는 같은 기계의
 * 이름이 `HOST`·`hostname`·`.local` 접미 사이에서 흔들리기 때문이다 — 비어 있으면 이 기계다.
 *
 * zsh와 bash만 다룬다. 그 밖의 셸은 그대로 띄우고 cwd는 spawn 위치로만 안다(`tracked: false`).
 */
export interface ShellCwdIntegration {
  /** 이 launch가 cwd를 보고하게 되었는가. */
  readonly tracked: boolean;
  /** 프롬프트에 있을 때 전경 프로세스로 보일 이름(셸 실행 파일의 basename). */
  readonly shellName: string;
  readonly launch: TerminalLaunchSpec;
}

const ORIGINAL_ZDOTDIR_ENV = "FLEET_SHELL_ORIGINAL_ZDOTDIR";
const ORIGINAL_ZDOTDIR_SET_ENV = "FLEET_SHELL_ORIGINAL_ZDOTDIR_SET";

// 퍼센트 인코딩은 바이트 단위로 한다(LC_ALL=C). 안전 문자 밖은 전부 %XX — URL 파서가 그대로 되돌린다.
const ZSH_ENV = `# Fleet Console Shell integration — generated; edits are overwritten.
# Restore the user's ZDOTDIR first so every later startup file comes from the user's own place.
if [[ -n "\${${ORIGINAL_ZDOTDIR_SET_ENV}-}" ]]; then
  ZDOTDIR="\${${ORIGINAL_ZDOTDIR_ENV}}"
else
  unset ZDOTDIR
fi
unset ${ORIGINAL_ZDOTDIR_ENV} ${ORIGINAL_ZDOTDIR_SET_ENV}
if [[ -r "\${ZDOTDIR:-\$HOME}/.zshenv" ]]; then
  builtin source "\${ZDOTDIR:-\$HOME}/.zshenv"
fi
if [[ -o interactive ]]; then
  __fleet_report_cwd() {
    emulate -L zsh
    local LC_ALL=C s="\$PWD" e= c
    local -i i
    for (( i = 1; i <= \${#s}; i++ )); do
      c="\${s[i]}"
      case "\$c" in
        [-/._~A-Za-z0-9]) e+="\$c" ;;
        *) builtin printf -v c '%%%02X' "'\$c"; e+="\$c" ;;
      esac
    done
    builtin printf '\\e]7;file://%s\\a' "\$e"
  }
  __fleet_mark_prompt() {
    builtin printf '\\e]133;A\\a'
  }
  autoload -Uz add-zsh-hook
  add-zsh-hook precmd __fleet_report_cwd
  add-zsh-hook precmd __fleet_mark_prompt
  add-zsh-hook chpwd __fleet_report_cwd
fi
`;

const BASH_RC = `# Fleet Console Shell integration — generated; edits are overwritten.
if [ -r "\$HOME/.bashrc" ]; then
  . "\$HOME/.bashrc"
fi
__fleet_report_cwd() {
  local LC_ALL=C s="\$PWD" e= c i
  for (( i = 0; i < \${#s}; i++ )); do
    c="\${s:i:1}"
    case "\$c" in
      [-/._~A-Za-z0-9]) e+="\$c" ;;
      # bash 3.2 reads bytes >= 0x80 as negative chars; keep only the low byte.
      *) printf -v c '%d' "'\$c"; printf -v c '%%%02X' "\$(( c & 255 ))"; e+="\$c" ;;
    esac
  done
  printf '\\e]7;file://%s\\a' "\$e"
}
__fleet_mark_prompt() {
  printf '\\e]133;A\\a'
}
# 사용자의 PROMPT_COMMAND는 그대로 두고 앞뒤에만 잇는다. 줄바꿈으로 이어 ';'로 끝나는 값과도 섞이지 않게 한다.
PROMPT_COMMAND="__fleet_report_cwd"$'\\n'"\${PROMPT_COMMAND:-}"$'\\n'"__fleet_mark_prompt"
`;

export function applyShellCwdIntegration(launch: TerminalLaunchSpec, integrationDir: string | null): ShellCwdIntegration {
  const shellName = path.basename(launch.bin).replace(/\.exe$/i, "");
  if (!integrationDir || launch.args.length > 0) return { tracked: false, shellName, launch };
  try {
    if (shellName === "zsh") {
      const zdotdir = path.join(integrationDir, "zsh");
      writeIfChanged(path.join(zdotdir, ".zshenv"), ZSH_ENV);
      const original = launch.env.ZDOTDIR;
      const env: NodeJS.ProcessEnv = { ...launch.env, ZDOTDIR: zdotdir };
      if (original !== undefined) {
        env[ORIGINAL_ZDOTDIR_ENV] = original;
        env[ORIGINAL_ZDOTDIR_SET_ENV] = "1";
      } else {
        delete env[ORIGINAL_ZDOTDIR_ENV];
        delete env[ORIGINAL_ZDOTDIR_SET_ENV];
      }
      return { tracked: true, shellName, launch: { ...launch, env } };
    }
    if (shellName === "bash") {
      const rcfile = path.join(integrationDir, "bash", "bashrc");
      writeIfChanged(rcfile, BASH_RC);
      return { tracked: true, shellName, launch: { ...launch, args: ["--rcfile", rcfile] } };
    }
  } catch {
    // 래퍼를 못 쓰면 주입 없이 띄운다 — cwd 보고를 잃는 것이 셸을 못 여는 것보다 낫다.
    return { tracked: false, shellName, launch };
  }
  return { tracked: false, shellName, launch };
}

function writeIfChanged(file: string, content: string): void {
  try {
    if (readFileSync(file, "utf8") === content) return;
  } catch {
    // 없거나 읽을 수 없으면 새로 쓴다.
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, { mode: 0o644 });
}
