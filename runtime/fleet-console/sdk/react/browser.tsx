import * as React from "react";

export interface PluginErrorBoundaryProps {
  readonly children: React.ReactNode;
  readonly fallback?: React.ReactNode;
  readonly onError?: (error: unknown) => void;
}

interface PluginErrorBoundaryState {
  readonly hasError: boolean;
}

const DEFAULT_PLUGIN_ERROR_FALLBACK = <div className="fc-plugin-error">Plugin failed to render.</div>;

export { React };
export default React;

export class PluginErrorBoundary extends React.Component<PluginErrorBoundaryProps, PluginErrorBoundaryState> {
  readonly state: PluginErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): PluginErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    this.props.onError?.(error);
  }

  render(): React.ReactNode {
    if (this.state.hasError) return this.props.fallback ?? DEFAULT_PLUGIN_ERROR_FALLBACK;
    return this.props.children;
  }
}
