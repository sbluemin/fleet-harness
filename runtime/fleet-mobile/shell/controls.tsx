/** Shared controls of the native screens: the two pill buttons and the bottom sheet (impl-spec S-02, S-12). */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import type { StyleProp, ViewStyle } from "react-native";

import { CloseMark } from "./marks";
import type { Palette } from "./palette";

const EMPHASIZED_DECELERATE = Easing.bezier(0.05, 0.7, 0.1, 1);
const EMPHASIZED_ACCELERATE = Easing.bezier(0.3, 0, 0.8, 0.15);

/** The primary pill: inverse face, 48 high. */
export function Pill({ palette, label, icon, onPress, disabled, wide, style }: {
  readonly palette: Palette;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly wide?: boolean;
  readonly style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        controls.pill,
        { backgroundColor: palette.inverse },
        wide && controls.wide,
        disabled && controls.disabled,
        pressed && !disabled && controls.pressed,
        style,
      ]}
    >
      {icon}
      <Text numberOfLines={1} style={[controls.pillLabel, { color: palette.onInverse }]}>{label}</Text>
    </Pressable>
  );
}

/** The secondary pill: chip face, 40 high; `inverse` and `danger` are its two variants. */
export function Pill2({ palette, label, onPress, variant, disabled }: {
  readonly palette: Palette;
  readonly label: string;
  readonly onPress: () => void;
  readonly variant?: "inverse" | "danger";
  readonly disabled?: boolean;
}): React.JSX.Element {
  const inverse = variant === "inverse";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        controls.pill2,
        { backgroundColor: inverse ? palette.inverse : palette.chip },
        disabled && controls.disabled,
        pressed && !disabled && controls.pressed,
      ]}
    >
      <Text
        numberOfLines={1}
        style={[
          controls.pill2Label,
          { color: inverse ? palette.onInverse : variant === "danger" ? palette.danger : palette.text },
          inverse && controls.pill2Strong,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * A bottom sheet over a scrim. The scrim fades in 200ms while the panel rises 300ms; the handle
 * drags it down and a pull past 110dp closes it. `insetBottom` is the gesture-bar inset the panel
 * paints under, so the bar shows the sheet surface while it is open (impl-spec S-03).
 */
export function BottomSheet({ open, onClose, title, closeLabel, palette, insetBottom, still, footer, children }: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly closeLabel: string;
  readonly palette: Palette;
  readonly insetBottom: number;
  readonly still: boolean;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}): React.JSX.Element {
  const [mounted, setMounted] = useState(open);
  const window = useWindowDimensions();
  const [panelHeight, setPanelHeight] = useState(900);
  const shown = useRef(new Animated.Value(0)).current;
  const scrim = useRef(new Animated.Value(0)).current;
  const drag = useRef(new Animated.Value(0)).current;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (open) {
      setMounted(true);
      drag.setValue(0);
      Animated.parallel([
        Animated.timing(shown, { toValue: 1, duration: still ? 0 : 300, easing: EMPHASIZED_DECELERATE, useNativeDriver: true }),
        Animated.timing(scrim, { toValue: 1, duration: still ? 0 : 200, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      ]).start();
      return;
    }
    Animated.parallel([
      Animated.timing(shown, { toValue: 0, duration: still ? 0 : 220, easing: EMPHASIZED_ACCELERATE, useNativeDriver: true }),
      Animated.timing(scrim, { toValue: 0, duration: still ? 0 : 200, useNativeDriver: true }),
    ]).start(({ finished }) => {
      if (finished) setMounted(false);
    });
  }, [open, still, shown, scrim, drag]);

  const pan = useMemo(() => PanResponder.create({
    // The handle zone holds nothing tappable, so it claims the touch outright; the sheet follows
    // only once the finger has travelled past 6dp, as the web sheet does.
    onStartShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderMove: (_event, gesture) => drag.setValue(gesture.dy > 6 ? gesture.dy : 0),
    onPanResponderRelease: (_event, gesture) => {
      if (gesture.dy > 110) {
        closeRef.current();
        return;
      }
      Animated.timing(drag, { toValue: 0, duration: still ? 0 : 200, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    },
    onPanResponderTerminate: () => {
      Animated.timing(drag, { toValue: 0, duration: still ? 0 : 200, useNativeDriver: true }).start();
    },
  }), [drag, still]);

  const rise = shown.interpolate({ inputRange: [0, 1], outputRange: [panelHeight, 0] });
  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView style={controls.sheetRoot} behavior="padding">
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: palette.scrim, opacity: scrim }]}>
          <Pressable accessibilityLabel={closeLabel} style={StyleSheet.absoluteFill} onPress={onClose} />
        </Animated.View>
        <Animated.View
          accessibilityViewIsModal
          onLayout={(event) => setPanelHeight(event.nativeEvent.layout.height)}
          style={[controls.sheet, { maxHeight: window.height - 56, backgroundColor: palette.surface, transform: [{ translateY: Animated.add(rise, drag) }] }]}
        >
            <View style={controls.handleZone} {...pan.panHandlers}>
              <View style={[controls.handle, { backgroundColor: palette.handle }]} />
            </View>
            <View style={controls.head}>
              <Text accessibilityRole="header" style={[controls.title, { color: palette.text }]}>{title}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={closeLabel} onPress={onClose} style={({ pressed }) => [controls.close, pressed && { backgroundColor: palette.selected }]}>
                <CloseMark color={palette.textMuted} />
              </Pressable>
            </View>
            <View style={controls.body}>{children}</View>
            {footer ? <View style={controls.footer}>{footer}</View> : null}
            <View style={{ height: 18 + insetBottom }} />
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const controls = StyleSheet.create({
  pill: {
    height: 48,
    paddingLeft: 18,
    paddingRight: 22,
    borderRadius: 24,
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "center",
    gap: 8,
    maxWidth: "100%",
  },
  wide: { alignSelf: "stretch", justifyContent: "center" },
  pillLabel: { fontSize: 16, fontWeight: "600", flexShrink: 1 },
  pill2: { height: 40, paddingHorizontal: 16, borderRadius: 20, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  pill2Label: { fontSize: 15, fontWeight: "500" },
  pill2Strong: { fontWeight: "600" },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
  sheetRoot: { flex: 1, justifyContent: "flex-end" },
  sheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28 },
  handleZone: { height: 22, alignItems: "center", justifyContent: "center" },
  handle: { width: 32, height: 4, borderRadius: 2 },
  head: { paddingTop: 2, paddingHorizontal: 56, paddingBottom: 10 },
  title: { fontSize: 18, lineHeight: 24, fontWeight: "600", textAlign: "center" },
  close: { position: "absolute", right: 12, top: -8, width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  body: { paddingHorizontal: 16, gap: 10 },
  footer: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 8, paddingTop: 10, paddingHorizontal: 16 },
});
