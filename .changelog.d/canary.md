### fleet-console
#### Fixed
- Console no longer fails to start when two commodores share a Theater that held objectives from an older Console: those objectives move to one commodore only, and a Console already stuck this way starts again.
  ko: 이전 Console의 목표가 있던 Theater를 두 사령관이 함께 두어도 Console이 더 이상 기동에 실패하지 않습니다. 그 목표는 한 사령관에게만 옮겨지고, 이미 이 문제로 멈춘 Console도 다시 기동합니다.

#### Changed
- Once an older Console's objectives have moved to a commodore, Console removes their old copies; objectives it could not move are kept.
  ko: 이전 Console의 목표가 사령관에게 옮겨지면 Console이 옛 사본을 지웁니다. 옮기지 못한 목표는 그대로 남깁니다.
