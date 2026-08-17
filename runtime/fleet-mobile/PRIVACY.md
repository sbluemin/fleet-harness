# Privacy Policy — Fleet Console mobile app

_Last updated: 2026-08-18_

Fleet Console for iPhone, iPad, and Android is a client for a **Fleet Console you run yourself**, on
your own machine. It is not a hosted service. There is no Fleet account, and we operate no server the
app talks to.

## What we collect

Nothing. The app contains no analytics, no crash reporting, no advertising, and no telemetry of any
kind, and it sends us no data.

One exception is not ours to make. While the app is distributed as a beta through **TestFlight** or
**Firebase App Distribution**, Apple and Google give us the tester list — the email address you used
to accept the invitation — along with any crash report or feedback **you choose to send** through
their tools. That collection is theirs, and it is governed by
[Apple's](https://www.apple.com/legal/privacy/) and [Google's](https://policies.google.com/privacy)
privacy policies.

## What stays on your device

Pairing is kept in app-private storage and never leaves the device:

- the address of each Console you paired with, the access grant it issued, and the TLS certificate
  pinned for it
- cookies your Console sets in its own web interface

Removing a paired Console in the app, or deleting the app, removes them.

## What leaves your device

Only traffic to the Fleet Console you paired with. The app opens no other connection of its own.

Your Console's web interface is rendered in a web view, so pages it serves load whatever those pages
reference — that content is under your Console's control, not ours.

## Permissions

- **Camera** — used only to read a Console access link from a QR code. Frames are not stored and are
  not transmitted.
- **Local network** (iOS) — used only to reach a Console running on your own network.

## Children

The app is a developer tool and is not directed at children.

## Changes

Changes to this policy are published in this file. Its full history is public in the repository.

## Contact

Questions about this policy: open an issue at <https://github.com/sbluemin/fleet-harness/issues>.

---

# 개인정보 처리방침 — Fleet Console 모바일 앱

_최종 수정: 2026-08-18_

iPhone·iPad·Android용 Fleet Console은 **사용자가 직접 실행하는 Fleet Console**에 접속하는
클라이언트입니다. 저희가 운영하는 서비스가 아니며, Fleet 계정도 없고, 앱이 접속하는 저희 서버도
없습니다.

## 수집하는 정보

없습니다. 앱에는 분석 도구, 크래시 리포팅, 광고, 그 어떤 형태의 텔레메트리도 들어 있지 않으며,
저희에게 데이터를 보내지 않습니다.

한 가지 예외는 저희가 정하는 것이 아닙니다. 앱이 **TestFlight** 또는 **Firebase App
Distribution**으로 베타 배포되는 동안, Apple과 Google은 테스터 목록(초대를 수락할 때 사용한 이메일
주소)과 **사용자가 직접 보내기로 선택한** 크래시 리포트·피드백을 저희에게 전달합니다. 이 수집은
Apple과 Google의 것이며 각사의
[Apple](https://www.apple.com/legal/privacy/) · [Google](https://policies.google.com/privacy)
개인정보 처리방침을 따릅니다.

## 기기에만 남는 정보

페어링 정보는 앱 전용 저장소에 보관되며 기기를 벗어나지 않습니다.

- 페어링한 각 Console의 주소, 그 Console이 발급한 접속 권한, 그리고 그 Console에 고정한 TLS 인증서
- Console 웹 인터페이스가 설정한 쿠키

앱에서 해당 Console을 제거하거나 앱을 삭제하면 함께 사라집니다.

## 기기를 떠나는 정보

페어링한 Fleet Console과 주고받는 통신뿐입니다. 앱이 스스로 여는 다른 연결은 없습니다.

Console의 웹 인터페이스는 웹 뷰로 표시되므로, 그 페이지가 참조하는 것은 함께 불러옵니다. 그 내용은
저희가 아니라 사용자의 Console이 결정합니다.

## 권한

- **카메라** — QR 코드에서 Console 접속 링크를 읽을 때만 사용합니다. 촬영된 프레임은 저장하지도,
  전송하지도 않습니다.
- **로컬 네트워크**(iOS) — 사용자의 네트워크에서 실행 중인 Console에 접속할 때만 사용합니다.

## 아동

이 앱은 개발자 도구이며 아동을 대상으로 하지 않습니다.

## 변경

이 방침의 변경은 이 파일에 반영되며, 전체 이력은 저장소에 공개되어 있습니다.

## 문의

<https://github.com/sbluemin/fleet-harness/issues> 에 이슈로 남겨 주세요.
