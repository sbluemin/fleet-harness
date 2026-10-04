/**
 * Native shell copy. Korean is the redesigned edition (design-system §9, impl-spec S-19/S-21–S-24);
 * a device in any other language keeps English.
 */

export interface ShellStrings {
  readonly wordmark: string;
  readonly landingSub: string;
  readonly empty: string;
  readonly chipConnected: string;
  readonly chipPaired: string;
  readonly chipLost: string;
  readonly lostHint: string;
  readonly remove: string;
  readonly keep: string;
  readonly menuFor: (name: string) => string;
  readonly addConsole: string;
  readonly waiting: string;
  readonly connecting: string;
  readonly failed: string;
  readonly retry: string;
  readonly retryIn: (seconds: number) => string;
  readonly retryWith: (name: string) => string;
  readonly backTo: (name: string) => string;
  readonly allConsoles: string;
  readonly addLead: string;
  readonly scanQr: string;
  readonly linkLabel: string;
  readonly cancel: string;
  readonly add: string;
  readonly close: string;
  readonly scanCaption: string;
  readonly pasteLink: string;
  readonly allowCamera: string;
  readonly cameraAsk: string;
  readonly cameraOff: (ios: boolean) => string;
  readonly notFleetCode: string;
  readonly describe: (code: string | undefined) => string;
}

const KO: ShellStrings = {
  wordmark: "Fleet",
  landingSub: "이 기기와 연결한 Console입니다. 링크는 한 번만 열리고 연결은 유지됩니다.",
  empty: "아직 연결한 Console이 없습니다.",
  chipConnected: "연결됨",
  chipPaired: "연결 가능",
  chipLost: "페어링 끊김",
  lostHint: "그 Console에서 새 접속 링크를 열어 다시 연결하세요.",
  remove: "제거",
  keep: "유지",
  menuFor: (name) => `${name} 메뉴`,
  addConsole: "Console 추가",
  waiting: "이 기기에서 Fleet 접속 링크를 열면 연결됩니다.",
  connecting: "Console을 확인하고 연결하는 중…",
  failed: "이 Console을 열지 못했습니다.",
  retry: "다시 시도",
  retryIn: (seconds) => `${seconds}초 뒤 다시 시도`,
  retryWith: (name) => `다시 시도 · ${name}`,
  backTo: (name) => `${name}${towardParticle(name)} 돌아가기`,
  allConsoles: "모든 Console",
  addLead: "Console 화면의 QR 코드를 찍거나 접속 링크를 붙여넣으세요. 링크는 15분 동안 한 번만 쓸 수 있습니다.",
  scanQr: "QR 코드 스캔",
  linkLabel: "접속 링크",
  cancel: "취소",
  add: "추가",
  close: "닫기",
  scanCaption: "Console의 QR 코드를 비추세요",
  pasteLink: "링크 붙여넣기",
  allowCamera: "카메라 허용",
  cameraAsk: "Fleet은 코드를 읽을 때만 카메라를 씁니다. 아무것도 녹화하거나 보내지 않습니다.",
  cameraOff: (ios) => `Fleet의 카메라 접근이 꺼져 있습니다. ${ios ? "설정" : "Android 설정"}에서 켜거나 링크를 붙여넣으세요.`,
  notFleetCode: "Fleet 접속 링크가 아닌 코드입니다.",
  describe(code) {
    switch (code) {
      case "pairing_target_invalid": return "접속 링크가 올바르지 않습니다. 그 Console에서 새 접속 링크를 여세요.";
      case "target_missing": return "이 Console은 더 이상 저장되어 있지 않습니다. QR 코드나 접속 링크로 다시 추가하세요.";
      case "remote_link_fingerprint_mismatch": return "Console의 신원이 이 링크와 맞지 않습니다. 그 Console에서 새 접속 링크를 여세요.";
      case "remote_link_rejected": return "이미 쓴 링크이거나 취소된 링크입니다. 그 Console에서 새 접속 링크를 여세요.";
      case "remote_host_not_paired": return "페어링이 끊겼습니다. 그 Console에서 새 접속 링크를 열거나 QR 코드를 다시 찍으세요.";
      // A join supersedes the open session rather than waiting on it, so no "try later" advice here.
      case "remote_link_control_held": return "다른 기기가 이 Console을 제어하고 있습니다.";
      case "remote_link_device_limit": return "이 Console에 연결할 수 있는 기기 수를 넘었습니다.";
      case "remote_link_host_mismatch": return "Console이 이 주소를 거부했습니다. 그 Console에서 새 접속 링크를 여세요.";
      case "remote_host_session_expired": return "세션이 끝났습니다. 다시 시도하면 다시 연결합니다.";
      case "remote_link_throttled": return "이 Console에 연결 시도가 너무 많았습니다. Console이 기다려 달라고 했습니다. 시간이 지나면 다시 시도하세요.";
      case "remote_host_busy": return "Console이 다른 기기를 페어링하는 중입니다. 잠시 뒤 다시 시도하세요.";
      case "remote_link_pin_not_observed": return "이 페이지의 Console 인증서 핀을 확인하지 못했습니다.";
      case "remote_link_unverified": return "Console 인증서가 고정된 신원 정책과 맞지 않습니다.";
      case "remote_link_redirect_refused": return "Console이 보안 연결을 다른 곳으로 돌리려 했습니다.";
      case "remote_link_transport_proof_unavailable": return "모든 페이지 전송의 인증서 핀을 확인하지 못해 연결하지 않았습니다.";
      case "remote_host_readiness_unsupported": return "이 기기의 웹 보기는 Fleet에 필요한 인증된 준비 채널을 지원하지 않습니다. 시스템 WebView를 업데이트한 뒤 다시 시도하세요.";
      // Unknown codes include refused navigation and readiness failures, not only an unreachable host.
      default: return "Console에 연결할 수 있는지 확인한 뒤 다시 시도하세요.";
    }
  },
};

