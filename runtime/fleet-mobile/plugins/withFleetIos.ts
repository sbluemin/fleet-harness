import { ConfigPlugin, withAppDelegate, withInfoPlist } from "expo/config-plugins";

// withFleetAndroid.ts의 iOS 대응. Info.plist를 하드닝한다: fleet://join을 앱 URL 타입으로
// 등록(FleetLinkAppDelegateSubscriber가 RN Linking 이전에 소비), App Transport Security는
// 임의 로드 금지 + 로컬 루프백 게이트웨이(자체서명 HTTPS)만 예외로 허용.
//
// withFleetAndroid와 같은 계약: 이 플러그인은 app.json plugins 배열의 마지막이어야 뒤의
// 플러그인이 하드닝을 되돌릴 수 없다(android-build-contract.test.ts가 검증).
const FLEET_SCHEME = "fleet";
const URL_NAME = "com.dotobokuri.fleet.mobile.join";

// withFleetAndroid가 FleetLinkActivity로 얻는 보장을 iOS에서 만든다: fleet:// 페어링
// 크리덴셜이 JS에 절대 보이지 않게 한다.
//
// 네이티브 구독자만으로는 안 된다. ExpoAppDelegateSubscriberManager는 didFinishLaunching을
// forEach로 돌려 **같은** launchOptions를 모든 구독자에게 넘기고 반환값을 버리므로, 구독자가
// 무엇을 하든 launchOptions는 그대로 남는다. 그 dictionary는 그대로 React 호스트로 들어가고
// RN의 RCTLinkingManager.getInitialURL이 UIApplicationLaunchOptionsURLKey를 읽는다 —
// 이것이 이 앱에서 크리덴셜이 JS에 닿는 유일한 경로다(warm start는 닿지 않는다: RN의
// application:openURL:는 AppDelegate가 직접 호출해야 하는데 expo도 expo-modules-core도
// 호출하지 않는다).
//
// Expo 템플릿은 factory.startReactNative(..., launchOptions: launchOptions)가
// super.didFinish보다 먼저 원본을 넘긴다. super만 갈아끼우면 RN은 여전히 토큰을 본다.
// 소독 사본은 startReactNative **앞**에서 만들고, 그 변수만 두 소비자에 넘긴다.
// willFinish 구독자는 원본 launchOptions를 그대로 받아 인박스에 넣는다.
const SANITIZED_VAR = "fleetSanitizedLaunchOptions";
const LAUNCH_OPTIONS_MARKER = `var ${SANITIZED_VAR} = launchOptions`;
// 계약의 본체. 이름과 순서만 보면 원본을 그대로 별칭한 사본도 통과하므로, 실제로 지우는
// 이 줄까지 요구해야 "크리덴셜이 지워졌다"는 단언이 된다(CI 단언도 같은 줄을 본다).
const STRIP_LAUNCH_URL = `${SANITIZED_VAR}?.removeValue(forKey: .url)`;
const START_REACT_NATIVE = /^([ \t]*)factory\.startReactNative\s*\(/m;
const SUPER_DID_FINISH_LAUNCHING =
  /^([ \t]*)((?:return\s+)?)super\.application\(\s*([A-Za-z_]\w*)\s*,\s*didFinishLaunchingWithOptions:\s*(launchOptions|fleetSanitizedLaunchOptions)\s*\)/m;
const PREVIOUS_SANITIZER =
  /[ \t]*\/\/ fleet-mobile: keep the fleet:\/\/ pairing credential out of Linking\.getInitialURL\(\)\.\n[ \t]*var fleetSanitizedLaunchOptions = launchOptions\n[ \t]*if let fleetLink = launchOptions\?\[\.url\] as\? URL, fleetLink\.scheme == "fleet" \{\n[ \t]*fleetSanitizedLaunchOptions\?\.removeValue\(forKey: \.url\)\n[ \t]*\}\n?/;

const launchOptionsSanitizer = (indent: string) =>
  [
    `// fleet-mobile: keep the fleet:// pairing credential out of Linking.getInitialURL().`,
    LAUNCH_OPTIONS_MARKER,
    `if let fleetLink = launchOptions?[.url] as? URL, fleetLink.scheme == "${FLEET_SCHEME}" {`,
    `  ${STRIP_LAUNCH_URL}`,
    `}`,
  ]
    .map((line) => `${indent}${line}`)
    .join("\n");

function matchingParenEnd(source: string, openParenIndex: number): number {
  let depth = 0;
  for (let i = openParenIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function findStartReactNative(contents: string): { index: number; indent: string; end: number } | null {
  const match = contents.match(START_REACT_NATIVE);
  if (match?.index == null || match[1] == null) return null;
  const open = contents.indexOf("(", match.index);
  const end = matchingParenEnd(contents, open);
  if (open < 0 || end < 0) return null;
  return { index: match.index, indent: match[1], end };
}

function launchOptionsContractHolds(contents: string): boolean {
  const start = findStartReactNative(contents);
  const superMatch = contents.match(SUPER_DID_FINISH_LAUNCHING);
  const markerAt = contents.indexOf(LAUNCH_OPTIONS_MARKER);
  const stripAt = contents.indexOf(STRIP_LAUNCH_URL);
  if (!start || superMatch?.index == null || markerAt < 0) return false;
  if (markerAt > start.index || start.index > superMatch.index) return false;
  if (stripAt < markerAt || stripAt > start.index) return false;
  const call = contents.slice(start.index, start.end);
  if (!/launchOptions:\s*fleetSanitizedLaunchOptions/.test(call)) return false;
  if (/launchOptions:\s*launchOptions/.test(call)) return false;
  return /didFinishLaunchingWithOptions:\s*fleetSanitizedLaunchOptions/.test(superMatch[0]);
}

function stripPreviousSanitizer(contents: string): string {
  return contents
    .replace(PREVIOUS_SANITIZER, "")
    // 블록이 통째로 남아 있지 않은(= 위 정규식이 못 지운) 잔재까지 걷어낸다. 이걸 남기면
    // 아래 주입이 marker를 한 번 더 선언해 Swift가 중복 선언으로 죽는다.
    .replace(/[ \t]*var fleetSanitizedLaunchOptions = launchOptions\n/, "")
    .replace(/launchOptions:\s*fleetSanitizedLaunchOptions/g, "launchOptions: launchOptions")
    .replace(
      /didFinishLaunchingWithOptions:\s*fleetSanitizedLaunchOptions/g,
      "didFinishLaunchingWithOptions: launchOptions",
    );
}

function failClosed(reason: string, contents: string): never {
  throw new Error(
    `withFleetIos ${reason} in AppDelegate.swift, ` +
      "so the fleet:// pairing credential would still reach JS Linking.getInitialURL(). " +
      `Generated AppDelegate follows:\n${contents}`,
  );
}

// 테스트가 플러그인 소스만이 아니라 실제 주입 결과의 순서를 검사하도록 순수 변환을 노출한다.
export function sanitizeAppDelegateContents(contents: string): string {
  if (launchOptionsContractHolds(contents)) return contents;

  const prepared = stripPreviousSanitizer(contents);
  const start = findStartReactNative(prepared);
  const superMatch = prepared.match(SUPER_DID_FINISH_LAUNCHING);
  if (!start) failClosed("could not find factory.startReactNative", prepared);
  if (superMatch?.index == null || superMatch[2] == null || superMatch[3] == null) {
    failClosed("could not find the didFinishLaunchingWithOptions super call", prepared);
  }
  if (start.index > superMatch.index) {
    failClosed("could not keep factory.startReactNative before super.didFinishLaunchingWithOptions", prepared);
  }

  const originalCall = prepared.slice(start.index, start.end);
  if (!/launchOptions:\s*launchOptions/.test(originalCall)) {
    failClosed("could not find startReactNative launchOptions: launchOptions", prepared);
  }
  const sanitizedCall = originalCall.replace(/launchOptions:\s*launchOptions/g, `launchOptions: ${SANITIZED_VAR}`);
  const withStart = prepared.slice(0, start.index) + sanitizedCall + prepared.slice(start.end);

  const nextSuper = withStart.match(SUPER_DID_FINISH_LAUNCHING);
  if (nextSuper?.index == null || nextSuper[1] == null || nextSuper[2] == null || nextSuper[3] == null) {
    failClosed("could not find the didFinishLaunchingWithOptions super call", withStart);
  }
  const replacedSuper = withStart.replace(
    SUPER_DID_FINISH_LAUNCHING,
    `${nextSuper[1]}${nextSuper[2]}super.application(${nextSuper[3]}, didFinishLaunchingWithOptions: ${SANITIZED_VAR})`,
  );

  const injected = replacedSuper.replace(
    START_REACT_NATIVE,
    `${launchOptionsSanitizer(start.indent)}\n$&`,
  );
  if (!launchOptionsContractHolds(injected)) {
    failClosed("could not inject sanitized launchOptions before factory.startReactNative", injected);
  }
  return injected;
}

export const withFleetIos: ConfigPlugin = (config) => {
  config = withInfoPlist(config, (mod) => {
    const plist = mod.modResults as Record<string, unknown>;

    // fleet:// 딥링크 URL 타입만 남긴다. Expo는 번들 id(및 exp+slug) 스킴을 스스로 주입하는데,
    // 그것들은 이 앱이 쓰지 않는 추가 진입점이고 릴리스 검사기도 정확히 ["fleet"]만 허용한다.
    // 걸러서 덧붙이는 대신 통째로 교체해야 그 주입분이 남지 않는다.
    plist.CFBundleURLTypes = [{ CFBundleURLName: URL_NAME, CFBundleURLSchemes: [FLEET_SCHEME] }];

    // ATS: 임의 로드 금지. WKWebView는 로컬 게이트웨이의 자체서명 인증서를 ServerTrust 챌린지
    // (LocalCertificatePolicy)로만 신뢰하고, RemoteConnection은 NWConnection verify 블록으로
    // 핀한다 — ATS 예외로 원격 신뢰를 약화하지 않는다. NSAllowsLocalNetworking은 127/8 로컬
    // 게이트웨이 로드를 위한 것.
    plist.NSAppTransportSecurity = {
      NSAllowsArbitraryLoads: false,
      NSAllowsLocalNetworking: true,
    };

    // 콘솔은 보통 같은 LAN의 다른 기기(192.168.x.x 등)에서 돌아간다. iOS 14+는 로컬 네트워크
    // 접근에 사용자 동의를 요구하고, 이 문자열이 없으면 시스템이 프롬프트를 띄우지 못해 연결이
    // 조용히 막힌다. 시뮬레이터는 이 정책을 강제하지 않으므로 누락이 시뮬레이터 테스트에서는
    // 드러나지 않는다 — 실기기 페어링에서만 터진다.
    plist.NSLocalNetworkUsageDescription =
      "Fleet connects to the Console running on your local network.";

    // 수출 규정 준수 선언. Fleet의 암호화는 전부 OS가 제공하는 표준 TLS다 — 원격은
    // Network.framework, 로컬 게이트웨이는 Security.framework의 P-256 키와 자체서명 인증서,
    // WebView는 WKWebView. 독자 암호화 알고리즘은 없으므로 5D992 면제에 해당한다.
    // 이 키가 없으면 업로드된 빌드가 App Store Connect에서 Missing Compliance로 멈춰
    // 매 빌드마다 사람이 같은 질문에 답해야 하고, 그때까지 테스터에게 배포되지 않는다.
    plist.ITSAppUsesNonExemptEncryption = false;

    return mod;
  });

  config = withAppDelegate(config, (mod) => {
    if (mod.modResults.language !== "swift") {
      throw new Error(
        `withFleetIos needs a Swift AppDelegate to keep the pairing credential out of JS; found ${mod.modResults.language}.`,
      );
    }
    // 이미 올바른 순서면 재주입하지 않는다. 앵커/순서를 못 지키면 아래가 세운다.
    mod.modResults.contents = sanitizeAppDelegateContents(mod.modResults.contents);
    return mod;
  });

  return config;
};

export default withFleetIos;
