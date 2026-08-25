---
branch: settings-refit
---

### fleet-console
#### Changed
- Group Settings by what each section does rather than which plugin owns it, and add a search box that finds any setting by name or by a related word such as "dormant" or "pairing".
  ko: 설정을 소유 플러그인이 아니라 하는 일 기준으로 묶고, 이름이나 "dormant"·"pairing" 같은 관련어로 어떤 설정이든 찾는 검색을 더했습니다.
- Show all four themes as cards at once, including in the light theme, and preview the console beside them so a theme, liquid glass, and the interface font size can be judged where they are chosen.
  ko: 라이트 테마에서도 네 테마를 카드로 함께 보여 주고, 옆의 축소판 콘솔로 테마·리퀴드 글래스·인터페이스 글자 크기를 고르는 자리에서 바로 확인할 수 있습니다.
- Say on/off with one switch and either/or with one segmented control everywhere in Settings, and replace the repeated "stored server-side" sentences with a chip on each row that states when the setting takes effect.
  ko: 설정 전체에서 켬/끔은 스위치 하나로, 택일은 분절 버튼 하나로 말하고, 되풀이되던 "서버에 저장됩니다" 문장을 줄마다 적용 시점을 밝히는 칩으로 바꿨습니다.

#### Fixed
- Correct the Console port and display language rows, which shared one note claiming changes apply to new sessions even though the language repaints the Console at once and the port waits for a console restart.
  ko: 콘솔 포트와 표시 언어가 공유하던 "새 세션에 적용" 각주를 바로잡았습니다. 언어는 즉시 다시 칠해지고 포트는 콘솔 재시작을 기다립니다.
- Keep the Settings section list readable below 1120px, where it previously reflowed into a ragged grid that buried its group headings among the sections.
  ko: 1120px 미만에서 들쭉날쭉한 격자로 풀리며 그룹 머리글이 섹션 사이에 묻히던 설정 목록을 정돈했습니다.
