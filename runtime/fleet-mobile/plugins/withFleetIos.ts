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
// 호출하지 않는다). 그래서 super로 넘기기 직전에 그 키만 지운다.
//
// FleetLinkAppDelegateSubscriber는 이 소독보다 먼저 도는 willFinishLaunching에서 원본을
// 받아 인박스에 넣으므로, 네이티브는 링크를 잃지 않는다.
const SANITIZED_VAR = "fleetSanitizedLaunchOptions";
const LAUNCH_OPTIONS_MARKER = `var ${SANITIZED_VAR} = launchOptions`;

const launchOptionsSanitizer = (indent: string) =>
  [
    `// fleet-mobile: keep the fleet:// pairing credential out of Linking.getInitialURL().`,
    LAUNCH_OPTIONS_MARKER,
    `if let fleetLink = launchOptions?[.url] as? URL, fleetLink.scheme == "${FLEET_SCHEME}" {`,
    `  ${SANITIZED_VAR}?.removeValue(forKey: .url)`,
    `}`,
  ]
    .map((line) => `${indent}${line}`)
    .join("\n");

// `return super.application(application, didFinishLaunchingWithOptions: launchOptions)`
// — return 유무와 인자 이름이 템플릿마다 다를 수 있어 둘 다 열어 둔다.
const SUPER_DID_FINISH_LAUNCHING =
  /^([ \t]*)(return\s+)?super\.application\(\s*([A-Za-z_]\w*)\s*,\s*didFinishLaunchingWithOptions:\s*launchOptions\s*\)/m;

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
    if (mod.modResults.contents.includes(LAUNCH_OPTIONS_MARKER)) return mod;

    const replaced = mod.modResults.contents.replace(
      SUPER_DID_FINISH_LAUNCHING,
      (_match, indent: string, ret: string | undefined, appVar: string) => {
        const body = launchOptionsSanitizer(indent);
        return `${body}\n${indent}${ret ?? ""}super.application(${appVar}, didFinishLaunchingWithOptions: ${SANITIZED_VAR})`;
      },
    );
    if (replaced === mod.modResults.contents) {
      // 실패를 조용히 넘기면 크리덴셜이 JS에 노출된 채로 앱이 빌드된다. 못 찾았으면 세우고,
      // 어떤 파일을 보고 못 찾았는지 그대로 실어 보낸다 — Expo가 템플릿을 바꾸면 이 메시지가
      // 다음 수정의 근거가 된다.
      throw new Error(
        "withFleetIos could not find the didFinishLaunchingWithOptions super call in AppDelegate.swift, " +
          "so the fleet:// pairing credential would still reach JS Linking.getInitialURL(). " +
          `Generated AppDelegate follows:\n${mod.modResults.contents}`,
      );
    }
    mod.modResults.contents = replaced;
    return mod;
  });

  return config;
};

export default withFleetIos;
