---
branch: todo-plugin
---

### fleet-console
#### Added
- Added a To-do surface: items with steps that form a recipe (a dependency graph), each run by a Chef Operation. Cook asks the Chef to plan, Start tells it to proceed, and it delegates steps to named assignee sessions when it sees fit; the person reviews and completes the item. While the Chef works you can still add steps and edit the note, then press Steer to have it re-read the item and fit the new steps into the recipe; images attached to the note reach the Chef as files it can open. The Operations of one item act as one unit in the sidebar and canvas. Open it with Cmd+Shift+Y (Ctrl+Shift+Y on Windows and Linux) and drag items to reorder them.
  ko: 「할 일」 표면을 추가했습니다. 항목의 단계들이 레시피(의존 그래프)를 이루고, 항목마다 셰프 Operation이 이를 진행합니다. 「쿠킹」은 셰프에게 계획을, 「시작」은 진행을 맡기며, 셰프는 필요하면 단계를 이름 붙은 담당 세션에 위임하고, 검토와 완료는 사람이 합니다. 셰프가 일하는 동안에도 단계를 더하고 메모를 고친 뒤 「스티어링」을 누르면, 셰프가 항목을 다시 읽고 새 단계를 레시피에 배치합니다. 메모에 붙인 이미지는 셰프가 파일로 열어 볼 수 있습니다. 한 항목의 Operation들은 사이드바와 캔버스에서 한 단위로 움직입니다. Cmd+Shift+Y(Windows·Linux는 Ctrl+Shift+Y)로 열고, 항목을 끌어 순서를 바꿀 수 있습니다.
