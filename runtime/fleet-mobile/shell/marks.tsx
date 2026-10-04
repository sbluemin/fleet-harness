/**
 * Marks for the native screens, drawn with plain views: the shell carries no SVG renderer, and
 * these few shapes do not justify adding one. Geometry follows the web icon set (24 viewBox,
 * stroke 1.7, round caps) scaled to the display size.
 */
import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";

import type { Palette } from "./palette";

interface MarkProps {
  readonly color: string;
  readonly size?: number;
  /** Stroke width in viewBox units; the web pill icon uses 2.2. */
  readonly stroke?: number;
}

function scaled(size: number, units: number): number {
  return (size / 24) * units;
}

export function PlusMark({ color, size = 22, stroke = 1.7 }: MarkProps): React.JSX.Element {
  const width = scaled(size, stroke);
  const length = scaled(size, 14);
  const bar = { position: "absolute", backgroundColor: color, borderRadius: width / 2 } as const;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <View style={[bar, { width: length, height: width }]} />
      <View style={[bar, { width, height: length }]} />
    </View>
  );
}

export function CloseMark({ color, size = 22, stroke = 1.7 }: MarkProps): React.JSX.Element {
  const width = scaled(size, stroke);
  const length = scaled(size, 12 * Math.SQRT2);
  const bar = { position: "absolute", width: length, height: width, backgroundColor: color, borderRadius: width / 2 } as const;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <View style={[bar, { transform: [{ rotate: "45deg" }] }]} />
      <View style={[bar, { transform: [{ rotate: "-45deg" }] }]} />
    </View>
  );
}

export function KebabMark({ color, size = 22 }: MarkProps): React.JSX.Element {
  const dot = scaled(size, 2.8);
  const gap = scaled(size, 7) - dot;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center", gap }}>
      {[0, 1, 2].map((index) => (
        <View key={index} style={{ width: dot, height: dot, borderRadius: dot / 2, backgroundColor: color }} />
      ))}
    </View>
  );
}

export function QrMark({ color, size = 22, stroke = 1.7 }: MarkProps): React.JSX.Element {
  const unit = size / 24;
  const line = stroke * unit;
  const finder = (left: number, top: number): React.JSX.Element => (
    <View
      style={{
        position: "absolute",
        left: left * unit - line / 2,
        top: top * unit - line / 2,
        width: 6 * unit + line,
        height: 6 * unit + line,
        borderWidth: line,
        borderColor: color,
        borderRadius: unit + line / 2,
      }}
    />
  );
  const cell = (left: number, top: number): React.JSX.Element => (
    <View style={{ position: "absolute", left: left * unit, top: top * unit, width: 2 * unit, height: 2 * unit, backgroundColor: color }} />
  );
  return (
    <View style={{ width: size, height: size }}>
      {finder(4, 4)}
      {finder(14, 4)}
      {finder(4, 14)}
      {cell(14, 14)}
      {cell(18, 18)}
      {cell(14, 18)}
      {cell(18, 14)}
    </View>
  );
}

/** The two status glyphs the native screens show (impl-spec S-01): running and idle. */
export function StatusGlyph({ kind, palette, still }: { readonly kind: "running" | "idle"; readonly palette: Palette; readonly still: boolean }): React.JSX.Element {
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (kind !== "running" || still) {
      turn.stopAnimation();
      return;
    }
    const loop = Animated.loop(Animated.timing(turn, { toValue: 1, duration: 1400, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [kind, still, turn]);
  if (kind === "idle") {
    return (
      <View style={[glyph.ring, { borderColor: palette.hairlineStrong }]}>
        <View style={[glyph.dot, { backgroundColor: palette.idle }]} />
      </View>
    );
  }
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <View style={[glyph.ring, { borderColor: palette.runningRing }]}>
      <Animated.View
        style={[
          glyph.arc,
          { borderTopColor: palette.running, borderRightColor: palette.running, transform: [{ rotate }] },
        ]}
      />
    </View>
  );
}

export function Monogram({ text, color, ink, size, radius, fontSize }: {
  readonly text: string;
  readonly color: string;
  readonly ink: string;
  readonly size: number;
  readonly radius: number;
  readonly fontSize: number;
}): React.JSX.Element {
  return (
    <View style={{ width: size, height: size, borderRadius: radius, backgroundColor: color, alignItems: "center", justifyContent: "center" }}>
      <Text allowFontScaling={false} style={{ color: ink, fontSize, fontWeight: "700", letterSpacing: fontSize * 0.02 }}>{text}</Text>
    </View>
  );
}

const glyph = StyleSheet.create({
  ring: { width: 12, height: 12, borderRadius: 6, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  dot: { width: 4, height: 4, borderRadius: 2 },
  arc: {
    position: "absolute",
    top: -1.5,
    left: -1.5,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: "transparent",
  },
});
