coding-agent 모델 사이클링 — scoped-models 제거 이후 스코프 노트

@sbluemin/fleet-coding-agent의 모델 관리 방식이 전용 'scoped-models' UI 제거를 통해 단순화되었습니다.
- 활성 모델 풀은 시작 시 '--models' CLI 플래그를 통해 정의됩니다.
- 사용자는 'Ctrl+P'(다음) 및 'Shift+Ctrl+P'(이전)를 사용하여 사용 가능한 풀을 사이클링합니다.
- '/model' 슬래시 명령을 통해 직접 선택이 가능합니다.
- 인터랙티브한 세션별 재정렬이나 영구적인 서브셋 설정(레거시 'scoped-models')은 복잡성 감소를 위해 명시적으로 스코프에서 제외되고 제거되었습니다.