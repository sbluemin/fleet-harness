import type { ChatState } from "./chat-store.js";

export type MascotMood = "idle" | "thinking" | "cheering";

/**
 * 완료 연출은 1회성이다 — 끝나면 어떤 phase에서도 idle 로 돌아와 숨쉬기·꼬리·깜빡임이 다시 돈다.
 * 답을 마친 ready 를 정지 포즈로 붙잡아 두면 마스코트가 눈웃음 그대로 굳는다.
 */
export function mascotMood(phase: ChatState["phase"], cheering: boolean): MascotMood {
  if (cheering) return "cheering";
  if (phase === "starting" || phase === "thinking") return "thinking";
  return "idle";
}
