---
branch: remote-nat-endpoint
---

### fleet-console
#### Added
- Open Remote access on the local network by default, with an optional public hostname and NAT route that must be enabled and acknowledged explicitly.
  ko: Remote access를 기본적으로 LAN에 열고, 공개 호스트 이름과 NAT 경로는 명시적으로 켜고 확인하는 선택 사항으로 설정할 수 있습니다.
- Edit the remote endpoint as a draft and apply it deliberately. Choosing an interface, changing a port mode, or turning the public endpoint on no longer touches a running listener; Start listening, Save for later, Apply changes, and Stop listening are the only actions that save.
  ko: 원격 엔드포인트를 초안으로 편집한 뒤 명시적으로 적용합니다. 인터페이스 선택, 포트 모드 변경, 공개 엔드포인트 켜기는 더 이상 실행 중인 리스너를 건드리지 않으며, 수신 시작·나중을 위해 저장·변경 사항 적용·수신 중지만 저장을 수행합니다.
- Say what applying a change costs before it happens: a listener restart keeps paired devices, while any change to the address devices trust disconnects sessions, revokes unused access links, and unpairs every device.
  ko: 적용이 무엇을 잃게 하는지 먼저 알립니다. 리스너 재시작은 페어링된 기기를 유지하지만, 기기가 신뢰하던 주소가 바뀌면 세션이 끊기고 사용하지 않은 액세스 링크가 취소되며 모든 기기의 페어링이 해제됩니다.
- Show the connection route once, and only once every required value is valid, so an incomplete endpoint reads as a named requirement instead of a placeholder hostname.
  ko: 연결 경로를 한 곳에서만, 그리고 필요한 값이 모두 유효해진 뒤에만 보여 주므로 미완성 엔드포인트는 자리표시자 호스트 이름 대신 부족한 항목으로 읽힙니다.
