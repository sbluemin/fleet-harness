---
branch: worktree-quick-launch-prompt-file
---

### fleet-console
#### Changed
- Quick Launch no longer puts the original prompt on the Claude argv. On Windows cmd shims, native claude.exe, and POSIX, Fleet writes the original prompt to a unique OS temp file per launch and the session receives only a short instruction to read that file, so Trust folder and update dialogs still complete before the first user turn. Characters that cmd.exe would reinterpret (" & < > ( ) @ ^ | %) and command-line overflow are no longer reasons to refuse the launch.
  ko: Quick Launch는 Windows cmd shim, native `claude.exe`, POSIX 모두에서 원문을 Claude argv에 올리지 않습니다. Fleet이 실행마다 OS 임시 디렉터리에 원문을 파일로 쓰고, 세션에는 그 파일을 읽으라는 짧은 지시만 전달하므로 Trust folder와 업데이트 대화상자는 첫 사용자 턴 전에 그대로 끝납니다. cmd.exe가 재해석할 문자(`" & < > ( ) @ ^ | %`)나 명령줄 초과도 더 이상 거절 사유가 아닙니다.
