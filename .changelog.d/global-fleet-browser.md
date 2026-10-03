---
branch: global-fleet-browser
---

### fleet-console
#### Added
- Add a Console-wide Fleet Browser floating sheet accessible via the toolbar and Mod+Shift+B, open external links into it with unified modifier gestures, and offer restoring closed tabs after reconnection.
  ko: 도구모음과 Mod+Shift+B로 열 수 있는 전역 Fleet 브라우저 떠 있는 시트를 추가하고, 통일된 수정키로 외부 링크를 열며, 재연결 시 닫힌 탭 복구 제안을 지원합니다.
#### Changed
- Clarify the companion browser in each Operation as the Operation Browser, distinguishing it from the person-facing Fleet Browser while preserving the fleet-browser MCP server identifier for agent compatibility.
  ko: 에이전트 호환성을 위해 fleet-browser MCP 서버 식별자는 유지하면서, 사람용 전역 Fleet 브라우저와 구분되도록 각 Operation의 companion 브라우저 명칭을 Operation 브라우저로 정리합니다.

### fleet-desktop
#### Added
- Forward registered Console keyboard shortcuts from native browser views so navigation shortcuts work while browsing.
  ko: 네이티브 브라우저 뷰에 포커스가 있을 때도 등록된 Console 단축키를 중계하여 키보드 탐색을 유지합니다.
