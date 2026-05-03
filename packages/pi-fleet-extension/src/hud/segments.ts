import { hostname as osHostname } from "node:os";
import { basename } from "node:path";
import type { ColorValue, RenderedSegment, SegmentContext, SemanticColor, StatusLineSegment, StatusLineSegmentId } from "./types.js";
import { fg, rainbow, applyColor, getIcons, SEP_DOT, getThinkingText } from "./theme.js";

const APC_REGEX = /\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const BIDI_CONTROL_REGEX = /[\u202A-\u202E\u2066-\u2069]/g;
const CONTROL_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;
const CSI_REGEX = /\x1b\[[0-9;?]*[A-Za-z]/g;
const DCS_REGEX = /\x1bP[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ESC_SINGLE_REGEX = /\x1b[@-_]/g;
const OSC_REGEX = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

// ═══════════════════════════════════════════════════════════════════════════
// Segment Implementations
// ═══════════════════════════════════════════════════════════════════════════

const piSegment: StatusLineSegment = {
  id: "pi",
  render(ctx) {
    const icons = getIcons();
    const opts = ctx.options.pi ?? {};

    // label이 지정되면 해당 텍스트 표시, showUser: true이면 OS 사용자명 표시
    if (opts.label) {
      return { content: color(ctx, "pi", opts.label), visible: true };
    }
    if (opts.showUser) {
      const username =
        process.env.USER ||
        process.env.USERNAME ||
        process.env.LOGNAME ||
        "user";
      return { content: color(ctx, "pi", username), visible: true };
    }

    if (!icons.pi) return { content: "", visible: false };
    const content = `${icons.pi} `;
    return { content: color(ctx, "pi", content), visible: true };
  },
};

const modelSegment: StatusLineSegment = {
  id: "model",
  render(ctx) {
    const icons = getIcons();
    const opts = ctx.options.model ?? {};

    // 기본은 display name 우선이지만, Fleet ACP는 구분 postfix를 보이기 위해 id를 우선 표시
    const rawModelName = ctx.model?.provider === "Fleet ACP"
      ? (ctx.model?.id || ctx.model?.name || "no-model")
      : (ctx.model?.name || ctx.model?.id || "no-model");
    const modelName = sanitizePlainDisplay(rawModelName) || "no-model";
    let content = withIcon(icons.model, modelName);

    // Add thinking level with dot separator
    if (opts.showThinkingLevel !== false && ctx.model?.reasoning) {
      const level = ctx.thinkingLevel || "off";
      if (level !== "off") {
        const thinkingText = getThinkingText(level);
        if (thinkingText) {
          content += `${SEP_DOT}${thinkingText}`;
        }
      }
    }

    // Fleet CC provider일 때 배지 추가
    if (ctx.model?.provider === "Fleet CC") {
      content += " " + applyColor(ctx.theme, "#ff9500", "\x1b[1m[Fleet CC]\x1b[22m");
    }

    return { content: color(ctx, "model", content), visible: true };
  },
};

const pathSegment: StatusLineSegment = {
  id: "path",
  render(ctx) {
    const icons = getIcons();
    const opts = ctx.options.path ?? {};
    const mode = opts.mode ?? "basename";

    let pwd = process.cwd();
    const home = process.env.HOME || process.env.USERPROFILE;

    if (mode === "basename") {
      // Just the last directory component (cross-platform)
      pwd = basename(pwd) || pwd;
    } else {
      // Abbreviate home directory for abbreviated/full modes
      if (home && pwd.startsWith(home)) {
        pwd = `~${pwd.slice(home.length)}`;
      }

      // Strip /work/ prefix (common in containers)
      if (pwd.startsWith("/work/")) {
        pwd = pwd.slice(6);
      }

      // Truncate if too long (only for abbreviated mode)
      if (mode === "abbreviated") {
        const maxLen = opts.maxLength ?? 40;
        if (pwd.length > maxLen) {
          pwd = `…${pwd.slice(-(maxLen - 1))}`;
        }
      }
    }

    const content = withIcon(icons.folder, pwd);
    return { content: color(ctx, "path", content), visible: true };
  },
};

const gitSegment: StatusLineSegment = {
  id: "git",
  render(ctx) {
    const icons = getIcons();
    const opts = ctx.options.git ?? {};
    const { branch, staged, unstaged, untracked } = ctx.git;
    const gitStatus = (staged > 0 || unstaged > 0 || untracked > 0)
      ? { staged, unstaged, untracked }
      : null;

    if (!branch && !gitStatus) return { content: "", visible: false };

    const isDirty = gitStatus && (gitStatus.staged > 0 || gitStatus.unstaged > 0 || gitStatus.untracked > 0);
    const showBranch = opts.showBranch !== false;
    const branchColor: SemanticColor = isDirty ? "gitDirty" : "gitClean";

    // Build content - color branch separately from indicators
    let content = "";
    if (showBranch && branch) {
      // Color just the branch name (icon + branch text)
      content = color(ctx, branchColor, withIcon(icons.branch, branch));
    }

    // Add status indicators (each with their own color, not wrapped)
    if (gitStatus) {
      const indicators: string[] = [];
      if (opts.showUnstaged !== false && gitStatus.unstaged > 0) {
        indicators.push(applyColor(ctx.theme, "warning", `*${gitStatus.unstaged}`));
      }
      if (opts.showStaged !== false && gitStatus.staged > 0) {
        indicators.push(applyColor(ctx.theme, "success", `+${gitStatus.staged}`));
      }
      if (opts.showUntracked !== false && gitStatus.untracked > 0) {
        indicators.push(applyColor(ctx.theme, "muted", `?${gitStatus.untracked}`));
      }
      if (indicators.length > 0) {
        const indicatorText = indicators.join(" ");
        if (!content && showBranch === false) {
          // No branch shown, color the git icon with branch color
          content = color(ctx, branchColor, icons.git ? `${icons.git} ` : "") + indicatorText;
        } else {
          content += content ? ` ${indicatorText}` : indicatorText;
        }
      }
    }

    if (!content) return { content: "", visible: false };

    return { content, visible: true };
  },
};

const thinkingSegment: StatusLineSegment = {
  id: "thinking",
  render(ctx) {
    const level = ctx.thinkingLevel || "off";
    if (level === "off") return { content: "", visible: false };

    // 셰브론 스타일 라벨 (metaphor-directive-refinement / unified-agent-ext 일관)
    const CHEVRON_LABELS: Record<string, string> = {
      minimal: "›  Minimal",
      low: "›  Low",
      medium: "»  Medium",
      high: "⋙  High",
      xhigh: "⋙  xHigh",
    };

    // 레벨별 색상 (success → warning → error 단계)
    const CHEVRON_COLORS: Record<string, ColorValue> = {
      minimal: "success",
      low: "success",
      medium: "warning",
      high: "error",
      xhigh: "error",
    };

    const label = CHEVRON_LABELS[level] ?? level;
    const colorKey = CHEVRON_COLORS[level] ?? "dim";

    // xhigh: 무지개 그라데이션 (문자별 ANSI 색상 순환)
    if (level === "xhigh") {
      return { content: rainbow(label), visible: true };
    }

    return {
      content: applyColor(ctx.theme, colorKey, label),
      visible: true,
    };
  },
};

const tokenInSegment: StatusLineSegment = {
  id: "token_in",
  render(ctx) {
    const icons = getIcons();
    const { input } = ctx.usageStats;
    if (!input) return { content: "", visible: false };

    const content = withIcon(icons.input, formatTokens(input));
    return { content: color(ctx, "tokens", content), visible: true };
  },
};

const tokenOutSegment: StatusLineSegment = {
  id: "token_out",
  render(ctx) {
    const icons = getIcons();
    const { output } = ctx.usageStats;
    if (!output) return { content: "", visible: false };

    const content = withIcon(icons.output, formatTokens(output));
    return { content: color(ctx, "tokens", content), visible: true };
  },
};

const tokenTotalSegment: StatusLineSegment = {
  id: "token_total",
  render(ctx) {
    const icons = getIcons();
    const { input, output } = ctx.usageStats;
    const total = input + output;
    if (!total) return { content: "", visible: false };

    const content = withIcon(icons.tokens, formatTokens(total));
    return { content: color(ctx, "tokens", content), visible: true };
  },
};

const costSegment: StatusLineSegment = {
  id: "cost",
  render(ctx) {
    const { cost } = ctx.usageStats;
    const usingSubscription = ctx.usingSubscription;

    if (!cost && !usingSubscription) {
      return { content: "", visible: false };
    }

    // 구독 중이면 (sub) 표시, 아니면 geek 단위 시스템으로 포맷
    const costDisplay = usingSubscription ? "(sub)" : formatCostGeek(cost);
    if (!costDisplay) return { content: "", visible: false };

    return { content: color(ctx, "cost", costDisplay), visible: true };
  },
};

const timeSpentSegment: StatusLineSegment = {
  id: "time_spent",
  render(ctx) {
    const icons = getIcons();
    const elapsed = Date.now() - ctx.sessionStartTime;
    if (elapsed < 1000) return { content: "", visible: false };

    // No explicit color
    return { content: withIcon(icons.time, formatDuration(elapsed)), visible: true };
  },
};

const timeSegment: StatusLineSegment = {
  id: "time",
  render(ctx) {
    const icons = getIcons();
    const opts = ctx.options.time ?? {};
    const now = new Date();

    let hours = now.getHours();
    let suffix = "";
    if (opts.format === "12h") {
      suffix = hours >= 12 ? "pm" : "am";
      hours = hours % 12 || 12;
    }

    const mins = now.getMinutes().toString().padStart(2, "0");
    let timeStr = `${hours}:${mins}`;
    if (opts.showSeconds) {
      timeStr += `:${now.getSeconds().toString().padStart(2, "0")}`;
    }
    timeStr += suffix;

    // No explicit color
    return { content: withIcon(icons.time, timeStr), visible: true };
  },
};

const sessionSegment: StatusLineSegment = {
  id: "session",
  render(ctx) {
    const icons = getIcons();
    const sessionId = ctx.sessionId;
    const display = sessionId?.slice(0, 8) || "new";

    // No explicit color
    return { content: withIcon(icons.session, display), visible: true };
  },
};

const hostnameSegment: StatusLineSegment = {
  id: "hostname",
  render() {
    const icons = getIcons();
    const name = osHostname().split(".")[0];
    // No explicit color
    return { content: withIcon(icons.host, name), visible: true };
  },
};

const extensionStatusesSegment: StatusLineSegment = {
  id: "extension_statuses",
  render(ctx) {
    const statuses = ctx.extensionStatuses;
    if (!statuses || statuses.size === 0) return { content: "", visible: false };

    // Map 전체를 순회하여 [ 로 시작하지 않는 항목을 표시
    const parts: string[] = [];
    for (const value of statuses.values()) {
      if (value && !value.trimStart().startsWith('[')) {
        parts.push(value);
      }
    }

    if (parts.length === 0) return { content: "", visible: false };

    // Statuses already have their own styling applied by the extensions
    const content = parts.join(` ${SEP_DOT} `);
    return { content, visible: true };
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Segment Registry
// ═══════════════════════════════════════════════════════════════════════════

export const SEGMENTS: Record<StatusLineSegmentId, StatusLineSegment> = {
  pi: piSegment,
  model: modelSegment,
  path: pathSegment,
  git: gitSegment,
  thinking: thinkingSegment,
  token_in: tokenInSegment,
  token_out: tokenOutSegment,
  token_total: tokenTotalSegment,
  cost: costSegment,
  time_spent: timeSpentSegment,
  time: timeSegment,
  session: sessionSegment,
  hostname: hostnameSegment,
  extension_statuses: extensionStatusesSegment,
};

export function renderSegment(id: StatusLineSegmentId, ctx: SegmentContext): RenderedSegment {
  const segment = SEGMENTS[id];
  if (!segment) {
    return { content: "", visible: false };
  }
  return segment.render(ctx);
}

// Helper to apply semantic color from context
function color(ctx: SegmentContext, semantic: SemanticColor, text: string): string {
  return fg(ctx.theme, semantic, text, ctx.colors);
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function withIcon(icon: string, text: string): string {
  return icon ? `${icon} ${text}` : text;
}

function sanitizePlainDisplay(value: string): string {
  let output = value;
  if (output.includes("\u001b")) {
    output = output.replace(OSC_REGEX, "");
    output = output.replace(APC_REGEX, "");
    output = output.replace(DCS_REGEX, "");
    output = output.replace(CSI_REGEX, "");
    output = output.replace(ESC_SINGLE_REGEX, "");
  }
  return output
    .replace(BIDI_CONTROL_REGEX, "")
    .replace(CONTROL_REGEX, "");
}

function formatTokens(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
  return `${Math.round(n / 1000000)}M`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Geek 스타일 비용 포맷 — 과학적 단위 시스템
 * μ$ (마이크로달러) / m$ (밀리달러) / $ 로 계층화
 */
function formatCostGeek(cost: number): string {
  if (cost <= 0) return "";
  if (cost < 0.001) return `${(cost * 1_000_000).toFixed(0)}μ$`;
  if (cost < 0.1)   return `${(cost * 1_000).toFixed(1)}m$`;
  return `$${cost.toFixed(2)}`;
}
