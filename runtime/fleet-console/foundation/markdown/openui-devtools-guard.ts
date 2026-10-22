// react-lang 평가 전에 자동 장착을 막는다. 개발 번들의 devtools import는 호스트의 alias 스텁으로도 차단한다.
(globalThis as Record<symbol, unknown>)[Symbol.for("openui.devtools.autoMount")] = true;
