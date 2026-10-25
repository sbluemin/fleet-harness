---
branch: feat/commodore-theater-add
---

### fleet-console
#### Changed
- Commodores can work across multiple Theaters, share a Theater, and keep their own system prompt and subagent settings. New objectives use the Commodore's workspace while ordinary sessions stay in the Theater you choose.
  ko: 사령관에 여러 Theater를 추가하거나 같은 Theater를 함께 사용할 수 있으며, 시스템 프롬프트와 서브에이전트 설정은 사령관마다 관리합니다. 새 목표는 사령관의 작업 공간을 사용하고 일반 세션은 선택한 Theater에서 실행됩니다.
#### Breaking Changes
- After using empty, multiple, or shared Theater assignments, downgrading to an older Console may hide affected Commodores and their boards until you upgrade again; their files remain on disk.
  ko: Theater가 없거나 여러 개이거나 다른 사령관과 공유하는 구성을 사용한 뒤 구버전 Console로 돌아가면 해당 사령관과 보드가 다시 업그레이드할 때까지 보이지 않을 수 있으며, 파일은 디스크에 남습니다.
