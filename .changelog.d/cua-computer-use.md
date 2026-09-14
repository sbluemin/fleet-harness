---
branch: cua-computer-use
---

### fleet-console
#### Added
- Choose Cua Driver or SkyComputerUse in Computer Use settings, with SkyComputerUse remaining the default. Changing backends stops current use and requires enabling the feature again.
  ko: 컴퓨터 사용 설정에서 Cua Driver 또는 SkyComputerUse를 선택할 수 있으며, 기본값은 SkyComputerUse로 유지됩니다. 백엔드를 바꾸면 현재 사용을 중지하며 기능을 다시 켜야 합니다.
- Reduce repeated app observations with Cua Driver by limiting the returned tree, reusing element handles on unchanged screens, and checking specific conditions without a full tree.
  ko: Cua Driver에서 반환할 트리 범위를 제한하고 바뀌지 않은 화면의 요소 핸들을 재사용하며 전체 트리 없이 특정 조건을 검증해 반복 관측을 줄입니다.
