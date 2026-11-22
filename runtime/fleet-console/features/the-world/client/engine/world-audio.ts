import type { WorldWeatherMode } from "../../shared/world-types.js";

/**
 * 「더 월드 (The World)」 프로시저럴 Web Audio API 게임 사운드스케이프 (SFX + 힐링 BGM).
 *
 * 외부 오디오 파일·네트워크 요청 없이 순수 신시사이저 노드로 경쾌한 UI·월드 효과음과
 * 시간·날씨 반응형 힐링 배경음(기본 OFF)을 합성한다.
 * - 첫 사용자 제스처 시 안전하게 AudioContext를 초기화/재개하며, headless/SSR/차단 환경에서는 무에러 폴백한다.
 * - 마스터 볼륨을 은은하게(0.16) 유지하고, 호버/종소리에는 쿨다운을 두어 연속 입력 시 귀 피로를 방지한다.
 */

let audioCtx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let muted = false;

let lastHoverAt = 0;
let lastChimeAt = 0;
let lastChirpAt = 0;
let lastFootstepAt = 0;
let lastBoostAt = 0;
let cachedNoiseCtx: AudioContext | null = null;
let cachedNoiseBuf: AudioBuffer | null = null;
let cachedRainCtx: AudioContext | null = null;
let cachedRainBuf: AudioBuffer | null = null;

let rainDesired = false;
let rainSource: AudioBufferSourceNode | null = null;
let rainFilter: BiquadFilterNode | null = null;
let rainGain: GainNode | null = null;

let bgmDesired = false;
let bgmNightFactor = 0;
let bgmWeather: WorldWeatherMode = "clear";
let bgmIntervalId: number | null = null;
let bgmStep = 0;
let bgmGain: GainNode | null = null;
let bgmGainCtx: AudioContext | null = null;
let bgmRainSource: AudioBufferSourceNode | null = null;
let bgmRainFilter: BiquadFilterNode | null = null;
let bgmRainGain: GainNode | null = null;
let audioVisBound = false;

const MASTER_VOLUME = 0.16;
const HOVER_COOLDOWN_MS = 90;
const CHIME_COOLDOWN_MS = 380;
const CHIRP_COOLDOWN_MS = 140;
const FOOTSTEP_COOLDOWN_MS = 280;
const BOOST_COOLDOWN_MS = 380;

function getAudioEngine(): { readonly ctx: AudioContext; readonly out: GainNode } | null {
  if (muted) return null;
  if (typeof window === "undefined") return null;

  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;

  try {
    if (!audioCtx) {
      audioCtx = new Ctx();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = MASTER_VOLUME;
      masterGain.connect(audioCtx.destination);
    }
    if (audioCtx.state === "suspended") {
      void audioCtx.resume().catch(() => {
        // 사용자 제스처 이전 자동 재생 차단은 조용히 무시한다.
      });
    }
    if (audioCtx.state === "closed" || !masterGain) return null;
    return { ctx: audioCtx, out: masterGain };
  } catch {
    return null;
  }
}

function scheduleTone(
  ctx: AudioContext,
  out: GainNode,
  opts: {
    readonly type: OscillatorType;
    readonly freqStart: number;
    readonly freqEnd?: number | undefined;
    readonly delay?: number | undefined;
    readonly duration: number;
    readonly peakGain: number;
    readonly attack?: number | undefined;
  },
): void {
  const t0 = ctx.currentTime + (opts.delay ?? 0);
  const attack = Math.min(opts.attack ?? 0.012, opts.duration * 0.45);
  const tEnd = t0 + opts.duration;

  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = opts.type;
  osc.frequency.setValueAtTime(Math.max(40, opts.freqStart), t0);
  if (opts.freqEnd !== undefined && opts.freqEnd !== opts.freqStart) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, opts.freqEnd), tEnd);
  }

  env.gain.setValueAtTime(0.0001, t0);
  env.gain.linearRampToValueAtTime(opts.peakGain, t0 + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, tEnd);

  osc.connect(env);
  env.connect(out);
  osc.onended = () => {
    osc.disconnect();
    env.disconnect();
  };
  osc.start(t0);
  osc.stop(tEnd + 0.01);
}

export function setWorldAudioMuted(nextMuted: boolean): void {
  muted = nextMuted;
  if (masterGain && audioCtx && audioCtx.state !== "closed") {
    try {
      masterGain.gain.setTargetAtTime(muted ? 0.0001 : MASTER_VOLUME, audioCtx.currentTime, 0.02);
    } catch {
      masterGain.gain.value = muted ? 0 : MASTER_VOLUME;
    }
  }
  if (muted) {
    stopRainAmbienceInternal();
    stopBgmInternal();
    stopSpatialAmbienceInternal();
  } else {
    if (rainDesired) {
      startRainAmbienceInternal();
    }
    if (bgmDesired) {
      startBgmInternal();
    }
  }
}

export function isWorldAudioMuted(): boolean {
  return muted;
}

/** 구역 호버 시 가볍고 맑은 나무/크리스탈 틱음 (90ms 쿨다운). */
export function playDistrictHover(): void {
  const now = performance.now();
  if (now - lastHoverAt < HOVER_COOLDOWN_MS) return;
  const eng = getAudioEngine();
  if (!eng) return;
  lastHoverAt = now;

  scheduleTone(eng.ctx, eng.out, {
    type: "triangle",
    freqStart: 660,
    freqEnd: 780,
    duration: 0.055,
    peakGain: 0.28,
    attack: 0.006,
  });
}

/** 심시티 Theater 구역 선택 시 경쾌한 2음 마림바·크리스탈 화음. */
export function playDistrictSelect(): void {
  const eng = getAudioEngine();
  if (!eng) return;

  scheduleTone(eng.ctx, eng.out, {
    type: "triangle",
    freqStart: 523.25, // C5
    freqEnd: 528,
    duration: 0.14,
    peakGain: 0.45,
    attack: 0.008,
  });
  scheduleTone(eng.ctx, eng.out, {
    type: "sine",
    freqStart: 783.99, // G5
    freqEnd: 790,
    delay: 0.055,
    duration: 0.22,
    peakGain: 0.38,
    attack: 0.01,
  });
}

/** `M` 하늘 조망 모드 진입/복귀 시 상승·하강 에테르 스윕. */
export function playOverviewToggle(entering: boolean): void {
  const eng = getAudioEngine();
  if (!eng) return;

  if (entering) {
    scheduleTone(eng.ctx, eng.out, {
      type: "sine",
      freqStart: 329.63, // E4
      freqEnd: 659.25, // E5
      duration: 0.26,
      peakGain: 0.34,
      attack: 0.025,
    });
    scheduleTone(eng.ctx, eng.out, {
      type: "triangle",
      freqStart: 493.88, // B4
      freqEnd: 987.77, // B5
      delay: 0.04,
      duration: 0.28,
      peakGain: 0.22,
      attack: 0.03,
    });
  } else {
    scheduleTone(eng.ctx, eng.out, {
      type: "sine",
      freqStart: 659.25,
      freqEnd: 349.23, // F4
      duration: 0.22,
      peakGain: 0.32,
      attack: 0.015,
    });
    scheduleTone(eng.ctx, eng.out, {
      type: "triangle",
      freqStart: 493.88,
      freqEnd: 261.63, // C4
      delay: 0.035,
      duration: 0.22,
      peakGain: 0.20,
      attack: 0.018,
    });
  }
}

const MONGLE_CHIRP_SEMITONES = [-3, -1, 0, 2, 4, 5] as const;

