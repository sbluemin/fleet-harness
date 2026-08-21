---
branch: launch-prompt-multiline-shim
---

### fleet-console
#### Fixed
- Deliver the whole multi-line Quick Launch prompt on Windows installs that run the agent CLI through a `.cmd` shim, instead of only its first line.
  ko: `.cmd` shim으로 에이전트 CLI를 실행하는 Windows 설치에서 여러 줄 Quick Launch 프롬프트를 첫 줄만이 아니라 전문 그대로 전달합니다.
