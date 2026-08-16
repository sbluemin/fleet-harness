import { ConfigPlugin, withInfoPlist } from "expo/config-plugins";

// withFleetAndroid.ts의 iOS 대응. Info.plist를 하드닝한다: fleet://join을 앱 URL 타입으로
// 등록(FleetLinkAppDelegateSubscriber가 RN Linking 이전에 소비), App Transport Security는
// 임의 로드 금지 + 로컬 루프백 게이트웨이(자체서명 HTTPS)만 예외로 허용.
//
// withFleetAndroid와 같은 계약: 이 플러그인은 app.json plugins 배열의 마지막이어야 뒤의
// 플러그인이 하드닝을 되돌릴 수 없다(android-build-contract.test.ts가 검증).
const FLEET_SCHEME = "fleet";
const URL_NAME = "com.dotobokuri.fleet.mobile.join";

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

  return config;
};

export default withFleetIos;