/** 몽글이 캐릭터 대화·상호작용·인사 시 부드러운 2~3음절 동물의 숲풍 보이스 치프(~130ms). */
export function playMongleChirp(seed = 0): void {
  const now = performance.now();
  if (now - lastChirpAt < CHIRP_COOLDOWN_MS) return;
  const eng = getAudioEngine();
  if (!eng) return;
  lastChirpAt = now;

  let semitone = 0;
  let variant = 0;
  if (Number.isFinite(seed)) {
    if (Math.abs(seed) <= 12) {
      semitone = seed;
      variant = Math.abs(Math.round(seed)) % 3;
    } else {
      const h = Math.abs(Math.trunc(seed));
      semitone = MONGLE_CHIRP_SEMITONES[h % MONGLE_CHIRP_SEMITONES.length] ?? 0;
      variant = h % 3;
    }
  }

  const mult = Math.pow(2, semitone / 12);
  // 1음절: 포근하게 올라가는 사인 톤
  scheduleTone(eng.ctx, eng.out, {
    type: "sine",
    freqStart: 440 * mult,
    freqEnd: (variant === 1 ? 610 : 650) * mult,
    duration: 0.052,
    peakGain: 0.28,
    attack: 0.008,
  });
  // 2음절: 따뜻한 트라이앵글 억양
  scheduleTone(eng.ctx, eng.out, {
    type: "triangle",
    freqStart: (variant === 1 ? 650 : 570) * mult,
    freqEnd: (variant === 2 ? 700 : 790) * mult,
    delay: 0.044,
    duration: 0.058,
    peakGain: 0.21,
    attack: 0.008,
  });
  // 3음절: 짧은 여운 끝음 (총 ~134ms)
  if (variant !== 0) {
    scheduleTone(eng.ctx, eng.out, {
      type: "sine",
      freqStart: (variant === 2 ? 690 : 620) * mult,
      freqEnd: (variant === 1 ? 540 : 760) * mult,
      delay: 0.082,
      duration: 0.052,
      peakGain: 0.14,
      attack: 0.007,
    });
  }
}

/** `[감시자]` 깨우기·질문 도착 시 은은한 크리스탈 풍경 종소리. */
export function playWakeChime(): void {
  const now = performance.now();
  if (now - lastChimeAt < CHIME_COOLDOWN_MS) return;
  const eng = getAudioEngine();
  if (!eng) return;
  lastChimeAt = now;

  scheduleTone(eng.ctx, eng.out, {
    type: "sine",
    freqStart: 880, // A5
    duration: 0.34,
    peakGain: 0.32,
    attack: 0.012,
  });
  scheduleTone(eng.ctx, eng.out, {
    type: "sine",
    freqStart: 1318.5, // E6
    delay: 0.075,
    duration: 0.38,
    peakGain: 0.26,
    attack: 0.012,
  });
  scheduleTone(eng.ctx, eng.out, {
    type: "triangle",
    freqStart: 1760, // A6
    delay: 0.15,
    duration: 0.36,
    peakGain: 0.16,
    attack: 0.015,
  });
}

/** 채팅·지시 전송 시 경쾌한 크리스탈 팝음. */
export function playSend(): void {
  const eng = getAudioEngine();
  if (!eng) return;

  scheduleTone(eng.ctx, eng.out, {
    type: "sine",
    freqStart: 460,
    freqEnd: 690,
    duration: 0.085,
    peakGain: 0.36,
    attack: 0.006,
  });
  scheduleTone(eng.ctx, eng.out, {
    type: "triangle",
    freqStart: 920,
    freqEnd: 1040,
    delay: 0.04,
    duration: 0.09,
    peakGain: 0.22,
    attack: 0.006,
  });
}

function getShortNoiseBuffer(ctx: AudioContext): AudioBuffer | null {
  if (cachedNoiseCtx === ctx && cachedNoiseBuf) return cachedNoiseBuf;
  try {
    const length = Math.max(1, Math.floor(ctx.sampleRate * 0.12));
    const buf = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    cachedNoiseCtx = ctx;
    cachedNoiseBuf = buf;
    return buf;
  } catch {
    return null;
  }
}

function scheduleFilteredNoise(
  ctx: AudioContext,
  out: GainNode,
  opts: {
    readonly delay?: number | undefined;
    readonly duration: number;
    readonly centerFreq: number;
    readonly q: number;
    readonly peakGain: number;
    readonly attack?: number | undefined;
  },
): void {
  const buf = getShortNoiseBuffer(ctx);
  if (!buf) return;
  const t0 = ctx.currentTime + (opts.delay ?? 0);
  const attack = Math.min(opts.attack ?? 0.005, opts.duration * 0.4);
  const tEnd = t0 + opts.duration;

  const src = ctx.createBufferSource();
  src.buffer = buf;

  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(opts.centerFreq, t0);
  filter.Q.setValueAtTime(opts.q, t0);

  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.linearRampToValueAtTime(opts.peakGain, t0 + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, tEnd);

  src.connect(filter);
  filter.connect(env);
  env.connect(out);
  src.onended = () => {
    src.disconnect();
    filter.disconnect();
    env.disconnect();
  };
  src.start(t0);
  src.stop(tEnd + 0.01);
}

/** 마을·구역 워프/텔레포트 시 반짝이는 순간이동 스윕. */
export function playWarp(): void {
  const eng = getAudioEngine();
  if (!eng) return;

  scheduleTone(eng.ctx, eng.out, {
    type: "sine",
    freqStart: 392, // G4
    freqEnd: 1174.66, // D6
    duration: 0.26,
    peakGain: 0.32,
    attack: 0.018,
  });
  scheduleTone(eng.ctx, eng.out, {
    type: "triangle",
    freqStart: 587.33, // D5
    freqEnd: 1567.98, // G6
    delay: 0.055,
    duration: 0.28,
    peakGain: 0.22,
    attack: 0.018,
  });
}

/** 구역/마을 티어 레벨업 축하 팡파르 (밝은 상승 아르페지오 + 반짝임). */
export function playLevelUpFanfare(): void {
  const eng = getAudioEngine();
  if (!eng) return;

  const notes: readonly [number, number, number, number][] = [
    [523.25, 0.0, 0.16, 0.36], // C5
    [659.25, 0.08, 0.17, 0.38], // E5
    [783.99, 0.16, 0.19, 0.40], // G5
    [987.77, 0.24, 0.22, 0.36], // B5
    [1046.5, 0.32, 0.48, 0.44], // C6
  ];
  for (const [freq, delay, duration, peakGain] of notes) {
    scheduleTone(eng.ctx, eng.out, {
      type: "triangle",
      freqStart: freq,
      delay,
      duration,
      peakGain,
      attack: 0.01,
    });
  }
  // 상단 크리스탈 반짝임 화음
  scheduleTone(eng.ctx, eng.out, {
    type: "sine",
    freqStart: 1567.98, // G6
    delay: 0.36,
    duration: 0.42,
    peakGain: 0.24,
    attack: 0.016,
  });
  scheduleTone(eng.ctx, eng.out, {
    type: "sine",
    freqStart: 2093.0, // C7
    delay: 0.44,
    duration: 0.46,
    peakGain: 0.18,
    attack: 0.018,
  });
}

/** 작전 깃발 꽂기 시 경쾌한 깃대 착지음 + 크리스탈 차임. */
export function playFlagPlant(): void {
  const eng = getAudioEngine();
  if (!eng) return;

  // 깃대 땅 꽂힘 툭!
  scheduleTone(eng.ctx, eng.out, {
    type: "triangle",
    freqStart: 195,
    freqEnd: 92,
    duration: 0.075,
    peakGain: 0.42,
    attack: 0.004,
  });
  // 경쾌한 2음 차임 (E5 -> A5)
  scheduleTone(eng.ctx, eng.out, {
    type: "sine",
    freqStart: 659.25,
    delay: 0.05,
    duration: 0.18,
    peakGain: 0.34,
    attack: 0.008,
  });
  scheduleTone(eng.ctx, eng.out, {
    type: "triangle",
    freqStart: 880.0,
    delay: 0.11,
    duration: 0.28,
    peakGain: 0.30,
    attack: 0.01,
  });
}

