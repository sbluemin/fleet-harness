---
branch: analyst-panel-caption-composer
---

### fleet-console
#### Changed
- Give the Session Analyst panel its own caption bar, so it lines up with the panel beside it instead of leaving an empty strip above it and squared-off top corners. Its identity, state, Reset, and the Chat/Artifacts switch move into that bar and stop covering the first line of the conversation.
  ko: Session Analyst 패널에 자체 캡션바를 주어, 위쪽에 빈 띠와 각진 모서리를 남기는 대신 옆 패널과 나란히 맞춰 섭니다. 정체·상태·초기화·대화/아티팩트 전환이 그 캡션바로 옮겨가 대화 첫 줄을 더 이상 가리지 않습니다.
- Rebuild the Session Analyst composer as one surface: the model, effort, and slash-command controls now sit inside the prompt box instead of a separate strip above it, control labels are large enough to read, and effort uses the same colour ladder as Quick Launch.
  ko: Session Analyst 컴포저를 한 장의 면으로 다시 만들었습니다. 모델·강도·슬래시 명령 컨트롤이 입력 상자 위 별도 스트립이 아니라 그 안에 자리하고, 컨트롤 글자가 읽을 수 있는 크기로 커지며, 강도는 Quick Launch와 같은 색 사다리를 씁니다.

#### Removed
- Drop the Analyst composer's provider control while only one provider is offered. It listed a single unchangeable entry, and the model menu already covers every native and gateway model.
  ko: 공급자가 하나뿐인 동안에는 Analyst 컴포저의 공급자 컨트롤을 두지 않습니다. 바꿀 수 없는 항목 하나만 보여 주던 자리이고, 네이티브·게이트웨이 모델은 이미 모델 메뉴가 모두 담고 있습니다.
