---
branch: feat/model-roster-ssot
---

### fleet-console
#### Changed
- Every model picker in Console now offers exactly the models you turn on in Settings > AI Gateway, including Claude, and updates in every open window when that list changes. After the update, Opus, Sonnet and Fable are turned on once for installs whose list had no Claude model; turn them off in AI Gateway if you don't want them.
  ko: Console의 모든 모델 선택기는 이제 Settings › AI Gateway에서 켠 모델(Claude 포함)만 보여 주고, 목록이 바뀌면 열려 있는 모든 창에 바로 반영됩니다. 업데이트 후 목록에 Claude 모델이 없던 설치에는 Opus, Sonnet, Fable이 한 번 켜지며, 원하지 않으면 AI Gateway에서 끄면 됩니다.
- Model and effort choices in Settings (Cowork, Session Analyst, the Commodore's default, Scuttlebutt aides and AI Gateway routing) and in the Commodore drawer now use the same picker as the Objectives Commander and members, sit in their rows as a plain value instead of a boxed button, and offer each model's full effort range instead of only Low, Medium and High. Picking an effort confirms the choice in one step and saves it once, in Settings and Objectives alike.
  ko: Settings의 모델·강도 선택(Cowork, Session Analyst, 사령관 기본값, Scuttlebutt 부관, AI Gateway 라우팅)과 사령관 서랍이 Objectives 지휘관·구성원과 같은 선택기를 쓰며, 상자형 단추가 아니라 행의 값처럼 보이고, Low·Medium·High만이 아니라 모델이 지원하는 강도를 모두 고를 수 있습니다. 강도를 한 번 고르면 설정과 Objectives 모두 곧바로 확정되고 저장도 한 번만 일어납니다.
- A saved model that you later turn off stays selected and is marked as off, while runs use Sonnet until you turn it back on; with no models turned on, launches run on Sonnet and say so with a link to AI Gateway.
  ko: 저장해 둔 모델을 나중에 끄면 선택은 그대로 남고 「꺼짐」으로 표시되며, 다시 켤 때까지 실행은 Sonnet으로 이뤄집니다. 켜진 모델이 하나도 없으면 실행은 Sonnet으로 진행되고, 그 사실과 AI Gateway로 가는 링크가 함께 표시됩니다.
