---
branch: durable-pairing
---

### fleet-console
#### Added
- A device that opens this console with an access link is now paired with it for good. The link is still spent on first use, but the pairing it creates outlives the connection: taking control back, an idle timeout, and restarting the console all end the session while the device keeps its way in, and it reconnects on its own without asking for another link. Only removing the device, or rotating this console's identity, ends that.
  ko: 액세스 링크로 이 Console을 연 기기는 이제 계속 페어링된 상태로 남습니다. 링크 자체는 여전히 처음 한 번만 쓰이지만, 그 링크가 만든 페어링은 접속보다 오래 삽니다 — 제어권 회수, 유휴 만료, Console 재시작은 모두 접속만 끝내고 기기는 들어올 길을 그대로 가지며, 링크를 다시 받지 않고 스스로 다시 붙습니다. 그 길을 끊는 것은 기기 삭제와 이 Console의 신원 갱신뿐입니다.
- Settings now lists the devices paired with this console, showing which one is connected right now, with two separate actions: disconnect ends the current connection and leaves the device paired, remove revokes the pairing so that device needs a new link.
  ko: 설정이 이제 이 Console에 페어링된 기기 목록을 보여 주며, 지금 접속 중인 기기가 어느 것인지 함께 표시합니다. 동작은 둘로 갈립니다 — 연결 끊기는 현재 접속만 끝내고 페어링은 남기며, 삭제는 페어링을 회수해 그 기기가 새 링크를 받아야 하게 합니다.
