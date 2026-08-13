---
branch: worktree-quick-launch-prompt-file
---

### fleet-console
#### Changed
- Quick Launch still puts the original prompt on the Claude argv on POSIX, and on Windows when that prompt is short enough and has no cmd.exe metacharacters. On Windows, Fleet writes the original prompt to a unique OS temp file per launch and the session receives only a short instruction to read that file when the prompt contains a character cmd.exe would reinterpret (" & < > ( ) @ ^ | %), or when the command line would overflow (8,191 characters through a cmd shim, 32,767 through native claude.exe). Trust folder and update dialogs still complete before the first user turn. The Operation title still comes from the original prompt, not from a file instruction.
  ko: Quick Launch는 POSIX와, 짧고 cmd 특수문자가 없는 Windows 프롬프트에서는 원문을 Claude argv에 그대로 올립니다. Windows에서 cmd.exe가 재해석할 문자(`" & < > ( ) @ ^ | %`)가 있거나 명령줄이 상한(cmd shim 8,191자, native `claude.exe` 32,767자)을 넘기면 Fleet이 실행마다 OS 임시 디렉터리에 원문을 파일로 쓰고 세션에는 그 파일을 읽으라는 짧은 지시만 전달하므로 Trust folder와 업데이트 대화상자는 첫 사용자 턴 전에 그대로 끝납니다. Operation 이름은 그 파일 지시가 아니라 원문 프롬프트에서 짓습니다.
