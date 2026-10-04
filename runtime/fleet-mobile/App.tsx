import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  BackHandler,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
} from "react-native";
import type { AppStateStatus } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";

import { FleetConsoleView } from "./modules/fleet-console-view/src";
import type { FleetAppearance, FleetConsoleEvent, FleetConsoleTarget, FleetConsoleViewHandle } from "./modules/fleet-console-view/src";
import { BottomSheet, OVERLAY_PEAK, Pill, Pill2, PressLayer, useReducedMotion, usePressFace } from "./shell/controls";
import { CheckMark, GridMark, KebabMark, Monogram, PlusMark, QrMark, StatusGlyph } from "./shell/marks";
import { PALETTE, SCANNER, monogramFor, toneFor } from "./shell/palette";
import type { Palette } from "./shell/palette";
import { shellStrings } from "./shell/strings";

type ShellState = "waiting" | "connecting" | "connected" | "error";
type Screen = "landing" | "console" | "scanner";

type WindowInsets = { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number };

const NO_INSETS: WindowInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/** The surfaces the page reports behind the status bar and the gesture bar (impl-spec S-03). */
type Chrome = { readonly top: "bg" | "bg-deep"; readonly bottom: "bg" | "bg-deep" | "surface" };

const PLAIN_CHROME: Chrome = { top: "bg", bottom: "bg" };
const CHROME_FILL = { "bg": "bg", "bg-deep": "bgDeep", "surface": "surface" } as const;

const WORDMARK_FONT = Platform.select({ ios: "ui-serif", android: "serif", default: "serif" });

