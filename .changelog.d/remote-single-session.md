---
branch: remote-single-session
---

### fleet-console
#### Changed
- A console keeps one remote connection at a time and hands that seat to the device that joined last, instead of turning a device away because another one is still connected. The device that had the seat is disconnected and told that another device connected, rather than that its control was taken back, and it keeps its pairing, so it takes the seat back by simply joining again. Nothing changes on the machine itself: the same notice names whoever is connected and still offers to take control back or keep watching.
  ko: 콘솔은 원격 접속을 한 번에 하나만 유지하며, 그 자리는 가장 마지막에 접속한 기기가 가져갑니다. 다른 기기가 붙어 있다는 이유로 접속을 거절하지 않습니다. 자리를 내준 기기는 접속이 끊기면서 제어권을 회수당했다는 안내 대신 다른 기기가 접속했다는 안내를 받고, 페어링은 그대로 남아 다시 접속하기만 하면 자리를 되찾습니다. 이 기계 쪽은 그대로입니다. 누가 접속했는지 알리는 같은 안내가 뜨고, 제어권을 가져올지 계속 지켜볼지도 그대로 고를 수 있습니다.
