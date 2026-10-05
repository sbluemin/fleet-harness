---
branch: feat/model-roster-ssot
---

### fleet-console
#### Changed
- Every model picker in Console now offers exactly the models you turn on in Settings > AI Gateway, including Claude, and updates in every open window when that list changes. If you never chose AI Gateway models, Opus, Sonnet and Fable start turned on; if you already chose a list without Claude, turn Claude on there to keep seeing it.
  ko: Console의 모든 모델 선택기는 이제 Settings › AI Gateway에서 켠 모델(Claude 포함)만 보여 주고, 목록이 바뀌면 열려 있는 모든 창에 바로 반영됩니다. AI Gateway 모델을 고른 적이 없다면 Opus, Sonnet, Fable이 켜진 상태로 시작합니다. Claude 없이 목록을 이미 골라 두었다면, 계속 보려면 그곳에서 Claude를 켜세요.
- Model and effort choices in Settings (Cowork, Session Analyst, the Commodore's default, Scuttlebutt aides and AI Gateway routing) now use the same picker as the Objectives Commander and members, and offer each model's full effort range instead of only Low, Medium and High.
  ko: Settings의 모델·강도 선택(Cowork, Session Analyst, 사령관 기본값, Scuttlebutt 부관, AI Gateway 라우팅)이 Objectives 지휘관·구성원과 같은 선택기를 쓰며, Low·Medium·High만이 아니라 모델이 지원하는 강도를 모두 고를 수 있습니다.
- A saved model that you later turn off stays selected and is marked as off, while runs use Sonnet until you turn it back on; with no models turned on, launches run on Sonnet and say so with a link to AI Gateway.
  ko: 저장해 둔 모델을 나중에 끄면 선택은 그대로 남고 「꺼짐」으로 표시되며, 다시 켤 때까지 실행은 Sonnet으로 이뤄집니다. 켜진 모델이 하나도 없으면 실행은 Sonnet으로 진행되고, 그 사실과 AI Gateway로 가는 링크가 함께 표시됩니다.
