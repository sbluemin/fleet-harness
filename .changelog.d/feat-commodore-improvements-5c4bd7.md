---
branch: feat/commodore-improvements-5c4bd7
---

### fleet-console
#### Added
- Schedule when the Commodore's autonomous operation ends: pick a date and time, and at that moment it stops patrolling, tells the Commodore, and hands pending work back to you.
  ko: 사령관 자율 운영의 종료 시각을 날짜와 시간으로 예약할 수 있습니다. 그 시각이 되면 순찰을 멈추고 사령관에게 알린 뒤 대기 중인 일을 사용자에게 돌려줍니다.
- Clear the Commodore's conversation when you want a fresh start; its directive, intel and settings stay.
  ko: 원할 때 사령관의 대화를 비워 새로 시작할 수 있습니다. 지시·정보·설정은 그대로 남습니다.
- See how much of the Commodore's context window is in use beside its message field, as in Operation chat.
  ko: Operation 채팅처럼 사령관 입력창 옆에서 컨텍스트 창 사용량을 확인할 수 있습니다.
- Objective rows and their group headers in the sidebar now light up while Console Use works on Objectives, as Operations do.
  ko: Console Use가 Objectives를 다루는 동안 사이드바의 목표 줄과 묶음 머리에도 Operation처럼 표시가 나타납니다.
#### Changed
- The Commodore log opens as a centered popup over a dimmed backdrop, can be resized from any edge, and folds earlier turns into one line each.
  ko: 사령관 기록이 어두워진 배경 위 화면 가운데 팝업으로 열리고, 어느 가장자리에서든 크기를 바꿀 수 있으며, 지난 턴은 한 줄씩 접혀 보입니다.
#### Removed
- Settings no longer offers a default Commodore model; the Commodore runs on Opus with high effort unless you pick another model for a Theater in the Commodore log.
  ko: 설정에서 사령관 기본 모델 선택이 사라졌습니다. 사령관 기록에서 Theater별로 다른 모델을 고르지 않으면 Opus·High로 실행됩니다.