/** 포토 모드 전환·캡처 시 부드러운 카메라 셔터 클릭. */
export function playPhotoShutter(): void {
  const eng = getAudioEngine();
  if (!eng) return;

  scheduleFilteredNoise(eng.ctx, eng.out, {
    duration: 0.032,
    centerFreq: 2600,
    q: 1.8,
    peakGain: 0.26,
    attack: 0.002,
  });
  scheduleTone(eng.ctx, eng.out, {
    type: "triangle",
    freqStart: 1120,
    freqEnd: 540,
    duration: 0.028,
    peakGain: 0.16,
    attack: 0.002,
  });
  scheduleFilteredNoise(eng.ctx, eng.out, {
    delay: 0.052,
    duration: 0.038,
    centerFreq: 1850,
    q: 2.1,
    peakGain: 0.22,
    attack: 0.003,
  });
}

export type WorldFootstepSurface = "grass" | "stone" | "wood" | "water";

/** 플레이어 이동 발소리 (지면 재질별: 돌길·풀밭·나무다리·물가, 280ms 쿨다운 초저음량). */
export function playFootstep(surface: WorldFootstepSurface | boolean = "grass"): void {
  const now = performance.now();
  if (now - lastFootstepAt < FOOTSTEP_COOLDOWN_MS) return;
  const eng = getAudioEngine();
  if (!eng) return;
  lastFootstepAt = now;

  const kind: WorldFootstepSurface =
    typeof surface === "boolean" ? (surface ? "wood" : "grass") : surface;
  const jitter = 0.92 + Math.random() * 0.16;

  if (kind === "wood") {
    // 목교 판자: 따뜻하고 울리는 나무 쿵쿵
    scheduleTone(eng.ctx, eng.out, {
      type: "triangle",
      freqStart: 228 * jitter,
      freqEnd: 118 * jitter,
      duration: 0.052,
      peakGain: 0.16,
      attack: 0.003,
    });
    scheduleFilteredNoise(eng.ctx, eng.out, {
      duration: 0.034,
      centerFreq: 780 * jitter,
      q: 2.4,
      peakGain: 0.085,
      attack: 0.002,
    });
    return;
  }

  if (kind === "stone") {
    // 광장/돌길: 맑고 경쾌한 또각또각
    scheduleTone(eng.ctx, eng.out, {
      type: "triangle",
      freqStart: 540 * jitter,
      freqEnd: 280 * jitter,
      duration: 0.030,
      peakGain: 0.11,
      attack: 0.002,
    });
    scheduleFilteredNoise(eng.ctx, eng.out, {
      duration: 0.024,
      centerFreq: 2050 * jitter,
      q: 3.0,
      peakGain: 0.095,
      attack: 0.002,
    });
    return;
  }

  if (kind === "water") {
    // 시냇물가: 촉촉한 첨벙 물방울
    scheduleFilteredNoise(eng.ctx, eng.out, {
      duration: 0.068,
      centerFreq: 1480 * jitter,
      q: 1.5,
      peakGain: 0.13,
      attack: 0.004,
    });
    scheduleTone(eng.ctx, eng.out, {
      type: "sine",
      freqStart: 340 * jitter,
      freqEnd: 640 * jitter,
      delay: 0.012,
      duration: 0.055,
      peakGain: 0.10,
      attack: 0.005,
    });
    return;
  }

  // 초원 풀밭: 아주 은은한 사각거림 + 부드러운 접지음
  scheduleFilteredNoise(eng.ctx, eng.out, {
    duration: 0.052,
    centerFreq: 960 * jitter,
    q: 1.4,
    peakGain: 0.09,
    attack: 0.006,
  });
  scheduleTone(eng.ctx, eng.out, {
    type: "sine",
    freqStart: 128 * jitter,
    freqEnd: 78 * jitter,
    duration: 0.042,
    peakGain: 0.07,
    attack: 0.005,
  });
}

function getRainNoiseBuffer(ctx: AudioContext): AudioBuffer | null {
  if (cachedRainCtx === ctx && cachedRainBuf) return cachedRainBuf;
  try {
    const length = Math.max(1, Math.floor(ctx.sampleRate * 2.0));
    const buf = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buf.getChannelData(0);
    // 부드러운 핑크 톤 빗소리 (1차 저역 누적으로 치찰음 완화)
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + white * 0.029;
      b1 = 0.985 * b1 + white * 0.032;
      b2 = 0.950 * b2 + white * 0.048;
      data[i] = Math.max(-1, Math.min(1, (b0 + b1 + b2 + white * 0.08) * 1.4));
    }
    cachedRainCtx = ctx;
    cachedRainBuf = buf;
    return buf;
  } catch {
    return null;
  }
}

function stopRainAmbienceInternal(): void {
  if (rainGain && audioCtx && audioCtx.state !== "closed") {
    try {
      rainGain.gain.setTargetAtTime(0.0001, audioCtx.currentTime, 0.03);
    } catch {
      rainGain.gain.value = 0;
    }
  }
  const src = rainSource;
  const flt = rainFilter;
  const g = rainGain;
  rainSource = null;
  rainFilter = null;
  rainGain = null;
  if (src) {
    try {
      src.stop();
    } catch {
      // 이미 정지된 소스는 무시
    }
    try {
      src.disconnect();
    } catch {
      // ignore
    }
  }
  try {
    flt?.disconnect();
    g?.disconnect();
  } catch {
    // ignore
  }
}

function startRainAmbienceInternal(): void {
  if (rainSource || muted) return;
  if (typeof document !== "undefined" && document.hidden) return;
  bindAudioVisibilityOnce();
  const eng = getAudioEngine();
  if (!eng) return;
  const buf = getRainNoiseBuffer(eng.ctx);
  if (!buf) return;
  try {
    const src = eng.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const filter = eng.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(1150, eng.ctx.currentTime);
    filter.Q.setValueAtTime(0.75, eng.ctx.currentTime);

    const gain = eng.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, eng.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.20, eng.ctx.currentTime + 0.45);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(eng.out);
    src.start();

    rainSource = src;
    rainFilter = filter;
    rainGain = gain;
  } catch {
    stopRainAmbienceInternal();
  }
}

/** `Space` 점프 시 경쾌한 탄성 팝음. */
export function playJump(): void {
  const eng = getAudioEngine();
  if (!eng) return;

  scheduleTone(eng.ctx, eng.out, {
    type: "sine",
    freqStart: 250,
    freqEnd: 540,
    duration: 0.115,
    peakGain: 0.34,
    attack: 0.006,
  });
  scheduleTone(eng.ctx, eng.out, {
    type: "triangle",
    freqStart: 380,
    freqEnd: 720,
    delay: 0.022,
    duration: 0.095,
    peakGain: 0.22,
    attack: 0.006,
  });
}

