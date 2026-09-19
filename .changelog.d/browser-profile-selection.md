---
branch: browser-profile-selection
---

### fleet-console
#### Added
- The Operation Browser now lets you choose between a temporary session and your own profile from the marker beside the tabs. A temporary session forgets everything when its tabs close; your profile keeps signed-in sites on this computer and is shared by every Operation, so switching to it later brings those logins back. Switching sessions closes the open tabs, and the marker's menu can clear the profile.
  ko: Operation 브라우저에서 탭 옆의 표식으로 임시 세션과 내 프로필 중 하나를 고를 수 있습니다. 임시 세션은 탭을 닫으면 모두 잊고, 내 프로필은 로그인한 사이트를 이 기계에 남겨 모든 Operation이 함께 쓰므로 나중에 다시 고르면 그 로그인이 살아납니다. 세션을 바꾸면 열린 탭은 닫히며, 표식의 메뉴에서 프로필을 비울 수 있습니다.
- Chrome cookie import now goes into whichever session the Operation is using, and the import window says where the cookies will land. Importing into your profile keeps those logins for later. Importing from Chrome is still unavailable on Windows.
  ko: Chrome 쿠키 가져오기가 그 Operation이 쓰고 있는 세션으로 들어가고, 가져오기 창이 쿠키가 어디에 남는지 알려 줍니다. 내 프로필로 가져오면 그 로그인이 다음에도 남습니다. Windows에서는 Chrome 가져오기를 여전히 쓸 수 없습니다.
#### Fixed
- The Chrome profile list in the browser import window no longer spills past the edge of a narrow browser panel.
  ko: 브라우저 가져오기 창의 Chrome 프로필 목록이 좁은 브라우저 패널의 가장자리를 넘어가지 않습니다.
