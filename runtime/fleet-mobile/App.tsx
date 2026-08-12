import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  BackHandler,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { AppStateStatus } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";

import { FleetConsoleView } from "./modules/fleet-console-view/src";
import type { FleetConsoleEvent, FleetConsoleTarget, FleetConsoleViewHandle } from "./modules/fleet-console-view/src";

type ShellState = "waiting" | "connecting" | "connected" | "error";
type Screen = "landing" | "console" | "scanner";

const MESSAGES: Record<ShellState, string> = {
  waiting: "Open a Fleet access link on this device to connect.",
  connecting: "Checking the Console identity and opening a private session…",
  connected: "Connected",
  error: "Fleet could not open that Console.",
};

type WindowInsets = { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number };

const NO_INSETS: WindowInsets = { top: 0, right: 0, bottom: 0, left: 0 };

export default function App(): React.JSX.Element {
  const consoleRef = useRef<FleetConsoleViewHandle>(null);
  const [state, setState] = useState<ShellState>("waiting");
  const [detail, setDetail] = useState<string | null>(null);
  const [targetLabel, setTargetLabel] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>("console");
  const [targets, setTargets] = useState<FleetConsoleTarget[]>([]);
  const [lastError, setLastError] = useState<Record<string, string>>({});
  const [retryLeft, setRetryLeft] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState("");
  const [armRemove, setArmRemove] = useState<string | null>(null);
  const [insets, setInsets] = useState<WindowInsets>(NO_INSETS);
  const [scanError, setScanError] = useState<string | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  // A latch rather than state: the camera callback fires faster than a re-render would settle.
  const scannedRef = useRef(false);
  const refreshTargets = useCallback((): void => {
    consoleRef.current?.listTargets().then(setTargets, () => {});
  }, []);

  useEffect(() => AppState.addEventListener("change", (next: AppStateStatus) => {
    if (next === "active") consoleRef.current?.resume();
  }).remove, []);

  useEffect(refreshTargets, [refreshTargets]);

  useEffect(() => {
    if (retryLeft === null || retryLeft <= 0) return;
    const timer = setTimeout(() => setRetryLeft(retryLeft - 1), 1000);
    return () => clearTimeout(timer);
  }, [retryLeft]);

  const onFleetEvent = useCallback(({ nativeEvent }: { nativeEvent: FleetConsoleEvent }): void => {
    if (nativeEvent.type === "insets") {
      setInsets({
        top: nativeEvent.insetTop ?? 0,
        right: nativeEvent.insetRight ?? 0,
        bottom: nativeEvent.insetBottom ?? 0,
        left: nativeEvent.insetLeft ?? 0,
      });
      return;
    }
    setTargetLabel(nativeEvent.label ?? null);
    refreshTargets();
    if (nativeEvent.type === "error" && nativeEvent.origin) {
      const origin = nativeEvent.origin;
      const code = nativeEvent.code ?? "unknown";
      setLastError((previous) => ({ ...previous, [origin]: code }));
    }
    if (nativeEvent.type === "connected" && nativeEvent.origin) {
      const origin = nativeEvent.origin;
      setLastError((previous) => {
        const { [origin]: _cleared, ...rest } = previous;
        return rest;
      });
    }
    switch (nativeEvent.type) {
      case "connected":
        setState("connected");
        setDetail(null);
        setRetryLeft(null);
        return;
      case "connecting":
        if (nativeEvent.active) return;
        setState("connecting");
        setDetail(null);
        setRetryLeft(null);
        // A fresh attempt with no console on screen (an intent-delivered link included) shows its progress.
        setScreen("console");
        return;
      case "waiting":
        setState("waiting");
        setDetail(null);
        setRetryLeft(null);
        setScreen("landing");
        return;
      case "error":
        if (nativeEvent.active) return;
        setState("error");
        setDetail(describe(nativeEvent.code));
        setRetryLeft(nativeEvent.retryAfterSeconds ?? null);
        return;
    }
  }, [refreshTargets]);

  const retry = useCallback((): void => {
    setState("connecting");
    setDetail(null);
    setRetryLeft(null);
    consoleRef.current?.retry();
  }, []);

  const openConsole = useCallback((origin: string): void => {
    setArmRemove(null);
    setScreen("console");
    const current = targets.find((target) => target.origin === origin);
    if (current?.active && state === "connected") return;
    setState("connecting");
    setDetail(null);
    setRetryLeft(null);
    consoleRef.current?.connectTo(origin);
  }, [targets, state]);

  const removeConsole = useCallback((origin: string): void => {
    setArmRemove(null);
    setLastError((previous) => {
      const { [origin]: _cleared, ...rest } = previous;
      return rest;
    });
    consoleRef.current?.removeTarget(origin);
    refreshTargets();
  }, [refreshTargets]);

  /**
   * Both intake paths end here. A scanned link and a pasted one are the same string, and the native
   * parser is the only thing that decides whether it is trustworthy — the camera earns no shortcut.
   */
  const acceptLink = useCallback((link: string): void => {
    if (!link.toLowerCase().startsWith("fleet://")) return;
    setAddOpen(false);
    setLinkDraft("");
    setScreen("console");
    setState("connecting");
    setDetail(null);
    setRetryLeft(null);
    consoleRef.current?.submitAccessLink(link);
  }, []);

  const submitLink = useCallback((): void => {
    acceptLink(linkDraft.trim());
  }, [acceptLink, linkDraft]);

  const openScanner = useCallback((): void => {
    setAddOpen(false);
    setScanError(null);
    setScreen("scanner");
    if (permission?.granted !== true) void requestPermission();
  }, [permission?.granted, requestPermission]);

  /**
   * The camera keeps firing for as long as the code is in frame. Without this latch the same link is
   * submitted several times, and every attempt after the first spends a grant that is already gone —
   * the console then reports a rejected join for a pairing that actually succeeded.
   */
  const onBarcodeScanned = useCallback(({ data }: { readonly data: string }): void => {
    if (scannedRef.current) return;
    const link = data.trim();
    if (!link.toLowerCase().startsWith("fleet://")) {
      setScanError("That code is not a Fleet access link.");
      return;
    }
    scannedRef.current = true;
    setScanError(null);
    acceptLink(link);
  }, [acceptLink]);

  // Leaving the scanner re-arms it, so a second visit can scan again.
  useEffect(() => {
    if (screen !== "scanner") scannedRef.current = false;
  }, [screen]);

  useEffect(() => {
    const onBack = (): boolean => {
      if (addOpen) {
        setAddOpen(false);
        return true;
      }
      if (screen === "scanner") {
        setScreen("landing");
        return true;
      }
      if (screen === "console") {
        const view = consoleRef.current;
        if (!view) {
          setScreen("landing");
          return true;
        }
        view.navigateBack().then((consumed) => {
          if (!consumed) setScreen("landing");
        }, () => setScreen("landing"));
        return true;
      }
      // The console list is where the app starts, so back stops here rather than walking on.
      return true;
    };
    const subscription = BackHandler.addEventListener("hardwareBackPress", onBack);
    return () => subscription.remove();
  }, [addOpen, screen, state]);

  const retryBlocked = retryLeft !== null && retryLeft > 0;

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="#111318" />
      <FleetConsoleView ref={consoleRef} style={styles.console} onFleetEvent={onFleetEvent} />
      {screen === "console" && state !== "connected" ? (
        <View style={[styles.overlay, { paddingTop: insets.top, paddingBottom: insets.bottom }]} accessible accessibilityRole="summary">
          <Text style={styles.eyebrow}>FLEET CONSOLE</Text>
          <Text style={styles.title}>{targetLabel ?? "Mobile access"}</Text>
          <Text style={styles.message}>{MESSAGES[state]}</Text>
          {detail ? <Text style={styles.detail}>{detail}</Text> : null}
          {state === "error" && retryLeft !== null ? (
            <Text style={styles.countdown}>
              {retryLeft > 0 ? `You can try again in ${retryLeft}s.` : "You can try again now."}
            </Text>
          ) : null}
          {state === "error" ? (
            <Pressable
              accessibilityRole="button"
              disabled={retryBlocked}
              onPress={retry}
              style={({ pressed }) => [styles.button, retryBlocked && styles.buttonDisabled, pressed && !retryBlocked && styles.buttonPressed]}
            >
              <Text style={[styles.buttonLabel, retryBlocked && styles.buttonLabelDisabled]}>Try again</Text>
            </Pressable>
          ) : null}
          <Pressable accessibilityRole="button" onPress={() => setScreen("landing")} style={styles.overlayLanding}>
            <Text style={styles.overlayLandingLabel}>All consoles</Text>
          </Pressable>
        </View>
      ) : null}
      {screen === "landing" ? (
        <View style={styles.landing}>
          <View style={[styles.landingHead, { paddingTop: 24 + insets.top }]}>
            <Text style={styles.eyebrow}>FLEET</Text>
            <Text style={styles.landingTitle}>Consoles</Text>
            <Text style={styles.landingSub}>Paired consoles stay here. Links open once; pairing survives.</Text>
          </View>
          <ScrollView style={styles.deck} contentContainerStyle={[styles.deckContent, { paddingBottom: 120 + insets.bottom }]}>
            {targets.length === 0 ? (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>No consoles yet</Text>
                <Text style={styles.emptyBody}>
                  Open a Fleet access link on this device, or paste one with Add console.
                </Text>
              </View>
            ) : null}
            {targets.map((target) => {
              const failure = lastError[target.origin];
              const connectedNow = target.active && state === "connected";
              const pairingLost = failure === "remote_host_not_paired";
              return (
                <Pressable
                  key={target.origin}
                  accessibilityRole="button"
                  onPress={() => openConsole(target.origin)}
                  onLongPress={() => setArmRemove(armRemove === target.origin ? null : target.origin)}
                  style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
                >
                  <View style={styles.cardHead}>
                    <Text style={styles.cardName} numberOfLines={1}>{target.label}</Text>
                    {connectedNow ? <Text style={[styles.chip, styles.chipConnected]}>Connected</Text> : null}
                    {!connectedNow && pairingLost ? <Text style={[styles.chip, styles.chipLost]}>Pairing lost</Text> : null}
                    {!connectedNow && !pairingLost ? <Text style={[styles.chip, styles.chipPaired]}>Paired</Text> : null}
                  </View>
                  <Text style={styles.cardAddr} numberOfLines={1}>
                    {`${target.host}:${target.port} · pin ${target.fingerprint}…`}
                  </Text>
                  {pairingLost ? (
                    <Text style={styles.cardHint}>Open a new access link from this console to pair again.</Text>
                  ) : null}
                  {armRemove === target.origin ? (
                    <View style={styles.removeRow}>
                      <Pressable accessibilityRole="button" onPress={() => removeConsole(target.origin)} style={styles.removeButton}>
                        <Text style={styles.removeLabel}>Remove</Text>
                      </Pressable>
                      <Pressable accessibilityRole="button" onPress={() => setArmRemove(null)} style={styles.keepButton}>
                        <Text style={styles.keepLabel}>Keep</Text>
                      </Pressable>
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </ScrollView>
          <Pressable
            accessibilityRole="button"
            onPress={() => setAddOpen(true)}
            style={({ pressed }) => [styles.addButton, { bottom: 24 + insets.bottom }, pressed && styles.buttonPressed]}
          >
            <Text style={styles.addButtonLabel}>+ Add console</Text>
          </Pressable>
        </View>
      ) : null}
      {screen === "scanner" ? (
        <View style={styles.scanner}>
          {permission?.granted === true ? (
            <CameraView
              style={styles.scannerCamera}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={onBarcodeScanned}
            />
          ) : null}
          <View style={[styles.scannerChrome, { paddingTop: 24 + insets.top, paddingBottom: 24 + insets.bottom }]}>
            <Text style={styles.eyebrow}>FLEET</Text>
            <Text style={styles.scannerTitle}>Scan the console's code</Text>
            {permission?.granted === true ? (
              <>
                <View style={styles.reticle} />
                <Text style={styles.scannerHint}>
                  Point the camera at the QR code in Remote access settings.
                </Text>
              </>
            ) : (
              <Text style={styles.scannerHint}>
                {permission?.canAskAgain === false
                  ? "Camera access is turned off for Fleet. Turn it on in Android settings, or paste the link instead."
                  : "Fleet needs the camera to read the code. Nothing is recorded or sent anywhere."}
              </Text>
            )}
            {scanError ? <Text style={styles.detail}>{scanError}</Text> : null}
            <View style={styles.scannerActions}>
              {permission?.granted === true || permission?.canAskAgain === false ? null : (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => { void requestPermission(); }}
                  style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
                >
                  <Text style={styles.buttonLabel}>Allow camera</Text>
                </Pressable>
              )}
              {/* The paste path never goes away — a denied camera, or a code that will not read, still needs a way in. */}
              <Pressable
                accessibilityRole="button"
                onPress={() => { setScreen("landing"); setAddOpen(true); }}
                style={styles.keepButton}
              >
                <Text style={styles.keepLabel}>Paste a link instead</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => setScreen("landing")} style={styles.overlayLanding}>
                <Text style={styles.overlayLandingLabel}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}
      <Modal visible={addOpen} transparent animationType="slide" onRequestClose={() => setAddOpen(false)}>
        <View style={styles.sheetScrim}>
          <Pressable style={styles.sheetScrimTouch} onPress={() => setAddOpen(false)} />
          <View style={[styles.sheet, { paddingBottom: 24 + insets.bottom }]}>
            <Text style={styles.sheetTitle}>Add console</Text>
            <Text style={styles.sheetBody}>
              Scan the QR code shown in the console's Remote access settings, or paste the link. Links expire in 15 minutes and work once.
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={openScanner}
              style={({ pressed }) => [styles.scanCta, pressed && styles.buttonPressed]}
            >
              <Text style={styles.scanCtaLabel}>Scan QR code</Text>
            </Pressable>
            <TextInput
              accessibilityLabel="Access link"
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              onChangeText={setLinkDraft}
              onSubmitEditing={submitLink}
              placeholder="fleet://join?code=…"
              placeholderTextColor="#6f6c66"
              style={styles.sheetInput}
              value={linkDraft}
            />
            <View style={styles.sheetRow}>
              <Pressable accessibilityRole="button" onPress={() => setAddOpen(false)} style={styles.keepButton}>
                <Text style={styles.keepLabel}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={!linkDraft.trim().toLowerCase().startsWith("fleet://")}
                onPress={submitLink}
                style={({ pressed }) => [
                  styles.button,
                  styles.sheetAdd,
                  !linkDraft.trim().toLowerCase().startsWith("fleet://") && styles.buttonDisabled,
                  pressed && styles.buttonPressed,
                ]}
              >
                <Text style={styles.buttonLabel}>Add</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function describe(code: string | undefined): string {
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
    case "remote_link_pin_not_observed": return "Android could not prove the Console certificate pin for this page.";
    case "remote_link_unverified": return "The Console certificate did not meet the pinned identity policy.";
    case "remote_link_redirect_refused": return "The Console tried to redirect the secure connection.";
    case "remote_link_transport_proof_unavailable": return "Android WebView cannot prove certificate pins for every page transport, so Fleet refused to connect.";
    case "remote_host_readiness_unsupported": return "This Android WebView cannot provide the authenticated readiness channel Fleet requires.";
    default: return "Check that the Console is reachable, then try again.";
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#111318" },
  console: { flex: 1, backgroundColor: "#111318" },
  overlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 36,
    backgroundColor: "#111318",
  },
  eyebrow: { color: "#a89572", fontSize: 11, fontWeight: "700", letterSpacing: 2.2, marginBottom: 14 },
  title: { color: "#f1eee8", fontSize: 29, fontWeight: "600", letterSpacing: -0.5, textAlign: "center" },
  message: { color: "#b9b5ae", fontSize: 16, lineHeight: 24, marginTop: 16, maxWidth: 360, textAlign: "center" },
  detail: { color: "#e6aa87", fontSize: 14, lineHeight: 21, marginTop: 10, maxWidth: 360, textAlign: "center" },
  countdown: { color: "#b9b5ae", fontSize: 13, lineHeight: 20, marginTop: 8, textAlign: "center" },
  button: { backgroundColor: "#d3b578", borderRadius: 8, marginTop: 24, paddingHorizontal: 22, paddingVertical: 12 },
  buttonPressed: { opacity: 0.75 },
  buttonDisabled: { backgroundColor: "#3a3d45" },
  buttonLabel: { color: "#17140e", fontSize: 15, fontWeight: "700" },
  buttonLabelDisabled: { color: "#8b8880" },
  overlayLanding: { marginTop: 28, paddingHorizontal: 14, paddingVertical: 8 },
  overlayLandingLabel: { color: "#a89572", fontSize: 13, fontWeight: "600", letterSpacing: 0.4 },
  landing: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "#111318",
  },
  landingHead: { paddingHorizontal: 24, paddingBottom: 8 },
  landingTitle: { color: "#f1eee8", fontSize: 30, fontWeight: "600", letterSpacing: -0.5 },
  landingSub: { color: "#8b8880", fontSize: 13, lineHeight: 19, marginTop: 4 },
  deck: { flex: 1 },
  deckContent: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 120, gap: 10 },
  empty: { alignItems: "center", paddingTop: 80, paddingHorizontal: 24 },
  emptyTitle: { color: "#d9d5cd", fontSize: 17, fontWeight: "600" },
  emptyBody: { color: "#8b8880", fontSize: 14, lineHeight: 21, marginTop: 8, textAlign: "center" },
  card: {
    backgroundColor: "#1c1f26",
    borderColor: "#2b2e36",
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
  },
  cardPressed: { borderColor: "#d3b578" },
  cardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  cardName: { color: "#f1eee8", fontSize: 15, fontWeight: "600", flexShrink: 1 },
  cardAddr: { color: "#8b8880", fontSize: 12, marginTop: 4, fontVariant: ["tabular-nums"] },
  cardHint: { color: "#e6aa87", fontSize: 12, lineHeight: 18, marginTop: 8 },
  chip: { fontSize: 10, fontWeight: "700", letterSpacing: 0.3, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4, overflow: "hidden" },
  chipConnected: { color: "#8fd8d2", backgroundColor: "#8fd8d226" },
  chipPaired: { color: "#b9b5ae", backgroundColor: "#2b2e36" },
  chipLost: { color: "#e6aa87", backgroundColor: "#e6aa8726" },
  removeRow: { flexDirection: "row", gap: 10, marginTop: 12 },
  removeButton: { backgroundColor: "#e6aa8726", borderRadius: 8, paddingHorizontal: 16, paddingVertical: 9 },
  removeLabel: { color: "#e6aa87", fontSize: 13, fontWeight: "700" },
  keepButton: { borderColor: "#3a3d45", borderWidth: 1, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 9 },
  keepLabel: { color: "#b9b5ae", fontSize: 13, fontWeight: "600" },
  addButton: {
    position: "absolute",
    bottom: 28,
    alignSelf: "center",
    backgroundColor: "#d3b578",
    borderRadius: 999,
    paddingHorizontal: 24,
    paddingVertical: 13,
  },
  addButtonLabel: { color: "#17140e", fontSize: 14, fontWeight: "700" },
  sheetScrim: { flex: 1, justifyContent: "flex-end", backgroundColor: "#0009" },
  sheetScrimTouch: { flex: 1 },
  sheet: {
    backgroundColor: "#1c1f26",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 20,
    paddingBottom: 28,
  },
  sheetTitle: { color: "#f1eee8", fontSize: 17, fontWeight: "600" },
  sheetBody: { color: "#8b8880", fontSize: 13, lineHeight: 19, marginTop: 6 },
  sheetInput: {
    backgroundColor: "#111318",
    borderColor: "#3a3d45",
    borderWidth: 1,
    borderRadius: 10,
    color: "#f1eee8",
    fontSize: 13,
    marginTop: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  sheetRow: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 10, marginTop: 16 },
  sheetAdd: { marginTop: 0 },
  scanCta: {
    alignItems: "center",
    backgroundColor: "#d3b578",
    borderRadius: 10,
    marginTop: 14,
    paddingVertical: 12,
  },
  scanCtaLabel: { color: "#17140e", fontSize: 15, fontWeight: "700" },
  scanner: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "#111318" },
  scannerCamera: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  scannerChrome: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    // The camera keeps showing through; the scrim only makes the copy legible over it.
    backgroundColor: "#111318b8",
  },
  scannerTitle: { color: "#f1eee8", fontSize: 22, fontWeight: "600", letterSpacing: -0.3, textAlign: "center" },
  scannerHint: { color: "#b9b5ae", fontSize: 14, lineHeight: 21, marginTop: 14, maxWidth: 340, textAlign: "center" },
  reticle: {
    borderColor: "#d3b578",
    borderRadius: 16,
    borderWidth: 2,
    height: 220,
    marginTop: 24,
    width: 220,
  },
  scannerActions: { alignItems: "center", marginTop: 26 },
});