/** 함대 상황실 「전 사령관 긴급 소집」 시 장엄한 3음 나팔 팡파르. */
export function playRallyHorn(): void {
  const eng = getAudioEngine();
  if (!eng) return;

  const scheduleBrass = (freq: number, delay: number, duration: number, peakGain: number) => {
    const t0 = eng.ctx.currentTime + delay;
    const tEnd = t0 + duration;

    const osc = eng.ctx.createOscillator();
    const filter = eng.ctx.createBiquadFilter();
    const env = eng.ctx.createGain();

    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(freq, t0);

    filter.type = "lowpass";
    filter.frequency.setValueAtTime(920, t0);
    filter.frequency.exponentialRampToValueAtTime(1850, t0 + Math.min(0.08, duration * 0.4));
    filter.frequency.exponentialRampToValueAtTime(1050, tEnd);

    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(peakGain, t0 + 0.022);
    env.gain.exponentialRampToValueAtTime(0.0001, tEnd);

    osc.connect(filter);
    filter.connect(env);
    env.connect(eng.out);
    osc.onended = () => {
      osc.disconnect();
      filter.disconnect();
      env.disconnect();
    };
    osc.start(t0);
    osc.stop(tEnd + 0.02);
  };

  // G4 -> C5 -> G5 장엄한 3음 함대 나팔 + 따뜻한 C5 화음
  scheduleBrass(392.0, 0.0, 0.17, 0.26);
  scheduleBrass(523.25, 0.17, 0.19, 0.30);
  scheduleBrass(783.99, 0.36, 0.58, 0.34);
  scheduleTone(eng.ctx, eng.out, {
    type: "triangle",
    freqStart: 523.25,
    delay: 0.36,
    duration: 0.54,
    peakGain: 0.20,
    attack: 0.02,
  });
  scheduleTone(eng.ctx, eng.out, {
    type: "sine",
    freqStart: 659.25, // E5
    delay: 0.39,
    duration: 0.48,
    peakGain: 0.16,
    attack: 0.025,
  });
}

/** 비 날씨(`rain`) 은은한 필터드 빗소리 앰비언스 제어 (음소거 시 즉시 정지). */
export function setRainAmbience(active: boolean): void {
  rainDesired = active;
  if (!active || muted) {
    stopRainAmbienceInternal();
    return;
  }
  startRainAmbienceInternal();
}

// --- 시간·날씨 반응형 프로시저럴 힐링 BGM (외부 음원 0, 기본 OFF) ---

// 낮 맑음/벚꽃: 지브리풍 펜타토닉 오르골 아르페지오 패턴 (C5·D5·E5·G5·A5·C6·D6·E6)
const DAY_ARPEGGIO_NOTES = [
  523.25, 659.25, 783.99, 659.25, 880.0, 783.99, 659.25, 587.33,
  440.0, 523.25, 659.25, 783.99, 659.25, 523.25, 587.33, 659.25,
  349.23, 523.25, 659.25, 880.0, 783.99, 659.25, 523.25, 440.0,
  392.0, 493.88, 587.33, 783.99, 659.25, 587.33, 493.88, 587.33,
] as const;

const DAY_BASS_NOTES = [261.63, 220.0, 174.61, 196.0] as const; // C4, A3, F3, G3

// 밤: 몽환적 패드 화음 (Cmaj9 -> Am9 -> Fmaj7 -> G6)
const NIGHT_PAD_CHORDS: readonly (readonly number[])[] = [
  [261.63, 329.63, 392.0, 493.88, 587.33],
  [220.0, 261.63, 329.63, 392.0, 493.88],
  [174.61, 220.0, 261.63, 329.63, 392.0],
  [196.0, 246.94, 293.66, 329.63, 392.0],
];

// 비: 잔잔한 로파이 화음 (Fmaj7 -> Em7 -> Dm7 -> Cmaj7)
const RAIN_LOFI_CHORDS: readonly (readonly number[])[] = [
  [174.61, 220.0, 261.63, 329.63],
  [164.81, 196.0, 246.94, 293.66],
  [146.83, 174.61, 220.0, 261.63],
  [130.81, 164.81, 196.0, 246.94],
];

function ensureBgmGain(eng: { readonly ctx: AudioContext; readonly out: GainNode }): GainNode | null {
  try {
    if (bgmGain && bgmGainCtx === eng.ctx) {
      return bgmGain;
    }
    const g = eng.ctx.createGain();
    g.gain.setValueAtTime(0.52, eng.ctx.currentTime);
    g.connect(eng.out);
    bgmGain = g;
    bgmGainCtx = eng.ctx;
    return g;
  } catch {
    return null;
  }
}

function stopBgmRainBed(): void {
  const src = bgmRainSource;
  const flt = bgmRainFilter;
  const g = bgmRainGain;
  bgmRainSource = null;
  bgmRainFilter = null;
  bgmRainGain = null;
  if (src) {
    try {
      src.stop();
    } catch {
      // ignore
    }
    try {
      src.disconnect();
    } catch {
      // ignore
    }
  }
  try {
    flt?.disconnect();
    g?.disconnect();
  } catch {
    // ignore
  }
}

function syncBgmRainBed(eng: { readonly ctx: AudioContext; readonly out: GainNode }, bgmOut: GainNode): void {
  // 월드 자체 rain 앰비언스가 꺼져 있을 때만 BGM 로파이용 초미세 빗결 레이어를 겹친다
  const needBed = bgmDesired && !muted && bgmWeather === "rain" && !rainSource;
  if (!needBed) {
    stopBgmRainBed();
    return;
  }
  if (bgmRainSource) return;
  const buf = getRainNoiseBuffer(eng.ctx);
  if (!buf) return;
  try {
    const src = eng.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const filter = eng.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(1400, eng.ctx.currentTime);
    filter.Q.setValueAtTime(0.6, eng.ctx.currentTime);

    const gain = eng.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, eng.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.11, eng.ctx.currentTime + 0.5);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(bgmOut);
    src.start();

    bgmRainSource = src;
    bgmRainFilter = filter;
    bgmRainGain = gain;
  } catch {
    stopBgmRainBed();
  }
}

