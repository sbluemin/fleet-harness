import type { ReactElement } from "react";

export type WorldIconName =
  | "sun"
  | "sunset"
  | "moon"
  | "cycle"
  | "clock"
  | "cameraFollow"
  | "cameraOrbit"
  | "recruit"
  | "portalExit"
  | "compass"
  | "stage"
  | "bell"
  | "scroll"
  | "crate"
  | "baton"
  | "confetti"
  | "chat"
  | "questMap"
  | "inspect"
  | "settings"
  | "crew"
  | "rally"
  | "approach"
  | "greet"
  | "cheer"
  | "highfive"
  | "wheelBack"
  | "close"
  | "crown"
  | "commodore"
  | "commander"
  | "member"
  | "quaker"
  | "systemWake"
  | "systemInfo"
  | "warning"
  | "tool"
  | "mail"
  | "question"
  | "memory"
  | "routine"
  | "stop"
  | "retry"
  | "leaf"
  | "soundOn"
  | "soundOff"
  | "mapOverview"
  | "windmill"
  | "trophy"
  | "questBoard"
  | "camera"
  | "flag"
  | "sparkle"
  | "warRoom"
  | "weather"
  | "rain"
  | "snow"
  | "sakura"
  | "note"
  | "fire"
  | "rainbow"
  | "hat"
  | "spin";

export type WorldIconTone =
  | "inherit"
  | "brass"
  | "amber"
  | "teal"
  | "cerulean"
  | "moss"
  | "rose"
  | "indigo"
  | "plum"
  | "warn";

