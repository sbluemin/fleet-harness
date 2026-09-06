import { describe, expect, it } from "vitest";
import {
  APPLICATION_ID,
  inspectAaptManifestTree,
  inspectBadging,
  parseJavaMajor,
  requireAndroidSdk,
  requireReleaseKeystore,
  verifyDebugSigner,
  verifyManifestContract,
  verifyReleaseSigner,
  withJavaNativeAccess,
} from "../scripts/lib/android-tools.mjs";

const manifestTree = `
N: android=http://schemas.android.com/apk/res/android
  E: manifest (line=2)
    A: package="com.dotobokuri.fleet.mobile" (Raw: "com.dotobokuri.fleet.mobile")
    E: uses-permission (line=6)
      A: android:name(0x01010003)="android.permission.INTERNET" (Raw: "android.permission.INTERNET")
    E: uses-permission (line=6)
      A: android:name(0x01010003)="android.permission.CAMERA" (Raw: "android.permission.CAMERA")
    E: uses-permission (line=6)
      A: android:name(0x01010003)="android.permission.ACCESS_NETWORK_STATE" (Raw: "android.permission.ACCESS_NETWORK_STATE")
    E: permission (line=7)
      A: android:name(0x01010003)="com.dotobokuri.fleet.mobile.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION" (Raw: "com.dotobokuri.fleet.mobile.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
      A: android:protectionLevel(0x01010009)=(type 0x11)0x2
    E: uses-permission (line=9)
      A: android:name(0x01010003)="com.dotobokuri.fleet.mobile.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION" (Raw: "com.dotobokuri.fleet.mobile.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
    E: application (line=10)
      A: android:debuggable(0x0101000f)=(type 0x12)0xffffffff
      A: android:usesCleartextTraffic(0x010104ec)=(type 0x12)0x0
      E: activity (line=11)
        A: android:name(0x01010003)="com.dotobokuri.fleet.mobile.MainActivity" (Raw: "com.dotobokuri.fleet.mobile.MainActivity")
        A: android:exported(0x01010510)=(type 0x12)0xffffffff
      E: activity (line=15)
        A: android:name(0x01010003)="com.dotobokuri.fleet.mobile.FleetLinkActivity" (Raw: "com.dotobokuri.fleet.mobile.FleetLinkActivity")
        A: android:exported(0x01010510)=(type 0x12)0xffffffff
      E: provider (line=20)
        A: android:name(0x01010003)="expo.modules.filesystem.FileSystemFileProvider" (Raw: "expo.modules.filesystem.FileSystemFileProvider")
        A: android:exported(0x01010510)=(type 0x12)0x0
`;

const badging = `
package: name='com.dotobokuri.fleet.mobile' versionCode='1' versionName='1.0.0'
sdkVersion:'24'
targetSdkVersion:'36'
`;

const signer = `
Verified using v1 scheme (JAR signing): false
Verified using v2 scheme (APK Signature Scheme v2): true
Signer #1 certificate DN: CN=Android Debug, OU=Android, O=Unknown, L=Unknown, ST=Unknown, C=US
Signer #1 certificate SHA-256 digest: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
`;

describe("Android APK contract helpers", () => {
  it("accepts the fixed package, SDK, permission, and component contract", () => {
    verifyManifestContract(inspectAaptManifestTree(manifestTree), inspectBadging(badging));
  });

  // The scanner needs CAMERA, so that one is now expected. RECORD_AUDIO stands in as the thing the
  // gate must still refuse — expo-camera declares it unless recordAudioAndroid is explicitly false,
  // so this case fails the moment that option is dropped from app.json.
  it("fails closed on additional permissions", () => {
    const manifest = inspectAaptManifestTree(
      manifestTree.replace(
        "    E: application",
        `    E: uses-permission (line=7)\n      A: android:name(0x01010003)=\"android.permission.RECORD_AUDIO\" (Raw: \"android.permission.RECORD_AUDIO\")\n    E: application`,
      ),
    );
    expect(() => verifyManifestContract(manifest, inspectBadging(badging))).toThrow(
      /Unexpected APK permissions/,
    );
  });

  it("fails closed on another exported component", () => {
    const manifest = inspectAaptManifestTree(
      manifestTree.replace(
        "      E: provider",
        `      E: service (line=18)\n        A: android:name(0x01010003)=\".LeakedService\" (Raw: \".LeakedService\")\n        A: android:exported(0x01010510)=(type 0x12)0xffffffff\n      E: provider`,
      ),
    );
    expect(() => verifyManifestContract(manifest, inspectBadging(badging))).toThrow(
      `service:${APPLICATION_ID}.LeakedService`,
    );
  });

  it("requires an Android debug signer", () => {
    verifyDebugSigner(signer);
    expect(() => verifyDebugSigner(signer.replace("CN=Android Debug", "CN=Release"))).toThrow(
      /exactly one Android Debug signer/,
    );
    expect(() => verifyDebugSigner(signer.replace("CN=Android Debug", "CN=Android Debugger"))).toThrow(
      /exactly one Android Debug signer/,
    );
  });

  // The release APK carries no android:debuggable attribute at all; the debug one must carry it.
  it("holds each build type to the opposite debuggable value", () => {
    const debuggable = inspectAaptManifestTree(manifestTree);
    const stripped = inspectAaptManifestTree(manifestTree.replace(/^.*android:debuggable.*\n/m, ""));
    expect(() => verifyManifestContract(debuggable, inspectBadging(badging), { buildType: "release" })).toThrow(
      /must not be debuggable/,
    );
    expect(() => verifyManifestContract(stripped, inspectBadging(badging))).toThrow(/must be marked debuggable/);
    verifyManifestContract(stripped, inspectBadging(badging), { buildType: "release" });
  });

  it("refuses the shared debug key on a release APK", () => {
    expect(() => verifyReleaseSigner(signer)).toThrow(/must not be signed with the Android debug key/);
    expect(verifyReleaseSigner(signer.replace("CN=Android Debug", "CN=Fleet Mobile"))).toBe("a".repeat(64));
  });

  it("requires complete release signing credentials", () => {
    expect(() => requireReleaseKeystore({})).toThrow(/FLEET_ANDROID_KEYSTORE must name/);
    expect(() => requireReleaseKeystore({ FLEET_ANDROID_KEYSTORE: "fleet.jks" })).toThrow(/absolute/);
  });

  it("requires one absolute SDK root", () => {
    expect(() => requireAndroidSdk({})).toThrow(/ANDROID_SDK_ROOT/);
    expect(() => requireAndroidSdk({ ANDROID_SDK_ROOT: "relative" })).toThrow(/absolute/);
  });
});
