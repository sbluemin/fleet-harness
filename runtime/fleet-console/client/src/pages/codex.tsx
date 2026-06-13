import { useEffect, useRef } from "react";

import { mountCodexApp } from "../codex/main.js";

export function Codex() {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    return mountCodexApp(root);
  }, []);

  return <div className="codex-host" ref={rootRef} />;
}
