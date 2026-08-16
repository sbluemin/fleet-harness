#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fail, run } from "./lib/android-tools.mjs";
import { requireAscCredentials } from "./lib/ios-tools.mjs";
import { artifactPaths, repoRoot, verifyPromotedIpa } from "./lib/ios-promote.mjs";

// distribute-firebase.mjs의 iOS 대응. 승격된 release IPA를 재검증한 뒤 App Store Connect API
// 키로 TestFlight에 업로드한다. CI는 `firebase login`처럼 대화형 로그인을 할 수 없으므로
// ASC API 키(.p8)로 인증한다. 키 파일 경로는 FLEET_ASC_KEY_PATH가 있으면 그것을, 없으면
// FLEET_ASC_KEY_BASE64를 디코드해 RUNNER_TEMP에 쓴 경로를 CI가 넘긴다.
//
// 업로드 도구는 xcrun altool(--upload-app)을 쓴다. 러너 Xcode에서 지원이 빠지면
// exportArchive의 upload destination이나 iTMSTransporter로 교체한다(그때 이 파일 갱신).

function keyPath(env) {
  const explicit = env.FLEET_ASC_KEY_PATH;
  if (explicit) {
    if (!path.isAbsolute(explicit)) fail("FLEET_ASC_KEY_PATH must be absolute");
    return explicit;
  }
  fail("FLEET_ASC_KEY_PATH must point to the AuthKey .p8 (CI writes it from FLEET_ASC_KEY_BASE64)");
}

function main() {
  const asc = requireAscCredentials();
  const key = keyPath(process.env);

  // 디스크를 믿지 않고 항상 승격된 release IPA를 재검증한다.
  verifyPromotedIpa("release");
  const paths = artifactPaths("release");
  const sha256 = readFileSync(paths.sha256, "utf8").trim().split(/\s+/)[0];
  process.stdout.write(`Uploading ${paths.name} (sha256 ${sha256}) to TestFlight\n`);

  run("xcrun", [
    "altool", "--upload-app",
    "--type", "ios",
    "--file", paths.ipa,
    "--apiKey", asc.keyId,
    "--apiIssuer", asc.issuerId,
  ], { cwd: repoRoot, env: { ...process.env, API_PRIVATE_KEYS_DIR: path.dirname(key) } });
}

main();