const ICON_PATHS: Record<WorldIconName, () => ReactElement> = {
  sun: () => (
    <>
      <circle cx="12" cy="12" r="4.2" fill="currentColor" fillOpacity="0.24" />
      <path d="M12 2.8v2.2M12 19v2.2M2.8 12H5M19 12h2.2M5.5 5.5l1.6 1.6M16.9 16.9l1.6 1.6M18.5 5.5l-1.6 1.6M7.1 16.9l-1.6 1.6" />
    </>
  ),
  sunset: () => (
    <>
      <path d="M3 17.5h18" />
      <path d="M6.5 17.5a5.5 5.5 0 0 1 11 0" fill="currentColor" fillOpacity="0.25" />
      <path d="M12 5.2v2.4M6.2 8.2l1.6 1.6M17.8 8.2l-1.6 1.6M5.5 20.5h13" />
    </>
  ),
  moon: () => (
    <>
      <path d="M18.4 14.8A7.2 7.2 0 0 1 9.2 5.6a7.4 7.4 0 1 0 9.2 9.2Z" fill="currentColor" fillOpacity="0.24" />
      <path d="M16.5 4.8v2.4M15.3 6h2.4" />
    </>
  ),
  cycle: () => (
    <>
      <path d="M4.5 11.5A7.5 7.5 0 0 1 17.6 6.8" />
      <path d="M15.2 4.6l2.8 2.2-2.7 1.8" />
      <path d="M19.5 12.5A7.5 7.5 0 0 1 6.4 17.2" />
      <path d="M8.8 19.4L6 17.2l2.7-1.8" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" fillOpacity="0.35" />
    </>
  ),
  clock: () => (
    <>
      <circle cx="12" cy="12.5" r="7.5" fill="currentColor" fillOpacity="0.18" />
      <path d="M12 8.2v4.3l3 1.8M9.5 3h5" />
    </>
  ),
  cameraFollow: () => (
    <>
      <circle cx="12" cy="12" r="7.5" fill="currentColor" fillOpacity="0.14" />
      <circle cx="12" cy="12" r="2.6" fill="currentColor" fillOpacity="0.45" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />
    </>
  ),
  cameraOrbit: () => (
    <>
      <rect x="3.2" y="5" width="17.6" height="14" rx="2.6" fill="currentColor" fillOpacity="0.15" />
      <path d="M3.8 16l4.8-4.5 3.4 3 3.2-2.6 5 4.1" />
      <circle cx="9" cy="9.2" r="1.3" fill="currentColor" />
    </>
  ),
  recruit: () => (
    <>
      <path d="M11 4l2.1 4.2 4.6.7-3.3 3.2.8 4.6L11 14.5l-4.2 2.2.8-4.6L4.3 8.9l4.6-.7L11 4Z" fill="currentColor" fillOpacity="0.24" />
      <path d="M18.5 15v5M16 17.5h5" />
    </>
  ),
  portalExit: () => (
    <>
      <path d="M12 3.5a8.5 8.5 0 1 0 7.6 12.2" />
      <path d="M12 7a5 5 0 1 0 4.6 7" fill="currentColor" fillOpacity="0.18" />
      <path d="M15.5 6.5h4.2v4.2M13.5 12.5l6-6" />
    </>
  ),
  compass: () => (
    <>
      <circle cx="12" cy="12" r="8.2" fill="currentColor" fillOpacity="0.16" />
      <path d="M15.6 8.4l-2.1 5.1-5.1 2.1 2.1-5.1 5.1-2.1Z" fill="currentColor" fillOpacity="0.38" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
    </>
  ),
  stage: () => (
    <>
      <path d="M4 9.5h16v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9Z" fill="currentColor" fillOpacity="0.18" />
      <path d="M4 9.5L19.2 5.2l1 3.6L5 13.1zM8.5 8.2l1.8 2.4M13.8 6.7l1.8 2.4" />
    </>
  ),
  bell: () => (
    <>
      <path d="M6.5 15.5V11a5.5 5.5 0 0 1 11 0v4.5l1.7 2H4.8l1.7-2Z" fill="currentColor" fillOpacity="0.24" />
      <path d="M10 19.5a2.2 2.2 0 0 0 4 0M12 3.5v1.8" />
    </>
  ),
  scroll: () => (
    <>
      <path d="M7.5 4.5h10a2.5 2.5 0 0 1 0 5h-1v8.5a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V7a2.5 2.5 0 0 1 3-2.5Z" fill="currentColor" fillOpacity="0.2" />
      <path d="M9.5 10.5h4.5M9.5 14h4.5" />
    </>
  ),
  crate: () => (
    <>
      <path d="M12 3.2L20 7.6v8.8L12 20.8 4 16.4V7.6L12 3.2Z" fill="currentColor" fillOpacity="0.2" />
      <path d="M4 7.6L12 12l8-4.4M12 12v8.8M8 5.4l8 4.4" />
    </>
  ),
  baton: () => (
    <>
      <circle cx="8.5" cy="15.5" r="3.6" fill="currentColor" fillOpacity="0.24" />
      <path d="M11.2 12.8L19.5 4.5M16.2 7.8l2.2 2.2M18.3 5.7l1.8 1.8" />
    </>
  ),
  confetti: () => (
    <>
      <path d="M4.5 19.5l3.6-10.2 6.6 6.6-10.2 3.6Z" fill="currentColor" fillOpacity="0.26" />
      <path d="M14.5 5.2l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" fill="currentColor" />
      <path d="M18.8 13.2l1.6-1.2M12.2 3.8l-1-1.4" />
    </>
  ),
  chat: () => (
    <>
      <path d="M4.5 6.8A2.8 2.8 0 0 1 7.3 4h9.4a2.8 2.8 0 0 1 2.8 2.8v6.9a2.8 2.8 0 0 1-2.8 2.8H11l-4.2 3.2v-3.2H7.3a2.8 2.8 0 0 1-2.8-2.8V6.8Z" fill="currentColor" fillOpacity="0.22" />
      <circle cx="9.2" cy="10.2" r="0.9" fill="currentColor" />
      <circle cx="12" cy="10.2" r="0.9" fill="currentColor" />
      <circle cx="14.8" cy="10.2" r="0.9" fill="currentColor" />
    </>
  ),
  questMap: () => (
    <>
      <path d="M3.8 6.2L9 4.2l6 2 5.2-2v13.6L15 19.8l-6-2-5.2 2V6.2Z" fill="currentColor" fillOpacity="0.18" />
      <path d="M9 4.2v13.6M15 6.2v13.6" />
      <circle cx="12" cy="11.2" r="1.4" fill="currentColor" />
    </>
  ),
  inspect: () => (
    <>
      <circle cx="10.6" cy="10.6" r="6" fill="currentColor" fillOpacity="0.2" />
      <path d="M15.1 15.1l4.9 4.9M8.8 8.8a2.5 2.5 0 0 1 3.4-.2" />
    </>
  ),
  settings: () => (
    <>
      <circle cx="12" cy="12" r="3" fill="currentColor" fillOpacity="0.28" />
      <path d="M12 3.5l1.3 2.1 2.4-.5.6 2.4 2.4.7-.5 2.4 2 1.4-2 1.4.5 2.4-2.4.7-.6 2.4-2.4-.5L12 20.5l-1.3-2.1-2.4.5-.6-2.4-2.4-.7.5-2.4-2-1.4 2-1.4-.5-2.4 2.4-.7.6-2.4 2.4.5L12 3.5Z" fill="currentColor" fillOpacity="0.14" />
    </>
  ),
  crew: () => (
    <>
      <circle cx="9.2" cy="8.5" r="2.8" fill="currentColor" fillOpacity="0.25" />
      <path d="M4.2 18.5a5 5 0 0 1 10 0" fill="currentColor" fillOpacity="0.16" />
      <circle cx="16.2" cy="9.6" r="2.2" fill="currentColor" fillOpacity="0.2" />
      <path d="M14.8 18.5a4.2 4.2 0 0 1 5.4-3.8" />
    </>
  ),
  rally: () => (
    <>
      <path d="M4.5 13.5v-3l11.5-4.5v12L4.5 13.5Z" fill="currentColor" fillOpacity="0.22" />
      <path d="M7.5 14.5l1.4 4.2M18.5 9.2a3.6 3.6 0 0 1 0 5.6" />
    </>
  ),
  approach: () => (
    <>
      <path d="M5.5 17.5h13l-1.8-4.2-4.2-1.3-1-5.5H7.2l-1.7 11Z" fill="currentColor" fillOpacity="0.24" />
      <path d="M4 11.5h3M3.5 8.2h2.8" />
    </>
  ),
  greet: () => (
    <>
      <path d="M12 20.2c-4.4-2.8-7.2-5.6-7.2-9A4.2 4.2 0 0 1 12 8.1a4.2 4.2 0 0 1 7.2 3.1c0 3.4-2.8 6.2-7.2 9Z" fill="currentColor" fillOpacity="0.25" />
      <path d="M12 4.2V2.6M17.5 5.4l1.1-1.1M6.5 5.4L5.4 4.3" />
    </>
  ),
  cheer: () => (
    <>
      <path d="M6.5 19.5V5.2l11.5 3.6-11.5 4.2" fill="currentColor" fillOpacity="0.24" />
      <path d="M16.2 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2Z" fill="currentColor" />
    </>
  ),
  highfive: () => (
    <>
      <path d="M12 3.5l2 5.4 5.5 2-5.5 2-2 5.6-2-5.6-5.5-2 5.5-2 2-5.4Z" fill="currentColor" fillOpacity="0.28" />
      <path d="M6 5.5l1.4 1.4M18 5.5l-1.4 1.4M6 17.5l1.4-1.4M18 17.5l-1.4-1.4" />
    </>
  ),
  wheelBack: () => (
    <>
      <path d="M9 7.5H5.2v3.8" />
      <path d="M5.5 11.2A7 7 0 1 1 8.4 17.6" />
    </>
  ),
  close: () => (
    <>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </>
  ),
  crown: () => (
    <>
      <path d="M4 17.5L5.5 8l4.5 4 2-5.5 2 5.5 4.5-4 1.5 9.5H4Z" fill="currentColor" fillOpacity="0.28" />
      <path d="M5 19.8h14" />
    </>
  ),
  commodore: () => (
    <>
      <path d="M12 3.5l2.6 5.2 5.7.8-4.1 4 1 5.7L12 16.5l-5.2 2.7 1-5.7-4.1-4 5.7-.8L12 3.5Z" fill="currentColor" fillOpacity="0.32" />
    </>
  ),
  commander: () => (
    <>
      <path d="M12 4.5l7.5 5.2-2.2 2.4L12 8.4l-5.3 3.7-2.2-2.4L12 4.5Z" fill="currentColor" fillOpacity="0.3" />
      <path d="M12 11.5l7.5 5.2-2.2 2.4L12 15.4l-5.3 3.7-2.2-2.4L12 11.5Z" fill="currentColor" fillOpacity="0.2" />
    </>
  ),
  member: () => (
    <>
      <path d="M12 4.2l7.2 7.8-7.2 7.8L4.8 12 12 4.2Z" fill="currentColor" fillOpacity="0.26" />
      <circle cx="12" cy="12" r="2.1" fill="currentColor" />
    </>
  ),
  quaker: () => (
    <>
      <path d="M5 15.5c2.2-6.2 7.8-9.5 14-9.5-1.4 5.2-4.8 9.2-10.2 10.6L5 18.2v-2.7Z" fill="currentColor" fillOpacity="0.26" />
      <path d="M9.5 13.5l4.2-3.5" />
    </>
  ),
  systemWake: () => (
    <>
      <path d="M6.5 15.5V11a5.5 5.5 0 0 1 11 0v4.5l1.7 2H4.8l1.7-2Z" fill="currentColor" fillOpacity="0.28" />
      <path d="M10 19.5a2.2 2.2 0 0 0 4 0M3.8 7.5a9.2 9.2 0 0 1 2.2-2.8M20.2 7.5A9.2 9.2 0 0 0 18 4.7" />
    </>
  ),
  systemInfo: () => (
    <>
      <path d="M12 3.5l2.2 6.3 6.3 2.2-6.3 2.2L12 20.5l-2.2-6.3L3.5 12l6.3-2.2L12 3.5Z" fill="currentColor" fillOpacity="0.3" />
    </>
  ),
  warning: () => (
    <>
      <path d="M12 4L20.5 19H3.5L12 4Z" fill="currentColor" fillOpacity="0.24" />
      <path d="M12 9.5v4.5" />
      <circle cx="12" cy="16.4" r="0.9" fill="currentColor" />
    </>
  ),
  tool: () => (
    <>
      <path d="M14.5 6.2a4 4 0 0 0 4.5 5.2l-8.5 8.5a2 2 0 1 1-2.8-2.8l8.5-8.5a4 4 0 0 0-1.7-2.4Z" fill="currentColor" fillOpacity="0.24" />
    </>
  ),
  mail: () => (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2.2" fill="currentColor" fillOpacity="0.2" />
      <path d="M4.2 7l7.8 5.8L19.8 7" />
    </>
  ),
  question: () => (
    <>
      <circle cx="12" cy="12" r="8.4" fill="currentColor" fillOpacity="0.24" />
      <path d="M9.6 9.5a2.5 2.5 0 0 1 4.8.8c0 1.6-2.4 1.9-2.4 3.4" />
      <circle cx="12" cy="16.7" r="0.95" fill="currentColor" />
    </>
  ),
  memory: () => (
    <>
      <path d="M12 3.2L19 8.5l-2.6 11.3H7.6L5 8.5 12 3.2Z" fill="currentColor" fillOpacity="0.22" />
      <path d="M12 3.2v16.6M5 8.5h14" />
    </>
  ),
  routine: () => (
    <>
      <path d="M7 4.2h10M7 19.8h10M8.2 4.2c0 4 3.8 5.2 3.8 7.8s-3.8 3.8-3.8 7.8M15.8 4.2c0 4-3.8 5.2-3.8 7.8s3.8 3.8 3.8 7.8" fill="currentColor" fillOpacity="0.16" />
    </>
  ),
  stop: () => (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2.2" fill="currentColor" fillOpacity="0.32" />
    </>
  ),
  retry: () => (
    <>
      <path d="M18.8 9.2A7 7 0 1 0 19 14.5" />
      <path d="M18.8 4.8v4.5h-4.5" />
    </>
  ),
  leaf: () => (
    <>
      <path d="M5.5 18.5C5.5 10.5 11 5 19.2 4.8c-.2 8.2-5.7 13.7-13.7 13.7Z" fill="currentColor" fillOpacity="0.24" />
      <path d="M5.5 18.5L14 10" />
    </>
  ),
  soundOn: () => (
    <>
      <path d="M4.5 9.6h3.4l4.6-3.8v12.4l-4.6-3.8H4.5a1 1 0 0 1-1-1v-2.8a1 1 0 0 1 1-1Z" fill="currentColor" fillOpacity="0.26" />
      <path d="M16 9.2a4.2 4.2 0 0 1 0 5.6M18.6 6.8a7.4 7.4 0 0 1 0 10.4" />
    </>
  ),
  soundOff: () => (
    <>
      <path d="M4.5 9.6h3.4l4.6-3.8v12.4l-4.6-3.8H4.5a1 1 0 0 1-1-1v-2.8a1 1 0 0 1 1-1Z" fill="currentColor" fillOpacity="0.2" />
      <path d="M16.2 9.4l4.4 5.2M20.6 9.4l-4.4 5.2" />
    </>
  ),
  mapOverview: () => (
    <>
      <circle cx="12" cy="12" r="8.2" fill="currentColor" fillOpacity="0.16" />
      <ellipse cx="12" cy="12" rx="4" ry="8.2" />
      <path d="M4.2 12h15.6M5.8 7.8h12.4M5.8 16.2h12.4" />
    </>
  ),
  windmill: () => (
    <>
      <path d="M9.4 20.2h5.2l-1-8.4h-3.2l-1 8.4Z" fill="currentColor" fillOpacity="0.24" />
      <path d="M12 10.6L5.5 5.4M12 10.6l6.5-5.2M12 10.6l-6.5 5.2M12 10.6l6.5 5.2" />
      <circle cx="12" cy="10.6" r="1.4" fill="currentColor" />
    </>
  ),
  trophy: () => (
    <>
      <path d="M7.5 4.5h9v5.2a4.5 4.5 0 0 1-9 0V4.5Z" fill="currentColor" fillOpacity="0.28" />
      <path d="M7.5 6.4H4.6a2.3 2.3 0 0 0 2.3 3.4h.7M16.5 6.4h2.9a2.3 2.3 0 0 1-2.3 3.4h-.7" />
      <path d="M12 14.2v3.6M8.5 19.8h7" />
    </>
  ),
  questBoard: () => (
    <>
      <path d="M3.5 7.5L12 3.5l8.5 4" />
      <rect x="4.8" y="7.5" width="14.4" height="10.2" rx="1.4" fill="currentColor" fillOpacity="0.22" />
      <path d="M7.5 17.7v3.1M16.5 17.7v3.1" />
      <rect x="7.4" y="9.8" width="3.6" height="4.4" rx="0.5" fill="currentColor" fillOpacity="0.34" />
      <rect x="13" y="10.4" width="3.6" height="3.8" rx="0.5" fill="currentColor" fillOpacity="0.34" />
    </>
  ),
  camera: () => (
    <>
      <path d="M4.2 8.2a2.2 2.2 0 0 1 2.2-2.2h1.9l1.3-1.8h4.8l1.3 1.8h1.9a2.2 2.2 0 0 1 2.2 2.2v8.8a2.2 2.2 0 0 1-2.2 2.2H6.4a2.2 2.2 0 0 1-2.2-2.2V8.2Z" fill="currentColor" fillOpacity="0.2" />
      <circle cx="12" cy="12.6" r="3.4" fill="currentColor" fillOpacity="0.28" />
      <circle cx="17.2" cy="9.2" r="0.8" fill="currentColor" />
    </>
  ),
  flag: () => (
    <>
      <path d="M6.2 20.4V4.4" />
      <path d="M6.2 5.2c3.2-1.2 5.4 1.2 8.8 0 1.2-.4 2.2-.2 3 .2v7.6c-1-.5-2-.6-3.2-.2-3.2 1.1-5.4-1.2-8.6 0V5.2Z" fill="currentColor" fillOpacity="0.28" />
      <circle cx="6.2" cy="3.8" r="0.9" fill="currentColor" />
    </>
  ),
  sparkle: () => (
    <>
      <path d="M12 3.2l2.1 5.9 5.9 2.1-5.9 2.1L12 19.2l-2.1-5.9L4 11.2l5.9-2.1L12 3.2Z" fill="currentColor" fillOpacity="0.28" />
      <path d="M18.6 4.4v2.6M17.3 5.7h2.6M5.4 16.8v2.2M4.3 17.9h2.2" />
    </>
  ),
  warRoom: () => (
    <>
      <path d="M3.8 19.5h16.4M5.4 19.5V10.5L12 4.8l6.6 5.7v9H5.4Z" fill="currentColor" fillOpacity="0.22" />
      <path d="M9.6 19.5v-4.8a2.4 2.4 0 0 1 4.8 0v4.8M12 8.2v2.4M10.8 9.4h2.4" />
    </>
  ),
  weather: () => (
    <>
      <circle cx="9" cy="8.5" r="3" fill="currentColor" fillOpacity="0.26" />
      <path d="M9 3.6v1.2M4.4 8.5H3.2M5.7 5.2l.9.9M12.3 5.2l-.9.9" />
      <path d="M8.5 18.2h9.2a3.3 3.3 0 0 0 .4-6.6 4.6 4.6 0 0 0-8.9-1.2 3.2 3.2 0 0 0-.7 6.3Z" fill="currentColor" fillOpacity="0.22" />
    </>
  ),
  rain: () => (
    <>
      <path d="M6.8 14.2h10.8a3.2 3.2 0 0 0 .3-6.4 4.8 4.8 0 0 0-9.3-1.1 3.4 3.4 0 0 0-1.8 6.5Z" fill="currentColor" fillOpacity="0.22" />
      <path d="M8.6 17.2l-1 2.4M12.6 17.2l-1 2.4M16.6 17.2l-1 2.4" />
    </>
  ),
  snow: () => (
    <>
      <path d="M12 3.6v16.8M4.7 7.8l14.6 8.4M19.3 7.8L4.7 16.2" />
      <circle cx="12" cy="12" r="2.2" fill="currentColor" fillOpacity="0.28" />
    </>
  ),
  sakura: () => (
    <>
      <path d="M12 4.2c1.8 1.5 2.4 3.7 1.2 5.4 2-.6 4.2.1 5.2 2-1.8 1.4-4 1.6-5.5.2.9 1.9.4 4.1-1.3 5.4-1.7-1.3-2.2-3.5-1.3-5.4-1.5 1.4-3.7 1.2-5.5-.2 1-1.9 3.2-2.6 5.2-2-1.2-1.7-.6-3.9 1.2-5.4Z" fill="currentColor" fillOpacity="0.26" />
      <circle cx="12" cy="11.6" r="1.4" fill="currentColor" />
    </>
  ),
  note: () => (
    <>
      <path d="M5.5 4.5h13v10.5l-4.5 4.5h-8.5V4.5Z" fill="currentColor" fillOpacity="0.2" />
      <path d="M14 19.5V15h4.5M8.5 9h7M8.5 12.5h4.5" />
    </>
  ),
  fire: () => (
    <>
      <path d="M12 3.8c2.4 2.8 5.2 5.6 5.2 9.2a5.2 5.2 0 0 1-10.4 0c0-2.1 1-3.8 2.2-5.3.2 1.4 1.1 2.2 2 2.4-.5-2.1 0-4.4 1-6.3Z" fill="currentColor" fillOpacity="0.28" />
      <path d="M6.2 19.8l11.6-2.4M17.8 19.8L6.2 17.4" />
    </>
  ),
  rainbow: () => (
    <>
      <path d="M3.5 17.5a8.5 8.5 0 0 1 17 0" />
      <path d="M6.5 17.5a5.5 5.5 0 0 1 11 0" fill="currentColor" fillOpacity="0.2" />
      <path d="M9.5 17.5a2.5 2.5 0 0 1 5 0" />
    </>
  ),
  hat: () => (
    <>
      <path d="M5.5 14.5c1.5-5.2 3.4-7.5 6.5-7.5s5 2.3 6.5 7.5H5.5Z" fill="currentColor" fillOpacity="0.24" />
      <path d="M3.2 14.8c2.8 1.5 14.8 1.5 17.6 0M12 10.2v2.2M10.9 11.3h2.2" />
    </>
  ),
  spin: () => (
    <>
      <path d="M19.5 10.5A7.5 7.5 0 1 0 18.2 16.5" />
      <path d="M19.8 6.4v4.2h-4.2" />
      <path d="M12 8.8l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9.9-2.3Z" fill="currentColor" fillOpacity="0.34" />
    </>
  ),
};

/**
 * 「더 월드」 전용 커스텀 게임 UI 벡터 아이콘.
 *
 * OS 기본 유니코드 이모지 대신 통일된 판타지/코지 RPG 듀오톤 SVG 글리프를 제공하며,
 * `tone`으로 `theme.css` 시맨틱 컬러 토큰을 일관되게 입힌다.
 */
export function WorldIcon({
  name,
  size = 15,
  tone = "inherit",
  className,
}: {
  readonly name: WorldIconName;
  readonly size?: number;
  readonly tone?: WorldIconTone;
  readonly className?: string;
}) {
  return (
    <svg
      className={`the-world-icon${tone !== "inherit" ? ` is-tone-${tone}` : ""}${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.85}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name]()}
    </svg>
  );
}
