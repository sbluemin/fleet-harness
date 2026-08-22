---
branch: gateway-capability-class
---

### fleet-cli
#### Fixed
- Read a Cursor Fast variant at its base model's grade and benchmark evidence when picking delegation candidates, so a flagship's priority tier is no longer passed over as a light model.
  ko: 위임 후보를 고를 때 Cursor의 Fast 변형을 기반 모델의 등급과 벤치마크 증거로 읽습니다. 플래그십의 우선 처리 티어가 경량 모델로 밀려나지 않습니다.

### fleet-console
#### Fixed
- Correct the AI Gateway model grades in Settings: a Cursor Fast variant now carries its base model's grade instead of LIGHT, and Composer 2.5 reads as STANDARD on both Cursor and xAI instead of contradicting itself across providers.
  ko: 설정의 AI Gateway 모델 등급을 정정했습니다. Cursor의 Fast 변형은 LIGHT 대신 기반 모델의 등급을 달고, Composer 2.5는 공급자마다 엇갈리던 판정 대신 Cursor와 xAI 양쪽에서 STANDARD로 표시됩니다.
