---
branch: feat/new-session-absorbs-quick-launch
---

### fleet-console
#### Changed
- The new session screen now replaces Quick Launch: Cmd+J and Ctrl+Space open it, and its composer takes `/` commands and `@` destinations.
  ko: 새 세션 화면이 Quick Launch를 대신합니다. ⌘J와 Ctrl+Space로 열고, 컴포저에서 `/` 명령과 `@` 보낼 곳을 고를 수 있습니다.
- The `@` and `/` menus now look and work the same in the new session, Commodore, commander and member, and chat composers, with section titles followed by a divider line as in the former Quick Launch menu.
  ko: 새 세션·사령관·지휘관과 구성원·채팅 입력창의 `@`와 `/` 메뉴가 같은 모습과 동작을 갖게 되었고, 예전 Quick Launch 메뉴처럼 묶음 제목 옆에 구분선이 섭니다.
- The Commodore composer's `@` menu no longer lists archived objectives, and both it and the new session `@` menu show not-started items in their own section.
  ko: 사령관 입력창의 `@` 메뉴에 보관함에 있는 목표가 더 이상 보이지 않고, 사령관과 새 세션의 `@` 메뉴는 시작 전 항목을 별도 묶음으로 나눠 보여 줍니다.
- The new session effort bar keeps MAX and ULTRACODE behind a glyph until you open them.
  ko: 새 세션의 추론 강도 막대는 MAX와 ULTRACODE를 ✦ 글리프 뒤에 두었다가 펼칠 때만 보여 줍니다.
- The new session playground picks up where it left off when you reopen it, with varied entrances, new faces, and a crowd that ebbs and flows.
  ko: 새 세션 놀이터는 다시 열면 이어서 움직이고, 아바타가 여러 방식으로 드나들며 새 얼굴이 나오고 인원이 늘었다 줄었다 합니다.

#### Removed
- Removed the Quick Launch bar, including its pin-to-bottom and mention-the-open-Operation options and the deputy chat lane; `@` a deputy from the new session to get its reply on the deputy's card. Custom key bindings for Quick Launch or the new session return to the defaults, so set them again in Settings if you had changed them.
  ko: Quick Launch 막대를 제거했습니다. 하단 고정과 '열 때 보고 있는 Operation 멘션' 옵션, 부관 대화 칸도 함께 없어졌으며, 부관에게는 새 세션에서 `@`로 보내면 부관 카드에서 답합니다. Quick Launch나 새 세션의 단축키를 바꿔 두었다면 기본값으로 돌아가므로 설정에서 다시 지정해 주세요.
