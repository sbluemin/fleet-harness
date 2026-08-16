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

    return mod;
  });

  return config;
};

export default withFleetIos;
