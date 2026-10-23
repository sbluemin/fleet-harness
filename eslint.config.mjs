// `pnpm check:rules-of-hooks`(= `eslint runtime`)가 쓰는 설정이다. CI 는 core-boundary.yml 에서 돌린다.
// rules-of-hooks 외 규칙 추가 금지: 이 린터는 #1760(조건부 훅 호출로 화면이 비던 크래시) 같은 훅 순서 버그만
// 기계적으로 막으려고 들였다. 스타일·품질 규칙으로 넓히지 않는다.
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

// 검사 범위: 브라우저에서 React 로 렌더되는 TS/TSX 만. 서버·노드 코드에는 훅이 아닌 `use*()` 가 있고(예:
// console-use 의 useScope), 테스트도 오탐을 내므로 뺀다.
const FILES = [
  "runtime/fleet-console/**/client/**/*.{ts,tsx}", // core/client + features/*/client
  "runtime/fleet-console/sdk/**/*.{ts,tsx}", // 플러그인에 공개되는 React 컴포넌트·훅
  "runtime/fleet-console/foundation/**/*.tsx", // foundation 의 브라우저 표면(font-picker/browser.tsx 등)
];
const IGNORES = [
  "**/node_modules/**",
  "**/dist/**",
  "**/tests/**",
  "**/*.test.{ts,tsx}",
  "**/*.spec.{ts,tsx}",
  "**/*.d.ts",
  "**/*.generated.ts",
];

export default [
  // eslint 기본 대상(**/*.js, *.mjs, *.cjs)은 범위 밖이다.
  { ignores: [...IGNORES, "**/*.{js,mjs,cjs,jsx}"] },
  {
    files: FILES,
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: "module" },
    },
    // react-hooks 를 등록해 두면 기존 `react-hooks/exhaustive-deps` disable 주석도 해석된다(규칙은 꺼진 상태).
    plugins: { "react-hooks": reactHooks },
    // 남은 exhaustive-deps disable 주석은 그대로 둔다 — unused 보고를 끈다.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: { "react-hooks/rules-of-hooks": "error" },
  },
];
