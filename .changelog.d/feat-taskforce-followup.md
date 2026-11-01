---
branch: feat/taskforce-followup
---

### fleet-console
#### Changed
- TaskForce is now an experiment: turn it on in Settings > Experiments to see TaskForces and create new ones. Your existing TaskForces are kept and come back when you turn it on.
  ko: TaskForce는 이제 실험 기능입니다. 설정 › 실험 기능에서 켜면 TaskForce가 보이고 새로 만들 수 있으며, 기존 TaskForce는 그대로 남아 켜면 다시 나타납니다.
- TaskForce chats now use the same composer as Commodore chats, so you can mention members with @ and attach images, and the Quota summary appears above it.
  ko: TaskForce 대화도 사령관 대화와 같은 입력창을 써서 @로 멤버를 지목하고 이미지를 첨부할 수 있으며, 그 위에 Quota 요약이 보입니다.
- TaskForces sit in the Commodore list like Commodores: drag them into order or into your sections, right-click to delete, and see members as a compact avatar grid.
  ko: TaskForce가 사령관 목록에 사령관처럼 놓여 드래그로 순서와 섹션을 정하고 우클릭으로 삭제하며, 멤버는 작은 아바타 그리드로 보입니다.
- The TaskForce side panel is simpler: a Members tab where clicking a member opens their 1:1 chat, and a topic you edit like a Commodore description.
  ko: TaskForce 우측 패널이 단순해져 멤버 탭에서 멤버를 누르면 1:1 대화로 가고, 주제는 사령관 설명처럼 편집합니다.
- The right sidebar stays open or closed as you move between Commodore chats and TaskForces.
  ko: 사령관 대화와 TaskForce를 오가도 우측 사이드바가 열림·닫힘 상태를 그대로 유지합니다.

#### Fixed
- TaskForce members now see what other members said, even when they were answering at the same time, so they can build on each other's replies.
  ko: TaskForce 멤버가 같은 때 답하던 다른 멤버의 말도 받아 서로의 답을 이어 대화합니다.

#### Removed
- TaskForces no longer have a finished state or a finish/reopen action; delete a TaskForce when you are done. Previously finished TaskForces reopen as ordinary ones.
  ko: TaskForce에서 마침 상태와 주제 마치기·다시 열기가 없어졌습니다. 다 쓰면 삭제하면 되며, 이전에 마친 TaskForce는 일반 TaskForce로 다시 열립니다.