function scheduleBgmStep(): void {
  if (!bgmDesired || muted) return;
  if (typeof document !== "undefined" && document.hidden) return;
  const eng = getAudioEngine();
  if (!eng || eng.ctx.state !== "running") return;
  const bgmOut = ensureBgmGain(eng);
  if (!bgmOut) return;

  syncBgmRainBed(eng, bgmOut);

  const step = bgmStep;
  bgmStep = (bgmStep + 1) % 64;

  if (bgmWeather === "rain") {
    // 비: 4스텝(2.6초)마다 따뜻한 로파이 Rhodes 스타일 화음 + 간헐적 높은 빗방울 멜로디
    if (step % 4 === 0) {
      const chord = RAIN_LOFI_CHORDS[Math.floor(step / 4) % RAIN_LOFI_CHORDS.length]!;
      for (let i = 0; i < chord.length; i += 1) {
        scheduleTone(eng.ctx, bgmOut, {
          type: i === 0 ? "sine" : "triangle",
          freqStart: chord[i]!,
          delay: i * 0.035,
          duration: 2.35,
          peakGain: i === 0 ? 0.085 : 0.052,
          attack: 0.16,
        });
      }
    } else if (step % 4 === 2) {
      const melody = DAY_ARPEGGIO_NOTES[step % DAY_ARPEGGIO_NOTES.length]!;
      scheduleTone(eng.ctx, bgmOut, {
        type: "sine",
        freqStart: melody * 0.5,
        duration: 0.72,
        peakGain: 0.06,
        attack: 0.04,
      });
    }
    return;
  }

  if (bgmNightFactor >= 0.55) {
    // 밤: 몽환적 패드 화음 + 따뜻한 모닥불 미세 타닥임 + 은은한 풀벌레
    if (step % 6 === 0) {
      const chord = NIGHT_PAD_CHORDS[Math.floor(step / 6) % NIGHT_PAD_CHORDS.length]!;
      for (let i = 0; i < chord.length; i += 1) {
        scheduleTone(eng.ctx, bgmOut, {
          type: "sine",
          freqStart: chord[i]!,
          delay: i * 0.06,
          duration: 3.4,
          peakGain: i < 2 ? 0.068 : 0.042,
          attack: 0.45,
        });
      }
    }
    // 따뜻한 모닥불 미세 타닥임 (가볍고 랜덤하게)
    if (step % 2 === 1 && Math.random() < 0.65) {
      scheduleFilteredNoise(eng.ctx, bgmOut, {
        delay: Math.random() * 0.25,
        duration: 0.022 + Math.random() * 0.018,
        centerFreq: 2400 + Math.random() * 1600,
        q: 2.4,
        peakGain: 0.065,
        attack: 0.002,
      });
    }
    // 은은한 풀벌레 이중 펄스 (매 5스텝 중 1회)
    if (step % 5 === 2) {
      const cricketFreq = 4150 + (step % 3) * 140;
      scheduleTone(eng.ctx, bgmOut, {
        type: "sine",
        freqStart: cricketFreq,
        freqEnd: cricketFreq + 60,
        delay: 0.08,
        duration: 0.075,
        peakGain: 0.022,
        attack: 0.012,
      });
      scheduleTone(eng.ctx, bgmOut, {
        type: "sine",
        freqStart: cricketFreq,
        freqEnd: cricketFreq + 40,
        delay: 0.21,
        duration: 0.085,
        peakGain: 0.020,
        attack: 0.012,
      });
    }
    return;
  }

  // 낮 맑음 / 벚꽃 / 눈: 지브리풍 잔잔한 펜타토닉 오르골·어쿠스틱 아르페지오
  const note = DAY_ARPEGGIO_NOTES[step % DAY_ARPEGGIO_NOTES.length]!;
  const isAiry = bgmWeather === "sakura" || bgmWeather === "snow";
  scheduleTone(eng.ctx, bgmOut, {
    type: isAiry ? "sine" : "triangle",
    freqStart: isAiry ? note * 1.0 : note,
    duration: isAiry ? 0.85 : 0.68,
    peakGain: isAiry ? 0.085 : 0.095,
    attack: 0.016,
  });
  if (isAiry && step % 2 === 0) {
    // 벚꽃/눈 날씨에는 한 옥타브 위 유리 오르골 배음을 살짝 얹는다
    scheduleTone(eng.ctx, bgmOut, {
      type: "sine",
      freqStart: note * 2.0,
      delay: 0.04,
      duration: 0.55,
      peakGain: 0.028,
      attack: 0.012,
    });
  }
  if (step % 8 === 0) {
    const bass = DAY_BASS_NOTES[Math.floor(step / 8) % DAY_BASS_NOTES.length]!;
    scheduleTone(eng.ctx, bgmOut, {
      type: "sine",
      freqStart: bass,
      duration: 2.4,
      peakGain: 0.09,
      attack: 0.09,
    });
  }
}

function stopBgmInternal(): void {
  if (bgmIntervalId !== null && typeof window !== "undefined") {
    window.clearInterval(bgmIntervalId);
    bgmIntervalId = null;
  }
  stopBgmRainBed();
}

function bindAudioVisibilityOnce(): void {
  if (audioVisBound || typeof document === "undefined") return;
  audioVisBound = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopBgmInternal();
      stopRainAmbienceInternal();
      stopSpatialAmbienceInternal();
    } else if (!muted) {
      if (bgmDesired) startBgmInternal();
      if (rainDesired) startRainAmbienceInternal();
    }
  });
}

function startBgmInternal(): void {
  if (!bgmDesired || muted || typeof window === "undefined") return;
  if (typeof document !== "undefined" && document.hidden) return;
  bindAudioVisibilityOnce();
  // AudioContext 활성화 시도 (사용자 클릭 직후 resume)
  const eng = getAudioEngine();
  if (!eng) return;
  if (bgmIntervalId !== null) return;
  scheduleBgmStep();
  bgmIntervalId = window.setInterval(scheduleBgmStep, 650);
}

/** 시간·날씨 반응형 프로시저럴 힐링 배경음(BGM) 켜기/끄기 (기본 OFF, 음소거·탭 비활성화 안전). */
export function setBgmEnabled(enabled: boolean): void {
  bgmDesired = enabled;
  if (!enabled || muted) {
    stopBgmInternal();
    return;
  }
  startBgmInternal();
}

/** 현재 힐링 배경음(BGM) 활성화 여부. */
export function isBgmEnabled(): boolean {
  return bgmDesired;
}

/** 현재 월드의 야간 계수(`0..1`)와 날씨(`clear|sakura|rain|snow`)를 BGM 신스에 반영한다. */
export function updateBgmEnvironment(night: number, weather: WorldWeatherMode): void {
  bgmNightFactor = Math.max(0, Math.min(1, night));
  const weatherChanged = bgmWeather !== weather;
  bgmWeather = weather;
  if (weatherChanged && bgmDesired && !muted) {
    const eng = getAudioEngine();
    const bgmOut = eng ? ensureBgmGain(eng) : null;
    if (eng && bgmOut) {
      syncBgmRainBed(eng, bgmOut);
    }
  }
}

// --- Sprint 14: 별빛 상공 비행 & 유성 급강하 착지 효과음 4종 ---

/** `M` 별빛 비행 이륙 시 영롱하게 솟아오르는 상승 하프 글리산도 (하위 호환). */
export function playStarTakeoff(): void {
  playStarTakeoffAscend();
}

/** `M` 이륙 1단계(`charge`): 귀엽고 힘찬 제자리 화이팅 상승 차임. */
export function playStarTakeoffCharge(): void {
  const eng = getAudioEngine();
  if (!eng) return;

  const notes = [392.0, 493.88, 587.33, 783.99] as const; // G4 B4 D5 G5
  for (let i = 0; i < notes.length; i += 1) {
    scheduleTone(eng.ctx, eng.out, {
      type: i < 2 ? "triangle" : "sine",
      freqStart: notes[i]!,
      freqEnd: notes[i]! * 1.03,
      delay: i * 0.055,
      duration: 0.16,
      peakGain: 0.24 + i * 0.025,
      attack: 0.007,
    });
  }
}

/** `M` 이륙 2단계(`ascend`): 빙글빙글 회오리 수직 급상승 별빛 글리산도 + 상승 바람. */
export function playStarTakeoffAscend(): void {
  const eng = getAudioEngine();
  if (!eng) return;

  const notes = [523.25, 659.25, 783.99, 987.77, 1174.66, 1567.98, 1975.53] as const; // C5..B6
  for (let i = 0; i < notes.length; i += 1) {
    scheduleTone(eng.ctx, eng.out, {
      type: i % 2 === 0 ? "sine" : "triangle",
      freqStart: notes[i]!,
      freqEnd: notes[i]! * 1.02,
      delay: i * 0.044,
      duration: 0.26,
      peakGain: Math.max(0.11, 0.25 - i * 0.018),
      attack: 0.008,
    });
  }
  scheduleFilteredNoise(eng.ctx, eng.out, {
    duration: 0.42,
    centerFreq: 1420,
    q: 1.6,
    peakGain: 0.16,
    attack: 0.04,
  });
}

/** 비행 중 `Space` 360° 에일러론 배럴롤 시 경쾌한 공중 회전 트윙클. */
export function playBarrelRoll(): void {
  const eng = getAudioEngine();
  if (!eng) return;

  const notes = [783.99, 987.77, 1174.66, 1567.98, 1174.66] as const; // G5 B5 D6 G6 D6
  for (let i = 0; i < notes.length; i += 1) {
    scheduleTone(eng.ctx, eng.out, {
      type: i % 2 === 0 ? "sine" : "triangle",
      freqStart: notes[i]!,
      delay: i * 0.036,
      duration: 0.14,
      peakGain: 0.20,
      attack: 0.006,
    });
  }
}