const EN: ShellStrings = {
  wordmark: "Fleet",
  landingSub: "Consoles paired with this device. Links open once; pairing stays.",
  empty: "No consoles yet.",
  chipConnected: "Connected",
  chipPaired: "Paired",
  chipLost: "Pairing lost",
  lostHint: "Open a new access link from this console to pair again.",
  remove: "Remove",
  keep: "Keep",
  menuFor: (name) => `${name} menu`,
  addConsole: "Add console",
  waiting: "Open a Fleet access link on this device to connect.",
  connecting: "Checking the Console identity and opening a private session…",
  failed: "Fleet could not open that Console.",
  retry: "Try again",
  retryIn: (seconds) => `Try again in ${seconds}s`,
  retryWith: (name) => `Try again · ${name}`,
  backTo: (name) => `Back to ${name}`,
  allConsoles: "All consoles",
  addLead: "Scan the QR code shown on the console, or paste the access link. Links expire in 15 minutes and work once.",
  scanQr: "Scan QR code",
  linkLabel: "Access link",
  cancel: "Cancel",
  add: "Add",
  close: "Close",
  scanCaption: "Point the camera at the console's QR code",
  pasteLink: "Paste a link",
  allowCamera: "Allow camera",
  cameraAsk: "Fleet needs the camera to read the code. Nothing is recorded or sent anywhere.",
  cameraOff: (ios) => `Camera access is turned off for Fleet. Turn it on in ${ios ? "Settings" : "Android settings"}, or paste the link instead.`,
  notFleetCode: "That code is not a Fleet access link.",
  describe(code) {
    switch (code) {
      case "pairing_target_invalid": return "That access link is not valid.";
      case "target_missing": return "That console is no longer saved.";
      case "remote_link_fingerprint_mismatch": return "The Console identity no longer matches this link.";
      case "remote_link_rejected": return "That access link was already used or was revoked.";
      case "remote_host_not_paired": return "This device is no longer paired. Open a new access link.";
      case "remote_link_control_held": return "Another device currently controls this Console.";
      case "remote_link_device_limit": return "That Console has reached its paired-device limit.";
      case "remote_link_host_mismatch": return "The Console rejected this address.";
      case "remote_host_session_expired": return "The session ended. Try again to reconnect.";
      case "remote_link_throttled": return "Too many attempts reached this Console. It asked to wait before trying again.";
      case "remote_host_busy": return "The Console is busy pairing other devices. Try again shortly.";
      case "remote_link_pin_not_observed": return "Fleet could not prove the Console certificate pin for this page.";
      case "remote_link_unverified": return "The Console certificate did not meet the pinned identity policy.";
      case "remote_link_redirect_refused": return "The Console tried to redirect the secure connection.";
      case "remote_link_transport_proof_unavailable": return "Fleet could not prove certificate pins for every page transport, so it refused to connect.";
      case "remote_host_readiness_unsupported": return "This device's web view cannot provide the authenticated readiness channel Fleet requires.";
      default: return "Check that the Console is reachable, then try again.";
    }
  },
};

/** 「로」 after a vowel or ㄹ final, 「으로」 after any other final; unknown script keeps both forms. */
function towardParticle(word: string): string {
  const last = word.trim().slice(-1);
  const code = last.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return "(으)로";
  const final = code % 28;
  return final === 0 || final === 8 ? "로" : "으로";
}

function deviceLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return "en";
  }
}

export function shellStrings(locale: string = deviceLocale()): ShellStrings {
  return locale.toLowerCase().startsWith("ko") ? KO : EN;
}
