import { requireNativeViewManager } from "expo-modules-core";
import { forwardRef, useImperativeHandle, useRef } from "react";
import type { ComponentType, RefAttributes } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";

export interface FleetConsoleEvent {
  readonly type: "waiting" | "connecting" | "connected" | "error" | "insets";
  readonly code?: string;
  /** Label to show for the visible console; on an error this stays the active console's label when one survives. */
  readonly label?: string;
  /** Origin of the target the event is about; on an error this is the target that failed. */
  readonly origin?: string;
  readonly active?: boolean;
  readonly retryAfterSeconds?: number;
  /** Window chrome insets in dp (status bar, cutout, navigation), sent on "insets" events; the keyboard inset stays native. */
  readonly insetTop?: number;
  readonly insetRight?: number;
  readonly insetBottom?: number;
  readonly insetLeft?: number;
}

export interface FleetConsoleTarget {
  readonly origin: string;
  readonly label: string;
  readonly host: string;
  readonly port: number;
  /** First 8 hex characters of the pinned certificate fingerprint. */
  readonly fingerprint: string;
  readonly active: boolean;
}

export interface FleetConsoleViewHandle {
  retry(): void;
  resume(): void;
  submitAccessLink(link: string): void;
  connectTo(origin: string): void;
  removeTarget(origin: string): void;
  listTargets(): Promise<FleetConsoleTarget[]>;
  navigateBack(): Promise<boolean>;
}

interface NativeFleetConsoleViewHandle {
  retry(): void;
  resume(): void;
  submitAccessLink(link: string): void;
  connectTo(origin: string): void;
  removeTarget(origin: string): void;
  listTargets(): Promise<FleetConsoleTarget[]>;
  navigateBack(): Promise<boolean>;
}

interface FleetConsoleViewProps extends ViewProps {
  readonly onFleetEvent?: (event: NativeSyntheticEvent<FleetConsoleEvent>) => void;
}

const NativeFleetConsoleView = requireNativeViewManager<FleetConsoleViewProps>("FleetConsoleView") as ComponentType<
  FleetConsoleViewProps & RefAttributes<NativeFleetConsoleViewHandle>
>;

export const FleetConsoleView = forwardRef<FleetConsoleViewHandle, FleetConsoleViewProps>(function FleetConsoleView(props, ref) {
  const nativeRef = useRef<NativeFleetConsoleViewHandle>(null);
  useImperativeHandle(ref, () => ({
    retry(): void { nativeRef.current?.retry(); },
    resume(): void { nativeRef.current?.resume(); },
    submitAccessLink(link: string): void { nativeRef.current?.submitAccessLink(link); },
    connectTo(origin: string): void { nativeRef.current?.connectTo(origin); },
    removeTarget(origin: string): void { nativeRef.current?.removeTarget(origin); },
    async listTargets(): Promise<FleetConsoleTarget[]> {
      return (await nativeRef.current?.listTargets()) ?? [];
    },
    async navigateBack(): Promise<boolean> {
      return (await nativeRef.current?.navigateBack()) ?? false;
    },
  }), []);
  return <NativeFleetConsoleView {...props} ref={nativeRef} />;
});