/** 별똥별 급강하 시작 시 하늘을 가르는 슈웅~ 쉬머 하강 스윕. */
export function playMeteorDive(): void {
  const eng = getAudioEngine();
  if (!eng) return;

  scheduleTone(eng.ctx, eng.out, {
    type: "sine",
    freqStart: 1380,
    freqEnd: 340,
    duration: 0.48,
    peakGain: 0.26,
    attack: 0.015,
  });
  scheduleTone(eng.ctx, eng.out, {
    type: "triangle",
    freqStart: 1860,
    freqEnd: 520,
    delay: 0.04,
    duration: 0.42,
    peakGain: 0.16,
    attack: 0.012,
  });
  scheduleFilteredNoise(eng.ctx, eng.out, {
    duration: 0.44,
    centerFreq: 1650,
    q: 1.4,
    peakGain: 0.22,
    attack: 0.03,
  });
}

/** 유성 급강하 착지 순간 닌텐도 스타 차임 + 포근한 저음 착지 쿵. */
export function playMeteorImpact(): void {
  const eng = getAudioEngine();
  if (!eng) return;

  // 부드러운 저음 쿵
  scheduleTone(eng.ctx, eng.out, {
    type: "sine",
    freqStart: 155,
    freqEnd: 52,
    duration: 0.18,
    peakGain: 0.48,
    attack: 0.005,
  });
  // 반짝이는 스타 착지 차임 화음 (C5 · G5 · C6 · E6)
  const chime = [523.25, 783.99, 1046.5, 1318.51] as const;
  for (let i = 0; i < chime.length; i += 1) {
    scheduleTone(eng.ctx, eng.out, {
      type: i < 2 ? "triangle" : "sine",
      freqStart: chime[i]!,
      delay: 0.018 + i * 0.034,
      duration: 0.34,
      peakGain: 0.26 - i * 0.032,
      attack: 0.006,
    });
  }
}

/** 별빛 비행 중 `Shift` 별똥별 부스트 점화 스윕 (380ms 쿨다운). */
export function playStarBoost(): void {
  const now = performance.now();
  if (now - lastBoostAt < BOOST_COOLDOWN_MS) return;
  const eng = getAudioEngine();
  if (!eng) return;
  lastBoostAt = now;

  scheduleTone(eng.ctx, eng.out, {
    type: "sine",
    freqStart: 480,
    freqEnd: 1120,
    duration: 0.22,
    peakGain: 0.26,
    attack: 0.01,
  });
  scheduleTone(eng.ctx, eng.out, {
    type: "triangle",
    freqStart: 720,
    freqEnd: 1480,
    delay: 0.03,
    duration: 0.20,
    peakGain: 0.16,
    attack: 0.01,
  });
}

// --- Sprint 17: 포토 스튜디오 · 동행 호출 · 이모트 휠 프로시저럴 SFX 3종 ---

/** 포토 스튜디오(`P`) 스냅샷 촬영 시 기계 셔터 클릭 + 은은한 별빛 차임. */
export function playCameraShutter(): void {
  const eng = getAudioEngine();
  if (!eng) return;

  // 1차·2차 기계 셔터 찰칵 (34ms 간격)
  scheduleFilteredNoise(eng.ctx, eng.out, {
    duration: 0.026,
    centerFreq: 3400,
    q: 2.2,
    peakGain: 0.42,
    attack: 0.002,
  });
  scheduleFilteredNoise(eng.ctx, eng.out, {
    delay: 0.034,
    duration: 0.032,
    centerFreq: 2450,
    q: 1.8,
    peakGain: 0.36,
    attack: 0.002,
  });
  // 은은한 별빛 확인 차임
  scheduleTone(eng.ctx, eng.out, {
    type: "sine",
    freqStart: 1318.51, // E6
    delay: 0.055,
    duration: 0.17,
    peakGain: 0.16,
    attack: 0.008,
  });
  scheduleTone(eng.ctx, eng.out, {
    type: "triangle",
    freqStart: 1975.53, // B6
    delay: 0.095,
    duration: 0.20,
    peakGain: 0.11,
    attack: 0.008,
  });
}

/** 사령관 동행 산책 호출 시 경쾌하고 따뜻한 2음 휘파람·차임. */
export function playCompanionCall(): void {
  const eng = getAudioEngine();
  if (!eng) return;

  // G5 -> C6 밝은 2음 동행 부름
  scheduleTone(eng.ctx, eng.out, {
    type: "sine",
    freqStart: 740,
    freqEnd: 783.99, // G5
    duration: 0.11,
    peakGain: 0.30,
    attack: 0.01,
  });
  scheduleTone(eng.ctx, eng.out, {
    type: "sine",
    freqStart: 987.77,
    freqEnd: 1046.5, // C6
    delay: 0.095,
    duration: 0.18,
    peakGain: 0.32,
    attack: 0.01,
  });
  scheduleTone(eng.ctx, eng.out, {
    type: "triangle",
    freqStart: 1567.98, // G6 배음
    delay: 0.105,
    duration: 0.16,
    peakGain: 0.12,
    attack: 0.01,
  });
}

/** 제독 이모트 휠(`B`) 실행 시 동작별 맑은 반짝이 효과음. */
export function playEmoteSparkle(kind?: string): void {
  const eng = getAudioEngine();
  if (!eng) return;

  if (kind === "clap") {
    // 경쾌한 3연 박수 톡톡 + 밝은 틱
    for (let i = 0; i < 3; i += 1) {
      scheduleFilteredNoise(eng.ctx, eng.out, {
        delay: i * 0.095,
        duration: 0.036,
        centerFreq: 1850 + i * 160,
        q: 1.5,
        peakGain: 0.34,
        attack: 0.002,
      });
    }
    scheduleTone(eng.ctx, eng.out, {
      type: "sine",
      freqStart: 880,
      freqEnd: 1174.66,
      delay: 0.02,
      duration: 0.16,
      peakGain: 0.14,
      attack: 0.008,
    });
    return;
  }

  if (kind === "twirl" || kind === "stardust") {
    const notes = kind === "stardust"
      ? [783.99, 1046.5, 1318.51, 1567.98, 2093.0]
      : [659.25, 880.0, 1174.66, 1567.98];
    for (let i = 0; i < notes.length; i += 1) {
      scheduleTone(eng.ctx, eng.out, {
        type: i % 2 === 0 ? "sine" : "triangle",
        freqStart: notes[i]!,
        delay: i * 0.038,
        duration: 0.18,
        peakGain: 0.22 - i * 0.022,
        attack: 0.007,
      });
    }
    return;
  }

  if (kind === "sit") {
    scheduleTone(eng.ctx, eng.out, {
      type: "sine",
      freqStart: 523.25,
      freqEnd: 392.0,
      duration: 0.18,
      peakGain: 0.24,
      attack: 0.012,
    });
    return;
  }

  // 기본 / cheer / wave: 맑은 3음 반짝이 차임
  const base = kind === "wave" ? 587.33 : 659.25;
  scheduleTone(eng.ctx, eng.out, {
    type: "sine",
    freqStart: base,
    duration: 0.13,
    peakGain: 0.26,
    attack: 0.008,
  });
  scheduleTone(eng.ctx, eng.out, {
    type: "triangle",
    freqStart: base * 1.25,
    delay: 0.048,
    duration: 0.15,
    peakGain: 0.22,
    attack: 0.008,
  });
  scheduleTone(eng.ctx, eng.out, {
    type: "sine",
    freqStart: base * 1.5,
    delay: 0.095,
    duration: 0.18,
    peakGain: 0.18,
    attack: 0.008,
  });
}

// --- Sprint 21: 거리 기반 공간 자연음(시냇물 · 모닥불 · 숲) + 하늘 링 콤보 · 스탬프 해금 SFX ---

interface SpatialAmbienceNodes {
  readonly ctx: AudioContext;
  readonly brookSrc: AudioBufferSourceNode;
  readonly brookFilter: BiquadFilterNode;
  readonly brookGain: GainNode;
  readonly fireSrc: AudioBufferSourceNode;
  readonly fireFilter: BiquadFilterNode;
  readonly fireGain: GainNode;
  readonly forestSrc: AudioBufferSourceNode;
  readonly forestFilter: BiquadFilterNode;
  readonly forestGain: GainNode;
}

