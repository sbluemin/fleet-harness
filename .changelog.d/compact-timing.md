---
branch: compact-timing
---

### fleet-console
#### Added
- Settings > AI Gateway now has Compact timing (Auto / Early / Late / Custom) so a gateway session auto-compacts at a chosen share of each model's catalog window.
  ko: Settings → AI Gateway에 Compact timing(Auto / Early / Late / Custom)을 두어 게이트웨이 세션이 각 모델 카탈로그 창의 선택한 비율에서 자동 압축되게 합니다.

### fleet-cli
#### Added
- The AI Gateway honors Compact timing from Settings so Claude Code auto-compacts at Auto (window minus 16k), Early (88%), Late (97%), or a Custom 70-99 percent of each model window.
  ko: AI Gateway가 Settings의 Compact timing을 따라 Claude Code가 Auto(창 빼기 16k), Early(88%), Late(97%), 또는 Custom 70–99%에서 자동 압축되게 합니다.