export default function App(): React.JSX.Element {
  const consoleRef = useRef<FleetConsoleViewHandle>(null);
  const [state, setState] = useState<ShellState>("waiting");
  const stateRef = useRef<ShellState>(state);
  stateRef.current = state;
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [targetLabel, setTargetLabel] = useState<string | null>(null);
  const [targetOrigin, setTargetOrigin] = useState<string | null>(null);
  const [invalidLinkError, setInvalidLinkError] = useState(false);
  const [canReturnToConsole, setCanReturnToConsole] = useState(false);
  const [screen, setScreen] = useState<Screen>("console");
  // The event handler is stable, so it reads what is on screen through these rather than its closure.
  const screenRef = useRef<Screen>(screen);
  screenRef.current = screen;
  const [targets, setTargets] = useState<FleetConsoleTarget[]>([]);
  const [lastError, setLastError] = useState<Record<string, string>>({});
  const [retryLeft, setRetryLeft] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState("");
  const [armRemove, setArmRemove] = useState<string | null>(null);
  const [insets, setInsets] = useState<WindowInsets>(NO_INSETS);
  const [scanError, setScanError] = useState<string | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [appearance, setAppearance] = useState<FleetAppearance>({ colorMode: "system", fontScale: "default" });
  const [chrome, setChrome] = useState<Chrome>(PLAIN_CHROME);
  const [consolesOpen, setConsolesOpen] = useState(false);
  // An add sheet opened from the console sheet goes back to it when dismissed (impl-spec S-12).
  const [addFromConsoles, setAddFromConsoles] = useState(false);
  const systemScheme = useColorScheme();
  // The device owns the mode: "system" follows the OS, a chosen mode holds whatever the OS says.
  const dark = appearance.colorMode === "system" ? systemScheme !== "light" : appearance.colorMode === "dark";
  const palette = PALETTE[dark ? "dark" : "light"];
  const strings = useMemo(() => shellStrings(), []);
  const still = useReducedMotion();
  const styles = useMemo(() => paint(palette), [palette]);
  // A latch rather than state: the camera callback fires faster than a re-render would settle.
  const scannedRef = useRef(false);
  const stateEventSeenRef = useRef(false);
  // Set when the opening state was rebuilt as "no console" before native spoke. A cold-start link
  // can still be in flight then, and its first surviving event must win the screen back.
  const recoveredLandingRef = useRef(false);
  const refreshTargets = useCallback((): void => {
    consoleRef.current?.listTargets().then(setTargets, () => {});
  }, []);

  useEffect(() => {
    // 네이티브 init은 구독보다 앞설 수 있다. 마운트 후 resume으로 보관된 링크 오류를 받는다.
    consoleRef.current?.resume();
    return AppState.addEventListener("change", (next: AppStateStatus) => {
      if (next === "active") consoleRef.current?.resume();
    }).remove;
  }, []);

  useEffect(() => {
    consoleRef.current?.getAppearance().then(setAppearance, () => {});
  }, []);

  useEffect(() => {
    // iOS reports its opening state from the view's init, before this component subscribes, so
    // that first event can be lost. Rebuild it from the saved targets unless an event already came:
    // a saved active console is being reconnected, and no console means the list is the first screen.
    consoleRef.current?.listTargets().then((list) => {
      setTargets(list);
      if (stateEventSeenRef.current) return;
      const active = list.find((target) => target.active);
      if (active) {
        setTargetLabel(active.label);
        setTargetOrigin(active.origin);
        setState("connecting");
      } else {
        recoveredLandingRef.current = true;
        setScreen("landing");
      }
    }, () => {});
  }, []);


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
    if (nativeEvent.type === "appearance") {
      const { colorMode, fontScale } = nativeEvent;
      if (colorMode && fontScale) setAppearance({ colorMode, fontScale });
      return;
    }
    if (nativeEvent.type === "chrome") {
      setChrome({ top: nativeEvent.top ?? "bg", bottom: nativeEvent.bottom ?? "bg" });
      return;
    }
    if (nativeEvent.type === "consoles") {
      consoleRef.current?.listTargets().then(setTargets, () => {});
      setConsolesOpen(true);
      return;
    }
    stateEventSeenRef.current = true;
    if (recoveredLandingRef.current) {
      recoveredLandingRef.current = false;
      if (nativeEvent.type !== "waiting") setScreen("console");
    }
    // A new page state starts from the plain surfaces; the page reports again if a drawer stays open.
    setChrome(PLAIN_CHROME);
    const invalidLink = nativeEvent.type === "error" && nativeEvent.code === "pairing_target_invalid";
    setInvalidLinkError(invalidLink);
    // Any failed attempt beside a live console can step back to it — a rejected or throttled link
    // as much as a malformed one — so the failure is shown rather than hidden behind that console.
    const returnable = nativeEvent.type === "error" && nativeEvent.active === true;
    setCanReturnToConsole(returnable);
    setTargetLabel(nativeEvent.label ?? null);
    setTargetOrigin(nativeEvent.origin ?? null);
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
        setErrorCode(null);
        setRetryLeft(null);
        return;
      case "connecting":
        // While the live console is on screen its replacement loads behind it; anywhere else (the
        // list, a warm link from outside) the attempt shows its progress.
        if (nativeEvent.active && screenRef.current === "console" && stateRef.current === "connected") return;
        setState("connecting");
        setErrorCode(null);
        setRetryLeft(null);
        // A fresh attempt with no console on screen (an intent-delivered link included) shows its progress.
        setScreen("console");
        return;
      case "waiting":
        setState("waiting");
        setErrorCode(null);
        setRetryLeft(null);
        setScreen("landing");
        return;
      case "error":
        setState("error");
        setErrorCode(nativeEvent.code ?? "unknown");
        // Going back to the live console is never something to wait for.
        setRetryLeft(returnable ? null : nativeEvent.retryAfterSeconds ?? null);
        if (invalidLink || returnable) setScreen("console");
        return;
    }
  }, [refreshTargets]);

  const retry = useCallback((): void => {
    setInvalidLinkError(false);
    setCanReturnToConsole(false);
    setErrorCode(null);
    setRetryLeft(null);
    if (canReturnToConsole) {
      // 오류 확인만 끝낸다. 이미 연결된 WebView·gateway·쿠키는 그대로 둔다.
      consoleRef.current?.dismissLinkError();
      setState("connected");
      return;
    }
    setState("connecting");
    consoleRef.current?.retry();
  }, [canReturnToConsole]);

  const showAllConsoles = useCallback((): void => {
    consoleRef.current?.dismissLinkError();
    setScreen("landing");
  }, []);

  const openConsole = useCallback((origin: string): void => {
    setArmRemove(null);
    setScreen("console");
    const current = targets.find((target) => target.origin === origin);
    if (current?.active && (state === "connected" || canReturnToConsole)) {
      consoleRef.current?.dismissLinkError();
      setInvalidLinkError(false);
      setCanReturnToConsole(false);
      setState("connected");
      setErrorCode(null);
      return;
    }
    // The connecting screen names the console the moment it is chosen, before native answers.
    setTargetLabel(current?.label ?? null);
    setTargetOrigin(origin);
    setState("connecting");
    setErrorCode(null);
    setRetryLeft(null);
    consoleRef.current?.connectTo(origin);
  }, [targets, state, canReturnToConsole]);

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
    setAddFromConsoles(false);
    setLinkDraft("");
    setScreen("console");
    setTargetLabel(null);
    setTargetOrigin(null);
    setState("connecting");
    setErrorCode(null);
    setRetryLeft(null);
    consoleRef.current?.submitAccessLink(link);
  }, []);

  const submitLink = useCallback((): void => {
    acceptLink(linkDraft.trim());
  }, [acceptLink, linkDraft]);

  const pasteInstead = useCallback((): void => {
    setScreen("landing");
    setAddOpen(true);
  }, []);

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
      setScanError(strings.notFleetCode);
      return;
    }
    scannedRef.current = true;
    setScanError(null);
    acceptLink(link);
  }, [acceptLink, strings]);

  // Leaving the scanner re-arms it, so a second visit can scan again.
  useEffect(() => {
    if (screen !== "scanner") scannedRef.current = false;
  }, [screen]);

  const closeAdd = useCallback((): void => {
    setAddOpen(false);
    if (addFromConsoles) setConsolesOpen(true);
    setAddFromConsoles(false);
  }, [addFromConsoles]);

  const switchConsole = useCallback((target: FleetConsoleTarget): void => {
    setConsolesOpen(false);
    if (target.active && state === "connected") return;
    openConsole(target.origin);
  }, [state, openConsole]);

  useEffect(() => {
    const onBack = (): boolean => {
      if (addOpen) {
        closeAdd();
        return true;
      }
      if (consolesOpen) {
        setConsolesOpen(false);
        return true;
      }
      if (armRemove) {
        setArmRemove(null);
        return true;
      }
      if (screen === "scanner") {
        setScreen("landing");
        return true;
      }
      if (screen === "console") {
        if (state === "error") {
          showAllConsoles();
          return true;
        }
        const view = consoleRef.current;
        if (!view) {
          setScreen("landing");
          return true;
        }
        view.dismissLinkError();
        view.navigateBack().then((consumed) => {
          if (!consumed) showAllConsoles();
        }, showAllConsoles);
        return true;
      }
      // The console list is where the app starts, so back stops here rather than walking on.
      return true;
    };
    const subscription = BackHandler.addEventListener("hardwareBackPress", onBack);
    return () => subscription.remove();
  }, [addOpen, closeAdd, consolesOpen, armRemove, screen, state, showAllConsoles]);

  const connectionOverlayVisible = screen === "console" && state !== "connected";
  // 랜딩·스캐너처럼 Console을 덮는 전체 화면이 떠 있으면 뒤 WebView를 스크린 리더에서 숨긴다.
  const consoleAccessibilityHidden = connectionOverlayVisible || screen !== "console";
  const retryBlocked = retryLeft !== null && retryLeft > 0;
  const retryTargetLabel = targets.find((target) => target.active)?.label.trim();
  const retryLabel = retryBlocked
    ? strings.retryIn(retryLeft)
    : canReturnToConsole && retryTargetLabel ? strings.backTo(retryTargetLabel)
      : invalidLinkError && retryTargetLabel ? strings.retryWith(retryTargetLabel)
        : strings.retry;
  const linkReady = linkDraft.trim().toLowerCase().startsWith("fleet://");
  const scanning = screen === "scanner";
  const surfaceColor = scanning ? SCANNER.bg : palette.bg;
  const overlayName = targetLabel?.trim() || null;
  const pageShown = screen === "console" && state === "connected";

  // Android draws the gesture-bar icons itself; they follow whatever face the shell shows.
  useEffect(() => {
    consoleRef.current?.setNavigationBarStyle(scanning || dark);
  }, [scanning, dark]);

  return (
    <View style={[styles.root, { backgroundColor: surfaceColor }]}>
      <StatusBar
        barStyle={scanning || palette.scheme === "dark" ? "light-content" : "dark-content"}
        backgroundColor={surfaceColor}
      />
      <View
        style={styles.console}
        collapsable={false}
        accessibilityElementsHidden={consoleAccessibilityHidden}
        importantForAccessibility={consoleAccessibilityHidden ? "no-hide-descendants" : "auto"}
      >
        <FleetConsoleView ref={consoleRef} style={styles.console} onFleetEvent={onFleetEvent} />
      </View>
      {pageShown ? (
        <>
          <View pointerEvents="none" style={[styles.band, { top: 0, height: insets.top, backgroundColor: palette[CHROME_FILL[chrome.top]] }]} />
          <View pointerEvents="none" style={[styles.band, { bottom: 0, height: insets.bottom, backgroundColor: palette[CHROME_FILL[chrome.bottom]] }]} />
        </>
      ) : null}
      {connectionOverlayVisible ? (
        <View style={[styles.cover, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
          <View style={styles.center} accessible={state !== "error"} accessibilityRole="summary">
            {overlayName ? (
              <Monogram
                text={monogramFor(overlayName)}
                color={palette.id[toneFor(targetOrigin ?? overlayName)]}
                ink={palette.bg}
                size={56}
                radius={16}
                fontSize={18}
              />
            ) : null}
            <Text style={styles.centerTitle} numberOfLines={2}>{overlayName ?? strings.wordmark}</Text>
            {state === "connecting" ? (
              <View style={styles.progressRow}>
                <StatusGlyph kind="running" palette={palette} still={still} />
                <Text style={styles.centerText}>{strings.connecting}</Text>
              </View>
            ) : null}
            {state === "waiting" ? <Text style={styles.centerText}>{strings.waiting}</Text> : null}
            {state === "error" ? (
              <>
                <Text style={[styles.centerText, { color: palette.danger }]}>{strings.failed}</Text>
                <Text style={styles.centerText}>{strings.describe(errorCode ?? undefined)}</Text>
                <Pill palette={palette} label={retryLabel} disabled={retryBlocked} onPress={retry} />
                <Pill2 palette={palette} label={strings.allConsoles} onPress={showAllConsoles} />
              </>
            ) : (
              <TextButton label={strings.allConsoles} onPress={showAllConsoles} palette={palette} styles={styles} />
            )}
          </View>
        </View>
      ) : null}
      {screen === "landing" ? (
        <View style={[styles.cover, { paddingTop: insets.top }]}>
          <View style={styles.landingHead}>
            <Text accessibilityRole="header" style={styles.wordmark}>{strings.wordmark}</Text>
            <Text style={styles.landingSub}>{strings.landingSub}</Text>
          </View>
          <ScrollView
            style={styles.deck}
            contentContainerStyle={[styles.deckContent, { paddingBottom: 100 + insets.bottom }]}
            showsVerticalScrollIndicator={false}
          >
            {targets.length === 0 ? <Text style={styles.empty}>{strings.empty}</Text> : (
              <View style={styles.group}>
                {targets.map((target, index) => (
                  <ConsoleRow
                    key={target.origin}
                    target={target}
                    first={index === 0}
                    last={index === targets.length - 1}
                    connectedNow={target.active && state === "connected"}
                    pairingLost={lastError[target.origin] === "remote_host_not_paired"}
                    armed={armRemove === target.origin}
                    palette={palette}
                    strings={strings}
                    styles={styles}
                    onOpen={openConsole}
                    onArm={setArmRemove}
                    onRemove={removeConsole}
                  />
                ))}
              </View>
            )}
          </ScrollView>
          <Pill
            palette={palette}
            label={strings.addConsole}
            icon={<PlusMark color={palette.onInverse} size={18} stroke={2.2} />}
            onPress={() => { setArmRemove(null); setAddOpen(true); }}
            style={[styles.fab, { bottom: 18 + insets.bottom }]}
          />
        </View>
      ) : null}
      {scanning ? (
        <View style={[styles.scanner, { paddingTop: insets.top }]}>
          {permission?.granted === true ? (
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={onBarcodeScanned}
            />
          ) : null}
          {/* Without camera access the viewfinder keeps its place but draws nothing (impl-spec S-24). */}
          <View style={styles.viewfinder}>
            {permission?.granted === true ? (
              <>
                <View style={[styles.corner, styles.cornerTopLeft]} />
                <View style={[styles.corner, styles.cornerTopRight]} />
                <View style={[styles.corner, styles.cornerBottomLeft]} />
                <View style={[styles.corner, styles.cornerBottomRight]} />
              </>
            ) : null}
          </View>
          <Text style={styles.scanCaption}>
            {permission?.granted === true
              ? strings.scanCaption
              : permission?.canAskAgain === false ? strings.cameraOff(Platform.OS === "ios") : strings.cameraAsk}
          </Text>
          {scanError ? <Text style={styles.scanError}>{scanError}</Text> : null}
          <View style={[styles.scanBar, { bottom: 28 + insets.bottom }]}>
            {permission?.granted === true ? (
              <>
                <ScanButton label={strings.cancel} onPress={showAllConsoles} styles={styles} />
                <ScanButton label={strings.pasteLink} onPress={pasteInstead} styles={styles} />
              </>
            ) : (
              <>
                {permission?.canAskAgain === false ? null : (
                  <ScanButton label={strings.allowCamera} inverse onPress={() => { void requestPermission(); }} styles={styles} />
                )}
                {/* The paste path never goes away — a denied camera, or a code that will not read, still needs a way in. */}
                <ScanButton label={strings.pasteLink} onPress={pasteInstead} styles={styles} />
                <ScanButton label={strings.cancel} onPress={showAllConsoles} styles={styles} />
              </>
            )}
          </View>
        </View>
      ) : null}
      <BottomSheet
        open={consolesOpen}
        onClose={() => setConsolesOpen(false)}
        title={strings.consoleSheet}
        closeLabel={strings.close}
        palette={palette}
        insetBottom={insets.bottom}
        still={still}
      >
        {targets.map((target) => {
          const current = target.active && state === "connected";
          const lost = lastError[target.origin] === "remote_host_not_paired";
          return (
            <SheetRow
              key={target.origin}
              palette={palette}
              styles={styles}
              lead={(
                <Monogram
                  text={monogramFor(target.label)}
                  color={palette.id[toneFor(target.origin)]}
                  ink={palette.bg}
                  size={36}
                  radius={18}
                  fontSize={11}
                />
              )}
              label={target.label}
              detail={current ? strings.nowConnected : lost ? strings.chipLost : `${target.host}:${target.port}`}
              trail={current ? <CheckMark color={palette.text} /> : undefined}
              onPress={() => switchConsole(target)}
            />
          );
        })}
        <SheetRow
          palette={palette}
          styles={styles}
          lead={<PlusMark color={palette.text} />}
          label={strings.addConsole}
          onPress={() => { setConsolesOpen(false); setAddFromConsoles(true); setAddOpen(true); }}
        />
        <SheetRow
          palette={palette}
          styles={styles}
          lead={<GridMark color={palette.text} />}
          label={strings.seeAllConsoles}
          detail={strings.seeAllConsolesSub}
          onPress={() => { setConsolesOpen(false); showAllConsoles(); }}
        />
      </BottomSheet>
      <BottomSheet
        open={addOpen}
        onClose={closeAdd}
        title={strings.addConsole}
        closeLabel={strings.close}
        palette={palette}
        insetBottom={insets.bottom}
        still={still}
        footer={(
          <>
            <Pill2 palette={palette} label={strings.cancel} onPress={closeAdd} />
            <Pill2 palette={palette} label={strings.add} variant="inverse" disabled={!linkReady} onPress={submitLink} />
          </>
        )}
      >
        <Text style={styles.sheetLead}>{strings.addLead}</Text>
        <Pill
          palette={palette}
          wide
          label={strings.scanQr}
          icon={<QrMark color={palette.onInverse} size={18} stroke={2.2} />}
          onPress={openScanner}
        />
        <TextInput
          accessibilityLabel={strings.linkLabel}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardAppearance={palette.scheme}
          onChangeText={setLinkDraft}
          onSubmitEditing={submitLink}
          placeholder="fleet://join?…"
          placeholderTextColor={palette.textMuted}
          selectionColor={palette.text}
          style={styles.field}
          value={linkDraft}
        />
      </BottomSheet>
    </View>
  );
}

function SheetRow({ palette, styles, lead, label, detail, trail, onPress }: {
  readonly palette: Palette;
  readonly styles: ReturnType<typeof paint>;
  readonly lead: React.ReactNode;
  readonly label: string;
  readonly detail?: string;
  readonly trail?: React.ReactNode;
  readonly onPress: () => void;
}): React.JSX.Element {
  const press = usePressFace();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={styles.sheetRow}
    >
      <PressLayer face={press.face} color={palette.selected} peak={1} shape={styles.sheetRowShape} />
      {lead}
      <View style={styles.rowText}>
        <Text style={styles.sheetRowLabel} numberOfLines={1}>{label}</Text>
        {detail ? <Text style={styles.sheetRowDetail} numberOfLines={1}>{detail}</Text> : null}
      </View>
      {trail}
    </Pressable>
  );
}

