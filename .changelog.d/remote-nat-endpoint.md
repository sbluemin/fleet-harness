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
- Spell the router rule out in the fields a router actually asks for - external port, internal IP address, internal port - and say so when the external and internal ports differ, because entering the public port on both sides forwards to a socket nothing is listening on.
  ko: 라우터가 실제로 묻는 칸 그대로 외부 포트·내부 IP 주소·내부 포트를 제시하고, 외부 포트와 내부 포트가 다를 때는 그 사실을 짚어 줍니다. 공개 포트를 양쪽에 똑같이 넣으면 아무것도 듣지 않는 자리로 전달되기 때문입니다.
- Leave pairing as the only thing a remote listener answers without a session. Pairing happens in the Fleet Console apps, which check this console's certificate fingerprint, so the listener no longer serves a browser-facing page explaining that.
  ko: 원격 리스너가 세션 없이 응답하는 것은 페어링 하나뿐입니다. 페어링은 이 콘솔의 인증서 지문을 대조할 수 있는 Fleet Console 앱에서만 이루어지므로, 그 사실을 설명하던 브라우저용 페이지는 더 이상 제공하지 않습니다.
- Spend a failure budget on that pairing door so a public endpoint cannot be hammered for free, and report the rejected attempts in Settings instead of counting them silently. A successful pairing clears its source's budget, so a device that connects is never punished for someone else's noise.
  ko: 공개 엔드포인트가 값 없이 두들겨지지 않도록 페어링 문에 실패 예산을 두고, 거절한 시도를 조용히 세는 대신 설정에 알립니다. 페어링에 성공하면 그 출처의 예산이 지워지므로, 접속에 성공한 기기가 다른 곳의 소음 때문에 막히지 않습니다.
- Keep the listener's own settings on the owner's side. A paired device can operate this console, but it cannot rewrite the address that console publishes, and a public hostname that no device could reach - a loopback or wildcard address - is refused the same way a listen address already was.
  ko: 리스너 자신의 설정은 소유자 쪽에 둡니다. 페어링된 기기는 이 콘솔을 조작할 수 있지만 콘솔이 공표하는 주소를 바꿀 수는 없으며, 어떤 기기도 닿을 수 없는 공개 호스트 이름(루프백·와일드카드)은 수신 주소와 똑같이 거부합니다.
