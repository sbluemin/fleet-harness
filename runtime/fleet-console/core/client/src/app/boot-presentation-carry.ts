import { applyIncomingPresentationCarry } from "../../../../features/remote-access/client/presentation-carry.js";

/**
 * 다른 콘솔에서 건너오며 실려 온 표현 상태를 스토어보다 먼저 적는다. main.tsx의 **첫** import여야 한다 —
 * ES 모듈은 import 순서대로 평가되고, 스토어는 평가 시점에 저장소를 읽기 때문이다.
 */
applyIncomingPresentationCarry();