let spatialNodes: SpatialAmbienceNodes | null = null;
let lastFireCrackleAt = 0;
let nextFireCrackleGapMs = 320;
let lastForestWildlifeAt = 0;
let nextForestWildlifeGapMs = 2600;

function stopSpatialAmbienceInternal(): void {
  const nodes = spatialNodes;
  spatialNodes = null;
  if (!nodes) return;
  for (const src of [nodes.brookSrc, nodes.fireSrc, nodes.forestSrc]) {
    try {
      src.stop();
      src.disconnect();
    } catch {
      // 이미 정지된 노드는 무시한다.
    }
  }
  for (const node of [
    nodes.brookFilter,
    nodes.brookGain,
    nodes.fireFilter,
    nodes.fireGain,
    nodes.forestFilter,
    nodes.forestGain,
  ]) {
    try {
      node.disconnect();
    } catch {
      // ignore
    }
  }
}

function ensureSpatialAmbienceNodes(): SpatialAmbienceNodes | null {
  if (muted || !audioCtx || !masterGain || audioCtx.state !== "running") return null;
  if (typeof document !== "undefined" && document.hidden) return null;
  bindAudioVisibilityOnce();
  if (spatialNodes && spatialNodes.ctx === audioCtx) return spatialNodes;
  stopSpatialAmbienceInternal();

  try {
    const ctx = audioCtx;
    const out = masterGain;
    const buf = getRainNoiseBuffer(ctx);

    const makeBed = (
      type: BiquadFilterType,
      freq: number,
      q: number,
    ): { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode } => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.setValueAtTime(freq, ctx.currentTime);
      filter.Q.setValueAtTime(q, ctx.currentTime);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(out);
      src.start();
      return { src, filter, gain };
    };

    const brook = makeBed("bandpass", 920, 1.15);
    const fire = makeBed("lowpass", 340, 0.75);
    const forest = makeBed("bandpass", 540, 0.95);
    spatialNodes = {
      ctx,
      brookSrc: brook.src,
      brookFilter: brook.filter,
      brookGain: brook.gain,
      fireSrc: fire.src,
      fireFilter: fire.filter,
      fireGain: fire.gain,
      forestSrc: forest.src,
      forestFilter: forest.filter,
      forestGain: forest.gain,
    };
    return spatialNodes;
  } catch {
    return null;
  }
}

export interface SpatialAmbienceOptions {
  readonly brookDist: number;
  readonly campfireDist: number;
  readonly forestDist: number;
  readonly isNight: boolean;
  readonly isRain: boolean;
  readonly active: boolean;
}

/**
 * 플레이어 위치 기준 시냇물(졸졸)·모닥불(타닥타닥)·숲(산들바람·새소리/밤 풀벌레) 공간 자연음을 0-GC로 믹싱한다.
 * 사용자 오디오 제스처 이전이나 음소거·비활성 시 안전하게 무음 유지/해제한다.
 */
export function updateSpatialAmbience(opts: SpatialAmbienceOptions): void {
  if (!opts.active || muted) {
    if (spatialNodes) {
      stopSpatialAmbienceInternal();
    }
    return;
  }

  const nodes = ensureSpatialAmbienceNodes();
  if (!nodes || !masterGain) return;
  const ctx = nodes.ctx;
  const t = ctx.currentTime;

  // 거리 감쇠 (부드러운 2차 곡선)
  const brookFactor = Math.max(0, 1 - opts.brookDist / 18);
  const brookVol = brookFactor * brookFactor * 0.14;
  const fireFactor = Math.max(0, 1 - opts.campfireDist / 14);
  const fireVol = fireFactor * fireFactor * 0.10;
  const forestFactor = Math.max(0, 1 - opts.forestDist / 16);
  const forestVol = forestFactor * forestFactor * 0.08;

  // 시냇물 필터 주파수를 완만하게 변조해 졸졸 흐르는 물결 질감 연출
  const brookFreq = 860 + Math.sin(t * 2.1) * 140 + Math.cos(t * 3.4) * 70;
  nodes.brookFilter.frequency.setTargetAtTime(brookFreq, t, 0.12);
  nodes.brookGain.gain.setTargetAtTime(Math.max(0.0001, brookVol), t, 0.18);
  nodes.fireGain.gain.setTargetAtTime(Math.max(0.0001, fireVol), t, 0.18);
  nodes.forestGain.gain.setTargetAtTime(Math.max(0.0001, forestVol), t, 0.22);

  const nowMs = performance.now();

  // 모닥불 근접 시 따뜻한 장작 타닥타닥 크래클
  if (fireFactor > 0.18 && nowMs - lastFireCrackleAt >= nextFireCrackleGapMs) {
    lastFireCrackleAt = nowMs;
    nextFireCrackleGapMs = 190 + Math.random() * 340;
    scheduleFilteredNoise(ctx, masterGain, {
      duration: 0.018 + Math.random() * 0.014,
      centerFreq: 2600 + Math.random() * 1900,
      q: 2.6,
      peakGain: (0.045 + Math.random() * 0.055) * fireFactor,
      attack: 0.002,
    });
  }

  // 숲 근접 시 낮 작은 새 지저귐 / 밤 은은한 풀벌레 울음 (우천 시 휴식)
  if (!opts.isRain && forestFactor > 0.20 && nowMs - lastForestWildlifeAt >= nextForestWildlifeGapMs) {
    lastForestWildlifeAt = nowMs;
    if (opts.isNight) {
      nextForestWildlifeGapMs = 1800 + Math.random() * 1700;
      const baseHz = 3600 + Math.random() * 420;
      for (let i = 0; i < 3; i += 1) {
        scheduleTone(ctx, masterGain, {
          type: "sine",
          freqStart: baseHz,
          delay: i * 0.065,
          duration: 0.045,
          peakGain: 0.022 * forestFactor,
          attack: 0.006,
        });
      }
    } else {
      nextForestWildlifeGapMs = 2600 + Math.random() * 2400;
      const f0 = 1580 + Math.random() * 480;
      scheduleTone(ctx, masterGain, {
        type: "sine",
        freqStart: f0,
        freqEnd: f0 * 1.24,
        duration: 0.085,
        peakGain: 0.036 * forestFactor,
        attack: 0.008,
      });
      scheduleTone(ctx, masterGain, {
        type: "sine",
        freqStart: f0 * 1.18,
        freqEnd: f0 * 1.42,
        delay: 0.105,
        duration: 0.11,
        peakGain: 0.032 * forestFactor,
        attack: 0.008,
      });
    }
  }
}

const SKY_RING_PENTATONIC = [
  523.25, // C5 도
  587.33, // D5 레
  659.25, // E5 미
  783.99, // G5 솔
  880.0, // A5 라
  1046.5, // C6 도
  1174.66, // D6 레
  1318.51, // E6 미
] as const;

/** 하늘 순찰 별빛 링 통과 시 콤보에 따라 올라가는 5음계 하프 화음. */
export function playSkyRingChime(comboIndex: number): void {
  const eng = getAudioEngine();
  if (!eng) return;

  const idx = Math.max(0, Math.floor(comboIndex)) % SKY_RING_PENTATONIC.length;
  const root = SKY_RING_PENTATONIC[idx]!;
  const fifth = root * 1.4983;
  const octave = root * 2.0;

  scheduleTone(eng.ctx, eng.out, {
    type: "triangle",
    freqStart: root,
    duration: 0.28,
    peakGain: 0.34,
    attack: 0.006,
  });
  scheduleTone(eng.ctx, eng.out, {
    type: "sine",
    freqStart: fifth,
    delay: 0.038,
    duration: 0.26,
    peakGain: 0.24,
    attack: 0.006,
  });
  scheduleTone(eng.ctx, eng.out, {
    type: "sine",
    freqStart: octave,
    delay: 0.075,
    duration: 0.34,
    peakGain: 0.19,
    attack: 0.008,
  });
}