/** A text button (R1 pill): no face of its own; pressing shows a `selected` pill behind the words. */
function TextButton({ label, onPress, palette, styles }: {
  readonly label: string;
  readonly onPress: () => void;
  readonly palette: Palette;
  readonly styles: ReturnType<typeof paint>;
}): React.JSX.Element {
  const press = usePressFace();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} onPressIn={press.onPressIn} onPressOut={press.onPressOut} style={styles.textButton}>
      <PressLayer face={press.face} color={palette.selected} peak={1} shape={styles.textButtonShape} />
      <Text style={styles.textButtonLabel}>{label}</Text>
    </Pressable>
  );
}

function ScanButton({ label, onPress, inverse, styles }: {
  readonly label: string;
  readonly onPress: () => void;
  readonly inverse?: boolean;
  readonly styles: ReturnType<typeof paint>;
}): React.JSX.Element {
  const press = usePressFace();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={[styles.scanButton, inverse && styles.scanButtonInverse]}
    >
      <PressLayer face={press.face} color={inverse ? SCANNER.inverseInk : SCANNER.ink} peak={OVERLAY_PEAK} shape={styles.scanButtonShape} />
      <Text style={[styles.scanButtonLabel, inverse && styles.scanButtonInverseLabel]}>{label}</Text>
    </Pressable>
  );
}

