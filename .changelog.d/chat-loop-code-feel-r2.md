---
branch: chat-loop-code-feel-r2
---

### fleet-console
#### Changed
- Chat view now shows the agent's work as it happens: steps stack up as a live ledger with a verb and its target, each one carrying its outcome (exit status, lines written, or the first line of an error), and the files a turn changed stand above them.
  ko: 채팅 뷰가 에이전트의 작업을 벌어지는 대로 보여줍니다. 스텝이 동사와 대상으로 원장에 쌓이고, 각 스텝은 종료 상태·쓴 줄 수·오류 첫 줄 같은 결말을 달며, 그 턴이 바꾼 파일이 위에 섭니다.
- A finished turn folds its whole process into one line that reads how long the agent worked, with an expander beside it. A turn that had a failed step says so on that line instead of hiding it behind a checkmark.
  ko: 끝난 턴은 과정 전부를 "얼마나 작업했는지" 한 줄로 접고, 문구 오른쪽의 아이콘이 그것을 폅니다. 실패한 스텝이 있었던 턴은 체크 표시 뒤에 숨기지 않고 그 줄에서 말합니다.
- Writes that land outside the Theater folder are marked in the ledger instead of reading like any other path.
  ko: Theater 폴더 밖에 떨어진 쓰기를 원장에서 표식으로 구별합니다 — 다른 경로와 똑같이 읽히지 않습니다.
