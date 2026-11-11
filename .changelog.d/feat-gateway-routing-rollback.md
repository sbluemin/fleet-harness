---
branch: feat/gateway-routing-rollback
---

### fleet-console
#### Changed
- AI Gateway routing chooses each Commander's and each member's model again, using the Commodore's or the Commander's own model and effort to decide; there is no separate routing model to set. A model you set yourself always wins, and a Commodore or Commander can still name one of the models you turned on.
  ko: 이제 AI Gateway 라우팅이 다시 지휘관 모델과 구성원 모델을 고릅니다. 판단은 사령관 또는 지휘관의 모델과 강도로 하며, 라우팅용 모델을 따로 설정하지 않습니다. 직접 정한 모델이 항상 우선이고, 사령관·지휘관은 켠 모델 가운데 하나를 지정할 수도 있습니다.

#### Fixed
- A Commodore can start a Commander even when every model you turned on is close to its limit. If routing cannot decide, the model with the most quota headroom is used, and when all are near their limits, the one with the most quota left.
  ko: 켠 모델이 모두 한도에 가까워도 사령관이 지휘관을 시작할 수 있습니다. 라우팅이 정하지 못하면 쿼터 여유가 가장 큰 모델을, 모두 한도에 가까우면 남은 쿼터가 가장 많은 모델을 씁니다.