/**
 * The card's ⋮ (R1 circle 36). It owns its press face, so the face starts clear every time the button
 * comes back after the inline remove/keep row closes; the face is also cleared the moment it opens that row.
 */
function KebabButton({ label, palette, styles, onPress }: {
  readonly label: string;
  readonly palette: Palette;
  readonly styles: ReturnType<typeof paint>;
  readonly onPress: () => void;
}): React.JSX.Element {
  const press = usePressFace();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => { press.clear(); onPress(); }}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={styles.kebab}
    >
      <PressLayer face={press.face} color={palette.selected} peak={1} shape={styles.kebabShape} />
      <KebabMark color={palette.text} />
    </Pressable>
  );
}

function ConsoleRow({ target, first, last, connectedNow, pairingLost, armed, palette, strings, styles, onOpen, onArm, onRemove }: {
  readonly target: FleetConsoleTarget;
  readonly first: boolean;
  readonly last: boolean;
  readonly connectedNow: boolean;
  readonly pairingLost: boolean;
  readonly armed: boolean;
  readonly palette: Palette;
  readonly strings: ReturnType<typeof shellStrings>;
  readonly styles: ReturnType<typeof paint>;
  readonly onOpen: (origin: string) => void;
  readonly onArm: (origin: string | null) => void;
  readonly onRemove: (origin: string) => void;
}): React.JSX.Element {
  // The whole row takes the pressed face (R2), as the web group row does, not just the tappable part.
  const press = usePressFace();
  return (
    <View style={[styles.row, first && styles.rowFirst, last && styles.rowLast]}>
      <PressLayer face={press.face} color={palette.selected} peak={1} shape={[styles.rowShape, first && styles.rowFirst, last && styles.rowLast]} />
      <Pressable
        accessibilityRole="button"
        onPress={() => onOpen(target.origin)}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={styles.rowMain}
      >
        <Monogram
          text={monogramFor(target.label)}
          color={palette.id[toneFor(target.origin)]}
          ink={palette.bg}
          size={36}
          radius={18}
          fontSize={11}
        />
        <View style={styles.rowText}>
          <Text style={styles.rowName} numberOfLines={1}>{target.label}</Text>
          {/* The pin prefix stays visible: it is how the owner tells two consoles at one address apart. */}
          <Text style={styles.rowAddress} numberOfLines={1}>{`${target.host}:${target.port} · pin ${target.fingerprint}…`}</Text>
          {pairingLost ? <Text style={styles.rowHint}>{strings.lostHint}</Text> : null}
        </View>
      </Pressable>
      {armed ? (
        <View style={styles.rowActions}>
          <Pill2 palette={palette} label={strings.remove} variant="danger" onPress={() => onRemove(target.origin)} />
          <Pill2 palette={palette} label={strings.keep} onPress={() => onArm(null)} />
        </View>
      ) : (
        <View style={styles.rowActions}>
          <View style={styles.chip}>
            {connectedNow ? <StatusGlyph kind="idle" palette={palette} still /> : null}
            <Text style={[styles.chipLabel, pairingLost && !connectedNow && { color: palette.danger }]}>
              {connectedNow ? strings.chipConnected : pairingLost ? strings.chipLost : strings.chipPaired}
            </Text>
          </View>
          <KebabButton label={strings.menuFor(target.label)} palette={palette} styles={styles} onPress={() => onArm(target.origin)} />
        </View>
      )}
    </View>
  );
}

