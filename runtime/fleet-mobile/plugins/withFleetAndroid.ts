import { rmSync } from "node:fs";
import path from "node:path";
import {
  AndroidConfig,
  ConfigPlugin,
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
} from "expo/config-plugins";

function replaceExactlyOnce(source: string, pattern: RegExp, replacement: string, label: string): string {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matches = source.match(new RegExp(pattern.source, flags));
  if (matches?.length !== 1) {
    throw new Error(`Expected exactly one ${label} in generated Android configuration; found ${matches?.length ?? 0}`);
  }
  return source.replace(pattern, replacement);
}

export const withFleetAndroid: ConfigPlugin = (config) => {
  config = withAndroidManifest(config, (mod) => {
    mod.modResults.manifest["uses-permission"] = [
      { $: { "android:name": "android.permission.INTERNET" } },
      { $: { "android:name": "android.permission.READ_EXTERNAL_STORAGE", "tools:node": "remove" } },
      { $: { "android:name": "android.permission.WRITE_EXTERNAL_STORAGE", "tools:node": "remove" } },
      { $: { "android:name": "android.permission.SYSTEM_ALERT_WINDOW", "tools:node": "remove" } },
    ];
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    application.$["android:usesCleartextTraffic"] = "false";
    delete application.$["android:networkSecurityConfig"];
    application.receiver = [
      ...(application.receiver ?? []),
      { $: { "android:name": "androidx.profileinstaller.ProfileInstallReceiver", "tools:node": "remove" } },
    ];
    return mod;
  });

  config = withDangerousMod(config, ["android", (mod) => {
    // Expo's debug overlay enables cleartext traffic and SYSTEM_ALERT_WINDOW for Metro.
    // This promoted debug APK embeds its bundle and must not inherit either capability.
    rmSync(path.join(mod.modRequest.platformProjectRoot, "app", "src", "debug", "AndroidManifest.xml"), {
      force: true,
    });
    return mod;
  }]);

  config = withAppBuildGradle(config, (mod) => {
    let source = mod.modResults.contents;
    source = replaceExactlyOnce(
      source,
      /compileSdk\s+rootProject\.ext\.compileSdkVersion/,
      "compileSdk 36",
      "app compileSdk",
    );
    source = replaceExactlyOnce(
      source,
      /minSdkVersion\s+rootProject\.ext\.minSdkVersion/,
      "minSdkVersion 24",
      "app minSdk",
    );
    source = replaceExactlyOnce(
      source,
      /targetSdkVersion\s+rootProject\.ext\.targetSdkVersion/,
      "targetSdkVersion 36",
      "app targetSdk",
    );
    source = replaceExactlyOnce(
      source,
      /react\s*\{\n/,
      "react {\n    // The promoted debug APK is self-contained and must never depend on Metro.\n    debuggableVariants = []\n",
      "React Native Gradle extension",
    );
    source = replaceExactlyOnce(
      source,
      /signingConfigs\s*\{\s*debug\s*\{[\s\S]*?\n {4}\}/,
      `signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
        // Tester-distribution signing. The keystore and its passwords come from the environment so
        // they never enter git; an absent keystore leaves this config empty and the guard below stops
        // the build rather than letting Gradle fall back to the debug key.
        release {
            def releaseStore = System.getenv("FLEET_ANDROID_KEYSTORE")
            if (releaseStore) {
                storeFile file(releaseStore)
                storePassword System.getenv("FLEET_ANDROID_KEYSTORE_PASSWORD")
                keyAlias System.getenv("FLEET_ANDROID_KEY_ALIAS")
                keyPassword System.getenv("FLEET_ANDROID_KEY_PASSWORD")
            }
        }
    }`,
      "signingConfigs block",
    );
    source = replaceExactlyOnce(
      source,
      /buildTypes\s*\{\s*debug\s*\{\s*signingConfig signingConfigs\.debug\s*\}\s*release\s*\{[\s\S]*?\n\s*\}\s*\}/,
      `buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.release
            minifyEnabled enableMinifyInReleaseBuilds
            proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"
        }
    }

    // Release signing is opt-in, not implicit. Without the keystore environment every release task
    // stops here instead of producing an unsigned or debug-signed artifact that looks shippable.
    tasks.configureEach { task ->
        if (task.name.toLowerCase(java.util.Locale.ROOT).contains("release")) {
            task.doFirst {
                if (!System.getenv("FLEET_ANDROID_KEYSTORE")) {
                    throw new GradleException("Fleet Mobile release signing requires FLEET_ANDROID_KEYSTORE, FLEET_ANDROID_KEYSTORE_PASSWORD, FLEET_ANDROID_KEY_ALIAS, and FLEET_ANDROID_KEY_PASSWORD")
                }
            }
        }
    }`,
      "buildTypes signing block",
    );
    mod.modResults.contents = source;
    return mod;
  });

  return config;
};

export default withFleetAndroid;
