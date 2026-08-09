---
branch: durable-pairing
---

### fleet-console
#### Added
- A device that opens this console with an access link is now paired with it for good. The link is still spent on first use, but the pairing it creates outlives the connection: taking control back, an idle timeout, and restarting the console all end the session while the device keeps its way in, and it reconnects on its own without asking for another link. Removing the device ends that, and so does this console taking a new certificate - which it does when you rotate its identity or move it to a different bind address. A device that has not opened this console for about a year needs a fresh link.
  ko: 액세스 링크로 이 Console을 연 기기는 이제 계속 페어링된 상태로 남습니다. 링크 자체는 여전히 처음 한 번만 쓰이지만, 그 링크가 만든 페어링은 접속보다 오래 삽니다 — 제어권 회수, 유휴 만료, Console 재시작은 모두 접속만 끝내고 기기는 들어올 길을 그대로 가지며, 링크를 다시 받지 않고 스스로 다시 붙습니다. 그 길을 끊는 것은 기기 삭제, 그리고 이 Console이 새 인증서를 갖는 경우입니다 — 신원을 갱신하거나 수신 주소를 옮기면 그렇게 됩니다. 약 1년 동안 이 Console을 한 번도 열지 않은 기기는 새 링크를 받아야 합니다.
- Settings now lists the devices paired with this console, showing which one is connected right now, with two separate actions: disconnect ends the current connection and leaves the device paired, remove revokes the pairing so that device needs a new link.
  ko: 설정이 이제 이 Console에 페어링된 기기 목록을 보여 주며, 지금 접속 중인 기기가 어느 것인지 함께 표시합니다. 동작은 둘로 갈립니다 — 연결 끊기는 현재 접속만 끝내고 페어링은 남기며, 삭제는 페어링을 회수해 그 기기가 새 링크를 받아야 하게 합니다.

### fleet-desktop
#### Added
- A saved console reopens without a fresh access link. The link is spent the first time, and afterwards the window reconnects on its own, so a console that took control back, went idle, or restarted is reachable again from the host list. A new link is needed when the console removed this device, when it took a new certificate, or when this device has stayed away from it for about a year.
  ko: 저장된 Console을 다시 열 때 새 액세스 링크가 필요하지 않습니다. 링크는 처음 한 번만 쓰이고 이후에는 창이 스스로 다시 접속하므로, 제어권을 회수했거나 유휴로 끊겼거나 재시작한 Console도 호스트 목록에서 그대로 다시 열립니다. 새 링크가 필요한 경우는 그 Console이 이 기기를 삭제했을 때, 새 인증서를 갖게 됐을 때, 그리고 이 기기가 약 1년 동안 그 Console을 열지 않았을 때입니다.