function paint(p: Palette) {
  return StyleSheet.create({
    root: { flex: 1 },
    console: { flex: 1, backgroundColor: p.bg },
    cover: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: p.bg },
    center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 36 },
    centerTitle: { color: p.text, fontSize: 18, lineHeight: 24, fontWeight: "600", textAlign: "center" },
    centerText: { color: p.textMuted, fontSize: 15, lineHeight: 22, textAlign: "center", flexShrink: 1 },
    progressRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    textButton: { paddingHorizontal: 14, paddingVertical: 8 },
    textButtonShape: { borderRadius: 16 },
    textButtonLabel: { color: p.textMuted, fontSize: 15, fontWeight: "500" },
    landingHead: { paddingTop: 28, paddingHorizontal: 28, paddingBottom: 10 },
    wordmark: { color: p.text, fontFamily: WORDMARK_FONT, fontSize: 30, lineHeight: 36, fontWeight: "500", letterSpacing: -0.3 },
    landingSub: { color: p.textMuted, fontSize: 15, lineHeight: 21, marginTop: 4 },
    deck: { flex: 1 },
    deckContent: { paddingTop: 8, paddingHorizontal: 14, gap: 10 },
    empty: { color: p.textMuted, fontSize: 14, lineHeight: 20, paddingTop: 4, paddingHorizontal: 28, paddingBottom: 8 },
    group: { gap: 2 },
    row: {
      backgroundColor: p.surface,
      minHeight: 72,
      borderRadius: 4,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingRight: 16,
    },
    rowFirst: { borderTopLeftRadius: 22, borderTopRightRadius: 22 },
    rowLast: { borderBottomLeftRadius: 22, borderBottomRightRadius: 22 },
    rowMain: {
      flex: 1,
      minWidth: 0,
      alignSelf: "stretch",
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 10,
      paddingLeft: 16,
    },
    rowShape: { borderRadius: 4 },
    rowText: { flex: 1, minWidth: 0 },
    rowName: { color: p.text, fontSize: 17, lineHeight: 24 },
    rowAddress: { color: p.textMuted, fontSize: 15, lineHeight: 21, marginTop: 1, fontVariant: ["tabular-nums"] },
    rowHint: { color: p.danger, fontSize: 13, lineHeight: 18, marginTop: 1 },
    rowActions: { flexDirection: "row", alignItems: "center", gap: 12 },
    chip: { height: 28, paddingHorizontal: 10, borderRadius: 14, backgroundColor: p.chip, flexDirection: "row", alignItems: "center", gap: 6 },
    chipLabel: { color: p.text, fontSize: 13, lineHeight: 18 },
    kebab: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
    kebabShape: { borderRadius: 18 },
    fab: { position: "absolute", right: 16 },
    band: { position: "absolute", left: 0, right: 0 },
    sheetRow: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 60, padding: 8, borderRadius: 12 },
    sheetRowShape: { borderRadius: 12 },
    sheetRowLabel: { color: p.text, fontSize: 16, lineHeight: 22 },
    sheetRowDetail: { color: p.textMuted, fontSize: 13, lineHeight: 18 },
    sheetLead: { color: p.textMuted, fontSize: 15, lineHeight: 21, paddingHorizontal: 4, marginBottom: 6 },
    field: {
      backgroundColor: p.field,
      borderColor: p.hairlineStrong,
      borderWidth: 1,
      borderRadius: 14,
      color: p.text,
      fontSize: 16,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    scanner: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: SCANNER.bg, alignItems: "center" },
    viewfinder: { width: 240, height: 240, marginTop: 190 },
    corner: { position: "absolute", width: 36, height: 36, borderColor: SCANNER.ink },
    cornerTopLeft: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 24 },
    cornerTopRight: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 24 },
    cornerBottomLeft: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 24 },
    cornerBottomRight: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 24 },
    scanCaption: { color: SCANNER.caption, fontSize: 15, lineHeight: 21, marginTop: 28, paddingHorizontal: 32, textAlign: "center" },
    scanError: { color: SCANNER.danger, fontSize: 14, lineHeight: 20, marginTop: 8, paddingHorizontal: 32, textAlign: "center" },
    scanBar: { position: "absolute", left: 16, right: 16, flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 10 },
    scanButton: { height: 44, paddingHorizontal: 18, borderRadius: 22, backgroundColor: SCANNER.button, alignItems: "center", justifyContent: "center" },
    scanButtonShape: { borderRadius: 22 },
    scanButtonLabel: { color: SCANNER.ink, fontSize: 15 },
    scanButtonInverse: { backgroundColor: SCANNER.ink },
    scanButtonInverseLabel: { color: SCANNER.inverseInk, fontWeight: "600" },
  });
}
