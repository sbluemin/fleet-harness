---
section: Fixed
---

- [fleet-console] Fix the packaged desktop app crashing before its window appears by keeping the file protocol privilege the shell needs to load its entry page from the app archive.
  ko: 셸이 앱 아카이브에서 엔트리 페이지를 로드하는 데 필요한 file 프로토콜 권한을 유지해, 패키징된 데스크톱 앱이 창이 뜨기 전에 죽던 문제를 수정했습니다.
- [fleet-console] Fix desktop console runtime installation failing on launch by putting the bundled Node on PATH so npm lifecycle scripts can run.
  ko: 번들 Node를 PATH에 추가해 npm 수명주기 스크립트가 실행되도록 하여, 실행 시 데스크톱 콘솔 런타임 설치가 실패하던 문제를 수정했습니다.
- [fleet-console] Record the real cause of desktop startup and console procurement failures to the desktop log for diagnosis.
  ko: 데스크톱 시작 및 콘솔 조달 실패의 실제 원인을 진단용 데스크톱 로그에 기록합니다.
