import { fontDrawsText } from "@fleet-console/font-picker/resolve";

import { waitForTerminalFallbackFonts } from "./terminal-fallback-fonts.js";
import { BUNDLED_CJK_FALLBACK_FAMILY } from "./terminal-preferences.js";

/* 폴백 후보가 실제로 그릴 수 있는 문자 계열. 하나의 "CJK" 플래그로 뭉치지 않는 이유는 커버리지가
   계열마다 갈리기 때문이다 — 한글만 있는 서체를 일본어 사용자에게 권하면 아무것도 고치지 못한다. */
export type CjkScript = "hangul" | "kana" | "han";

export const CJK_SCRIPTS: readonly CjkScript[] = ["hangul", "kana", "han"];

const CJK_SCRIPT_PROBES: Readonly<Record<CjkScript, string>> = {
  hangul: "한글",
  kana: "かなカナ",
  han: "漢字",
};

/* 기준선을 번들 서체로 잡는다 — 기본 기준선(OS 폴백)을 쓰면 후보가 마침 그 계열의 OS 폴백 서체일 때
   (macOS 한글의 Apple SD Gothic Neo) 같은 픽셀이 나와 "글리프 없음"으로 오판한다. 번들 서체를
   기준선으로 두면 그 오판은 두 부류로만 좁혀지고 둘 다 무해하다: 번들 서체 자신(이미 자동 항목으로
   제공된다)과, 가나·한자에 한해 OS 폴백 서체 자신(고르지 않아도 어차피 그 서체가 그린다).

   번들 서체 로드를 이 함수 안에서 기다리는 이유는, 그 대기를 호출자의 규율로 두면 한 번의 실수가
   영구히 남기 때문이다 — 기준선이 아직 없는 순간에 물으면 기준선이 OS 폴백으로 주저앉아 판정이
   통째로 뒤집히고, 그 오답이 탐침 캐시에 굳어 이후 올바른 호출까지 같은 답을 받는다. */
export async function fontCjkScripts(familyName: string): Promise<readonly CjkScript[]> {
  await waitForTerminalFallbackFonts();
  return CJK_SCRIPTS.filter((script) => fontDrawsText(familyName, CJK_SCRIPT_PROBES[script], { baselineFamily: BUNDLED_CJK_FALLBACK_FAMILY }));
}
