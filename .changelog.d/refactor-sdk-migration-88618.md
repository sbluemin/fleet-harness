---
branch: refactor/sdk-migration-88618
---

### fleet-console
#### Changed
- All Objective sessions use chat, without a separate terminal mode or conversion step. Saved conversations remain available, and the independent Claude CLI remains available.
  ko: 모든 Objective 세션은 별도의 터미널 모드나 전환 단계 없이 채팅을 사용합니다. 저장된 대화를 이어 갈 수 있으며, 독립 Claude CLI는 계속 사용할 수 있습니다.

#### Removed
- Removed the Objective terminal view, Workflow stage-by-stage model assignment, and the Fleet Routing terminal pane.
  ko: Objective 터미널 보기, Workflow 단계별 모델 배정, Fleet Routing 터미널 패널을 제거했습니다.
