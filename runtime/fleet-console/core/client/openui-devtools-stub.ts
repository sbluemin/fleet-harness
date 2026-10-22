// 개발 모드에서도 CDN 코드가 Console origin에서 실행되지 않게 devtools를 빈 컴포넌트로 대체한다.
export function OpenUIDevtools(): null { return null; }
