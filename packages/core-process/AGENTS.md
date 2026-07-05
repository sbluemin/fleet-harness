# core-process

leaf 패키지 — 워크스페이스 의존 0, Node 표준 라이브러리(`child_process`/`fs`/`path`)만 사용.

Fleet-domain-agnostic — carrier/admiral/fleet 도메인 어휘 금지.

## Owns

- Windows PATH/PATHEXT 탐색 + `.cmd`/`.bat` shim의 cmd.exe 래핑 SSoT.
- `withHidden(options)`는 콘솔 없는 호스트에서 자식 프로세스 CMD/콘솔 창을 은닉하는 크로스플랫폼 spawn 옵션 정규화 헬퍼(Windows 외 플랫폼에서도 무해).

## Boundaries

- `@dotobokuri/*` 워크스페이스 패키지를 절대 의존하지 않는다(`dependencies` 및 소스 모두).
- Node 표준 라이브러리(`child_process`, `fs`, `path`, `os`, `node:*`) 외 외부 패키지 도입 금지.
- 단일 root 배럴(`src/index.ts`)만 노출.
