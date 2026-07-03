import * as React from "react";

import type { ClientApiCapability } from "@fleet-console/sdk/plugin";

import type { BenchContender } from "../server/bench-store.js";

type CardStatus = "running" | "awaiting" | "succeeded" | "failed" | "idle";

interface ContenderCardProps {
  readonly contender: BenchContender;
  readonly api: ClientApiCapability;
  readonly isWinner: boolean;
}

interface ScrollbackPayload {
  readonly scrollback: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

const STATUS_POLL_MS = 500;
const SCROLLBACK_POLL_MS = 1000;
const SCROLLBACK_LINES = 40;

export function ContenderCard({ contender, api, isWinner }: ContenderCardProps) {
  const [status, setStatus] = React.useState<CardStatus>("idle");
  const [scrollback, setScrollback] = React.useState("");

  React.useEffect(() => {
    let alive = true;

    async function run() {
      while (alive) {
        try {
          const res = await fetch(`/api/v1/operations/${encodeURIComponent(contender.opId)}`);
          if (!alive) break;
          if (res.ok) {
            setStatus("running");
          } else if (res.status === 404) {
            setStatus("succeeded");
            break;
          }
        } catch {
          // 네트워크 에러 무시
        }
        await sleep(STATUS_POLL_MS);
      }
    }

    void run();
    return () => { alive = false; };
  }, [contender.opId]);

  React.useEffect(() => {
    if (!contender.sessionId) return;
    let alive = true;

    async function run() {
      while (alive) {
        try {
          const res = await api.fetch(
            "terminal",
            `agent/sessions/${encodeURIComponent(contender.sessionId!)}/scrollback?lines=${SCROLLBACK_LINES}`,
          );
          if (!alive) break;
          const data = await res.json() as ScrollbackPayload;
          setScrollback(data.scrollback ?? "");
        } catch {
          // scrollback 에러 무시
        }
        await sleep(SCROLLBACK_POLL_MS);
      }
    }

    void run();
    return () => { alive = false; };
  }, [contender.sessionId, api]);

  const cardClass = [
    "bench-card",
    isWinner ? "bench-card--winner" : "",
    status === "running" ? "bench-card--running" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={cardClass}>
      <div className="bench-card-header">
        <span className="bench-card-cli">{contender.cliId}</span>
        <span className={`bench-card-status bench-card-status--${status}`} title={status} />
        {isWinner && <span className="bench-card-winner-pip" aria-label="Winner">★</span>}
      </div>
      <pre className="bench-card-scrollback">
        {scrollback || (contender.sessionId ? "Waiting for output…" : "No session")}
      </pre>
    </div>
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
