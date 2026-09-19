---
branch: desktop-auto-update
---

### fleet-desktop
#### Added
- Fleet Desktop now updates itself instead of sending you to the GitHub release page. It checks for a new version on its own, and the download starts only when you ask for it - nothing is fetched in the background and nothing restarts until you press Restart. When Console also has an update waiting, that one restart installs both. Windows still shows a publisher warning on the first manual install, and Linux is not covered.
  ko: Fleet Desktop이 GitHub 릴리스 페이지로 내보내는 대신 스스로 업데이트합니다. 새 버전은 앱이 알아서 확인하고, 내려받기는 눌렀을 때만 시작합니다 — 배경에서 미리 받지 않으며 다시 시작을 누르기 전에는 아무것도 재시작하지 않습니다. Console 업데이트가 함께 밀려 있으면 그 한 번의 재시작이 둘을 함께 설치합니다. Windows는 처음 직접 설치할 때 게시자 경고가 그대로 뜨고, Linux는 대상이 아닙니다.
#### Removed
- The app no longer interrupts you with a native update dialog or a tray balloon. New versions are announced inside Console instead.
  ko: 네이티브 업데이트 대화상자와 트레이 풍선으로 작업을 끊지 않습니다. 새 버전은 Console 안에서 알립니다.

### fleet-console
#### Added
- Console now tells you in the window when a Console or Desktop update is out, with what it means for your session and a link to the release notes. Closing the notice keeps it from returning for that version; the mark on the help button stays until you update. The help menu's Desktop row acts on the update instead of opening GitHub.
  ko: Console·Desktop 업데이트가 나오면 창 안에서 알려 줍니다 — 내 작업이 어떻게 되는지와 릴리스 노트로 가는 줄이 함께 섭니다. 알림을 닫으면 그 버전으로는 다시 뜨지 않고, 도움말 버튼의 표식은 업데이트할 때까지 남습니다. 도움말 메뉴의 Desktop 행은 GitHub를 여는 대신 그 자리에서 업데이트를 수행합니다.