/** 별빛 항해 수첩 스탬프 최초 해금 시 맑은 오르골 팡파르. */
export function playStampUnlock(): void {
  const eng = getAudioEngine();
  if (!eng) return;

  // C5 -> E5 -> G5 -> B5 -> C6 맑은 오르골 상승 아르페지오 + 반짝임 배음
  const notes = [523.25, 659.25, 783.99, 987.77, 1046.5] as const;
  for (let i = 0; i < notes.length; i += 1) {
    const isLast = i === notes.length - 1;
    scheduleTone(eng.ctx, eng.out, {
      type: i % 2 === 0 ? "sine" : "triangle",
      freqStart: notes[i]!,
      delay: i * 0.068,
      duration: isLast ? 0.48 : 0.24,
      peakGain: isLast ? 0.34 : 0.26,
      attack: 0.007,
    });
  }
  scheduleTone(eng.ctx, eng.out, {
    type: "sine",
    freqStart: 2093.0, // C7 오르골 반짝임
    delay: 0.28,
    duration: 0.42,
    peakGain: 0.14,
    attack: 0.01,
  });
}

// --- Sprint 22: 함대 소집 종 · 시냇가 낚시 프로시저럴 SFX 4종 ---

/** 중앙 광장 함대 소집 종(Parade Bell) 울림: 맑고 울림 있는 청동 종 기본음 + 배음 2개 감쇠. */
export function playParadeBell(): void {
  const eng = getAudioEngine();
  if (!eng) return;

  // 타종 망치 어택
  scheduleTone(eng.ctx, eng.out, {
    type: "triangle",
    freqStart: 2450,
    freqEnd: 1180,
    duration: 0.032,
    peakGain: 0.28,
    attack: 0.002,
  });
  // 청동 종 기본음 (F#5 ≈ 740Hz) + 비정수 배음 2개 (1486Hz, 2218Hz) + 2차 여운 타종
  const strike = (delay: number, gainScale: number) => {
    scheduleTone(eng.ctx, eng.out, {
      type: "sine",
      freqStart: 739.99,
      duration: 1.35,
      delay,
      peakGain: 0.36 * gainScale,
      attack: 0.004,
    });
    scheduleTone(eng.ctx, eng.out, {
      type: "sine",
      freqStart: 1486.0,
      duration: 0.92,
      delay: delay + 0.002,
      peakGain: 0.19 * gainScale,
      attack: 0.004,
    });
    scheduleTone(eng.ctx, eng.out, {
      type: "triangle",
      freqStart: 2218.0,
      duration: 0.58,
      delay: delay + 0.004,
      peakGain: 0.10 * gainScale,
      attack: 0.003,
    });
  };
  strike(0.0, 1.0);
  strike(0.36, 0.72);
}

/** 시냇가 낚시 캐스팅: 경쾌한 낚싯대 휘두름 + 수면 풍덩 물방울 소리. */
export function playFishingCast(): void {
  const eng = getAudioEngine();
  if (!eng) return;

  // 낚싯대 휙 스윙
  scheduleFilteredNoise(eng.ctx, eng.out, {
    duration: 0.16,
    centerFreq: 1650,
    q: 1.8,
    peakGain: 0.24,
    attack: 0.025,
  });
  // 수면 찌 풍덩 (0.20s 후)
  scheduleTone(eng.ctx, eng.out, {
    type: "sine",
    freqStart: 410,
    freqEnd: 245,
    delay: 0.19,
    duration: 0.085,
    peakGain: 0.28,
    attack: 0.006,
  });
  scheduleTone(eng.ctx, eng.out, {
    type: "sine",
    freqStart: 280,
    freqEnd: 590,
    delay: 0.255,
    duration: 0.11,
    peakGain: 0.22,
    attack: 0.006,
  });
  scheduleFilteredNoise(eng.ctx, eng.out, {
    delay: 0.20,
    duration: 0.095,
    centerFreq: 1250,
    q: 1.4,
    peakGain: 0.18,
    attack: 0.008,
  });
}

/** 시냇가 낚시 입질: 톡톡 물보라 + 맑은 입질 알림 딩동. */
export function playFishingBite(): void {
  const eng = getAudioEngine();
  if (!eng) return;

  // 찌가 수면을 톡톡 두드리는 물보라
  scheduleFilteredNoise(eng.ctx, eng.out, {
    duration: 0.055,
    centerFreq: 1550,
    q: 1.6,
    peakGain: 0.24,
    attack: 0.004,
  });
  scheduleFilteredNoise(eng.ctx, eng.out, {
    delay: 0.09,
    duration: 0.065,
    centerFreq: 1850,
    q: 1.8,
    peakGain: 0.22,
    attack: 0.004,
  });
  // 즉각 반응 유도 2음 딩동 (A5 -> D6)
  scheduleTone(eng.ctx, eng.out, {
    type: "triangle",
    freqStart: 880.0,
    duration: 0.16,
    delay: 0.02,
    peakGain: 0.34,
    attack: 0.005,
  });
  scheduleTone(eng.ctx, eng.out, {
    type: "sine",
    freqStart: 1174.66,
    duration: 0.24,
    delay: 0.105,
    peakGain: 0.36,
    attack: 0.005,
  });
}

/** 시냇가 낚시 성공 시 희귀도별 상승 화음 팡파르 (`common` / `rare` / `legendary`). */
export function playFishingCatch(rarity: "common" | "rare" | "legendary"): void {
  const eng = getAudioEngine();
  if (!eng) return;

  if (rarity === "legendary") {
    const notes = [523.25, 659.25, 783.99, 987.77, 1046.5, 1567.98] as const;
    for (let i = 0; i < notes.length; i += 1) {
      const isLast = i === notes.length - 1;
      scheduleTone(eng.ctx, eng.out, {
        type: i % 2 === 0 ? "triangle" : "sine",
        freqStart: notes[i]!,
        delay: i * 0.062,
        duration: isLast ? 0.56 : 0.24,
        peakGain: isLast ? 0.36 : 0.28,
        attack: 0.006,
      });
    }
    scheduleTone(eng.ctx, eng.out, {
      type: "sine",
      freqStart: 2093.0,
      delay: 0.32,
      duration: 0.48,
      peakGain: 0.16,
      attack: 0.01,
    });
    return;
  }

  if (rarity === "rare") {
    const notes = [587.33, 739.99, 880.0, 1174.66] as const; // D5 -> F#5 -> A5 -> D6
    for (let i = 0; i < notes.length; i += 1) {
      const isLast = i === notes.length - 1;
      scheduleTone(eng.ctx, eng.out, {
        type: i % 2 === 0 ? "sine" : "triangle",
        freqStart: notes[i]!,
        delay: i * 0.068,
        duration: isLast ? 0.42 : 0.20,
        peakGain: isLast ? 0.34 : 0.26,
        attack: 0.006,
      });
    }
    return;
  }

  // common: 경쾌한 3음 상승 화음 (C5 -> E5 -> G5)
  const notes = [523.25, 659.25, 783.99] as const;
  for (let i = 0; i < notes.length; i += 1) {
    scheduleTone(eng.ctx, eng.out, {
      type: "triangle",
      freqStart: notes[i]!,
      delay: i * 0.065,
      duration: i === 2 ? 0.32 : 0.18,
      peakGain: 0.28,
      attack: 0.006,
    });
  }
}
