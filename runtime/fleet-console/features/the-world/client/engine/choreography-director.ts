import {
  BoxGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  Scene,
  SphereGeometry,
  Vector3,
} from "three";

import { PLUSH_VIVID_TONES } from "../../../workspace/shared/mongle-3d-glsl.js";
import type { WorldActorEmote, WorldActorSpec, WorldChoreographyCommand } from "../../shared/world-types.js";

/**
 * 사령관 · 지휘관 · 구성원 자율 생활 생태계 및 합동 연출 디렉터.
 *
 * - 건물·연못·우물·모닥불 슬라이딩 충돌 회피(`resolveMovement`) + 캐릭터 간 자연스러운 거리 유지(소프트 분리)
 * - 야간 모닥불 집결(광장 모닥불 2.8, 1.0 둘레 반원 착석), 플레이어 근접 시선 마주치기
 * - 목표 하달 · 전령 보고 하이파이브 · 선후행 바통 터치 · 완수 축포 연출
 */

export interface LiveActorMotion {
  spec: WorldActorSpec;
  x: number;
  z: number;
  tx: number;
  tz: number;
  yaw: number;
  moving: boolean;
  carrying: boolean;
  hopBoost: number;
  speech: string;
  speechTimer: number;
}

interface FlyingProjectile {
  sx: number;
  sz: number;
  tx: number;
  tz: number;
  t: number;
  speed: number;
  mesh: Mesh;
  onArrive?: (() => void) | undefined;
}

interface BurstParticle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  mesh: Mesh;
}

export interface ChoreographyDirector {
  readonly motions: Map<string, LiveActorMotion>;
  celebratingTimer: number;
  syncActors(specs: readonly WorldActorSpec[]): void;
  applySpeech(actorId: string, text: string): void;
  playEmote(actorId: string, emote: WorldActorEmote, playerPos: Vector3): void;
  handleCommand(cmd: WorldChoreographyCommand): boolean;
  spawnBurst(x: number, y: number, z: number, colorHex: number, count?: number): void;
  spawnDust(x: number, y: number, z: number): void;
  update(
    dt: number,
    elapsed: number,
    nightFactor: number,
    playerPos: Vector3,
    focusedActorId: string | null,
    isWalkable: (x: number, z: number) => boolean,
    resolveMovement: (curX: number, curZ: number, nextX: number, nextZ: number, radius?: number) => { x: number; z: number },
  ): string | null;
  dispose(): void;
}

export function createChoreographyDirector(scene: Scene): ChoreographyDirector {
  const fxGroup = new Group();
  scene.add(fxGroup);

  const motions = new Map<string, LiveActorMotion>();
  const projectiles: FlyingProjectile[] = [];
  const particles: BurstParticle[] = [];
  const pendingTimers = new Set<number>();

  const projGeo = new BoxGeometry(0.36, 0.14, 0.52);
  const partGeo = new SphereGeometry(0.11, 8, 6);

  function scheduleTimeout(fn: () => void, ms: number) {
    const id = window.setTimeout(() => {
      pendingTimers.delete(id);
      fn();
    }, ms);
    pendingTimers.add(id);
  }

  function spawnBurst(x: number, y: number, z: number, colorHex: number, count = 18) {
    for (let i = 0; i < count; i += 1) {
      const ang = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const spd = 2.0 + Math.random() * 3.2;
      const col = i % 3 === 0 ? 0xfde047 : i % 3 === 1 ? colorHex : 0x7dd3fc;
      const mat = new MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 1.25, roughness: 0.3 });
      const mesh = new Mesh(partGeo, mat);
      mesh.position.set(x, y, z);
      const s = 0.75 + Math.random() * 0.65;
      mesh.scale.setScalar(s);
      fxGroup.add(mesh);
      particles.push({
        x,
        y,
        z,
        vx: Math.cos(ang) * spd,
        vy: 3.1 + Math.random() * 3.2,
        vz: Math.sin(ang) * spd,
        life: 1.05,
        mesh,
      });
    }
  }

  function spawnDust(x: number, y: number, z: number) {
    const mat = new MeshStandardMaterial({ color: 0xf8fafc, emissive: 0xe2e8f0, emissiveIntensity: 0.22, roughness: 0.92 });
    const mesh = new Mesh(partGeo, mat);
    mesh.position.set(x, y, z);
    mesh.scale.setScalar(0.8);
    fxGroup.add(mesh);
    particles.push({
      x,
      y,
      z,
      vx: (Math.random() - 0.5) * 0.6,
      vy: 0.5 + Math.random() * 0.35,
      vz: (Math.random() - 0.5) * 0.6,
      life: 0.40,
      mesh,
    });
  }

  function launchProjectile(
    sx: number,
    sz: number,
    tx: number,
    tz: number,
    colorHex: number,
    speed: number,
    onArrive?: () => void,
  ) {
    const mat = new MeshStandardMaterial({ color: colorHex, emissive: colorHex, emissiveIntensity: 1.15, roughness: 0.3 });
    const mesh = new Mesh(projGeo, mat);
    mesh.position.set(sx, 1.35, sz);
    fxGroup.add(mesh);
    projectiles.push({ sx, sz, tx, tz, t: 0, speed, mesh, onArrive });
  }

  let lastCommandNonce = 0;

  const director: ChoreographyDirector = {
    motions,
    celebratingTimer: 0,
    syncActors(specs) {
      const nextIds = new Set(specs.map((s) => s.id));
      for (const id of [...motions.keys()]) {
        if (!nextIds.has(id)) motions.delete(id);
      }
      for (const spec of specs) {
        const existing = motions.get(spec.id);
        if (existing) {
          existing.spec = spec;
        } else {
          motions.set(spec.id, {
            spec,
            x: spec.homeX,
            z: spec.homeZ,
            tx: spec.homeX,
            tz: spec.homeZ,
            yaw: 0.15,
            moving: false,
            carrying: false,
            hopBoost: 0.8,
            speech: spec.initialSpeech ?? "",
            speechTimer: spec.initialSpeech ? (spec.needsAttention ? 999 : 5.5) : 0,
          });
        }
      }
    },
    applySpeech(actorId, text) {
      const m = motions.get(actorId);
      if (!m) return;
      m.speech = text;
      m.speechTimer = 4.2;
      m.hopBoost = 1.35;
    },
    playEmote(actorId, emote, playerPos) {
      const m = motions.get(actorId);
      if (!m) return;
      m.tx = m.x;
      m.tz = m.z;
      m.yaw = Math.atan2(playerPos.x - m.x, playerPos.z - m.z);
      if (emote === "greet") {
        m.hopBoost = 1.45;
        m.speech = m.spec.role === "commodore"
          ? "반가워요 제독님! 오늘 작전은 무엇인가요? ✦"
          : m.spec.role === "commander"
            ? "충성! 작전 구역 이상 없습니다! 📡"
            : "안녕하세요! 맡은 임무 진행 중이에요! ✨";
        m.speechTimer = 3.8;
        spawnBurst(m.x, 1.55, m.z, 0x38bdf8, 16);
      } else if (emote === "cheer") {
        m.hopBoost = 1.8;
        m.speech = "힘이 불끈 나네요! 맡겨만 주세요! 🔥";
        m.speechTimer = 3.8;
        spawnBurst(m.x, 1.65, m.z, 0xfbbf24, 22);
      } else {
        m.hopBoost = 1.75;
        m.speech = "점프 하이파이브! 🙌 최고의 호흡이에요!";
        m.speechTimer = 3.8;
        spawnBurst((m.x + playerPos.x) * 0.5, 1.6, (m.z + playerPos.z) * 0.5, 0xe879f9, 22);
      }
    },
    spawnBurst,
    spawnDust,
    handleCommand(cmd) {
      if (cmd.nonce === lastCommandNonce) return false;
      lastCommandNonce = cmd.nonce;

      const all = [...motions.values()];
      const commodore = all.find((m) => m.spec.role === "commodore");
      // 구성원이 있는 캠프 지휘관을 우선 선택해 협동 연출이 풍부하게 보이도록 함
      const commander = all.find(
        (m) => m.spec.role === "commander"
          && (!cmd.outpostId || m.spec.zoneId === cmd.outpostId)
          && all.some((sub) => sub.spec.role === "member" && sub.spec.zoneId === m.spec.zoneId),
      ) ?? all.find((m) => m.spec.role === "commander" && (!cmd.outpostId || m.spec.zoneId === cmd.outpostId))
        ?? all.find((m) => m.spec.role === "commander");
      const campMembers = commander
        ? all.filter((m) => m.spec.role === "member" && m.spec.zoneId === commander.spec.zoneId)
        : [];

      if (cmd.kind === "delegate" && commodore && commander) {
        commodore.hopBoost = 1.4;
        commodore.speech = "📜 새 작전 청사진 발송!";
        commodore.speechTimer = 3.5;

        launchProjectile(commodore.x, commodore.z, commander.x, commander.z, 0xfbbf24, 1.05, () => {
          commander.hopBoost = 1.45;
          commander.speech = "전원 브리핑 테이블 앞 집결! 📣";
          commander.speechTimer = 3.6;
          spawnBurst(commander.x, 1.5, commander.z, 0xf59e0b, 16);

          campMembers.forEach((mem, idx) => {
            const ang = idx * 0.85 - 0.8;
            mem.tx = commander.spec.homeX + Math.cos(ang) * 1.95;
            mem.tz = commander.spec.homeZ + 0.8 + Math.sin(ang) * 1.45;
            mem.speech = "집결 완료! ✦";
            mem.speechTimer = 2.4;
          });

          scheduleTimeout(() => {
            campMembers.forEach((mem) => {
              const rgb = PLUSH_VIVID_TONES[mem.spec.tone];
              const hex = new Color(rgb[0], rgb[1], rgb[2]).getHex();
              launchProjectile(commander.x, commander.z, mem.spec.homeX, mem.spec.homeZ, hex, 1.5);
              mem.tx = mem.spec.homeX;
              mem.tz = mem.spec.homeZ;
              mem.hopBoost = 1.15;
            });
          }, 1_600);
        });
        return true;
      } else if (cmd.kind === "report" && commander) {
        const runner = campMembers[0] ?? all.find((m) => m.spec.id !== commander.spec.id);
        if (!runner) return false;
        runner.carrying = true;
        runner.speech = "🎁 결과물 보고 갑니다!";
        runner.speechTimer = 3.5;
        runner.tx = commander.x - 1.1;
        runner.tz = commander.z + 0.45;

        scheduleTimeout(() => {
          runner.carrying = false;
          runner.hopBoost = 1.65;
          commander.hopBoost = 1.65;
          runner.speech = "점프 하이파이브! 🙌";
          commander.speech = `수고했어 ${runner.spec.name}! ♥`;
          runner.speechTimer = 3.0;
          commander.speechTimer = 3.0;
          spawnBurst((commander.x + runner.x) * 0.5, 1.6, (commander.z + runner.z) * 0.5, 0xe879f9, 24);
          scheduleTimeout(() => {
            runner.tx = runner.spec.homeX;
            runner.tz = runner.spec.homeZ;
          }, 1_400);
        }, 1_650);
        return true;
      } else if (cmd.kind === "handoff") {
        const pair = campMembers.length >= 2 ? campMembers : all.slice(0, 2);
        if (pair.length < 2) return false;
        const m1 = pair[0]!;
        const m2 = pair[1]!;
        const midX = (m1.spec.homeX + m2.spec.homeX) * 0.5;
        const midZ = (m1.spec.homeZ + m2.spec.homeZ) * 0.5;
        m1.carrying = true;
        m1.speech = "🔑 커밋 바통 전달!";
        m1.speechTimer = 3.0;
        m1.tx = midX - 0.65;
        m1.tz = midZ;
        m2.tx = midX + 0.65;
        m2.tz = midZ;

        scheduleTimeout(() => {
          m1.carrying = false;
          m1.hopBoost = 1.45;
          m2.hopBoost = 1.45;
          m2.speech = "바통 인수! 검증 시작! ⚙️";
          m2.speechTimer = 3.2;
          spawnBurst(midX, 1.45, midZ, 0x38bdf8, 22);
          scheduleTimeout(() => {
            m1.tx = m1.spec.homeX;
            m1.tz = m1.spec.homeZ;
            m2.tx = m2.spec.homeX;
            m2.tz = m2.spec.homeZ;
          }, 1_350);
        }, 1_450);
        return true;
      } else if (cmd.kind === "celebrate") {
        if (all.length === 0) return false;
        director.celebratingTimer = 4.0;
        for (const m of all) {
          m.hopBoost = 1.7;
          m.speech = m.spec.role === "commodore" ? "초원 전 함대 목표 완수! 🎉" : "만세!! 성공이다! ✨";
          m.speechTimer = 3.8;
        }
        spawnBurst(0, 2.4, -1.5, 0x74cc6e, 28);
        if (commander) spawnBurst(commander.x, 2.3, commander.z, 0xf59e0b, 26);
        return true;
      }
      return false;
    },
    update(dt, elapsed, nightFactor, playerPos, focusedActorId, isWalkable, resolveMovement) {
      if (director.celebratingTimer > 0) {
        director.celebratingTimer = Math.max(0, director.celebratingTimer - dt);
      }

      const isNight = nightFactor > 0.72;
      let nearestId: string | null = null;
      let nearestDist = 4.6;

      const motionList = [...motions.values()];
      motionList.forEach((m, idx) => {
        if (m.speechTimer > 0 && m.speechTimer < 900) {
          m.speechTimer = Math.max(0, m.speechTimer - dt);
          if (m.speechTimer === 0) m.speech = "";
        }
        m.hopBoost = Math.max(0, m.hopBoost - dt * 1.9);

        const distToPlayer = Math.hypot(m.x - playerPos.x, m.z - playerPos.z);
        if (distToPlayer < nearestDist) {
          nearestDist = distToPlayer;
          nearestId = m.spec.id;
        }

        const isFocused = m.spec.id === focusedActorId;
        // 상호작용 중인 대상은 제자리에 멈춰 서서 제독을 바라본다
        if (isFocused) {
          m.tx = m.x;
          m.tz = m.z;
        } else if (m.spec.state === "idle" && isNight && Math.hypot(m.spec.homeX - 2.8, m.spec.homeZ - 1.0) < 22) {
          // 밤이 되면 광장 인근의 유휴(idle) 에이전트들이 모닥불(2.8, 1.0) 둘레에 여유 있는 간격으로 둘러앉음
          const seatAngle = idx * 0.95 + 0.4;
          m.tx = 2.8 + Math.cos(seatAngle) * 2.15;
          m.tz = 1.0 + Math.sin(seatAngle) * 2.15;
        } else if (m.spec.state === "idle" && !isNight && Math.hypot(m.tx - m.spec.homeX, m.tz - m.spec.homeZ) > 3.0) {
          m.tx = m.spec.homeX;
          m.tz = m.spec.homeZ;
        } else if (!m.carrying && Math.hypot(m.tx - m.x, m.tz - m.z) < 0.14 && Math.random() < dt * 0.36) {
          const wander = m.spec.role === "member" ? 0.85 : 1.35;
          const cx = m.spec.homeX + (Math.random() - 0.5) * wander * 2;
          const cz = m.spec.homeZ + (Math.random() - 0.5) * wander * 2;
          if (isWalkable(cx, cz)) {
            m.tx = cx;
            m.tz = cz;
          }
        }

        const dx = m.tx - m.x;
        const dz = m.tz - m.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.08) {
          const step = Math.min(dist, (m.carrying ? 4.8 : 2.65) * dt);
          const nx = m.x + (dx / dist) * step;
          const nz = m.z + (dz / dist) * step;
          const resolved = resolveMovement(m.x, m.z, nx, nz, 0.46);
          m.x = resolved.x;
          m.z = resolved.z;
          m.yaw = Math.atan2(dx, dz);
          m.moving = true;
        } else {
          m.moving = false;
          // 상호작용 중이거나 가까이 오면 플레이어를, 평상시에는 남쪽(+Z)을 자연스럽게 바라봄
          const desiredYaw = isFocused || distToPlayer < 4.5 ? Math.atan2(playerPos.x - m.x, playerPos.z - m.z) : 0.15;
          let df = desiredYaw - m.yaw;
          while (df > Math.PI) df -= Math.PI * 2;
          while (df < -Math.PI) df += Math.PI * 2;
          m.yaw += df * Math.min(1, dt * (isFocused ? 9.0 : 5.5));
        }
      });

      // 캐릭터 상호 겹침 방지 소프트 분리 (서로 몸통이 파고들지 않게 밀어냄)
      for (let i = 0; i < motionList.length; i += 1) {
        const a = motionList[i]!;
        for (let j = i + 1; j < motionList.length; j += 1) {
          const b = motionList[j]!;
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const d = Math.hypot(dx, dz);
          const minSep = 1.28;
          if (d > 0.001 && d < minSep) {
            const push = (minSep - d) * 0.5 * Math.min(1, dt * 10);
            const px = (dx / d) * push;
            const pz = (dz / d) * push;
            const ra = resolveMovement(a.x, a.z, a.x - px, a.z - pz, 0.44);
            const rb = resolveMovement(b.x, b.z, b.x + px, b.z + pz, 0.44);
            a.x = ra.x;
            a.z = ra.z;
            b.x = rb.x;
            b.z = rb.z;
          }
        }
      }

      // 모닥불 불티 (광장 모닥불 2.8, 1.0)
      if (Math.random() < dt * 5.5) {
        const mat = new MeshStandardMaterial({ color: 0xfb923c, emissive: 0xf97316, emissiveIntensity: 1.5 });
        const mesh = new Mesh(partGeo, mat);
        const fx = 2.8 + (Math.random() - 0.5) * 0.32;
        const fz = 1.0 + (Math.random() - 0.5) * 0.32;
        mesh.position.set(fx, 0.72, fz);
        mesh.scale.setScalar(0.62);
        fxGroup.add(mesh);
        particles.push({
          x: fx,
          y: 0.72,
          z: fz,
          vx: (Math.random() - 0.5) * 0.4,
          vy: 1.35 + Math.random() * 0.7,
          vz: (Math.random() - 0.5) * 0.4,
          life: 0.85,
          mesh,
        });
      }

      // 비행 투사체 갱신
      for (let i = projectiles.length - 1; i >= 0; i -= 1) {
        const pr = projectiles[i]!;
        pr.t += dt * pr.speed;
        const x = pr.sx + (pr.tx - pr.sx) * pr.t;
        const z = pr.sz + (pr.tz - pr.sz) * pr.t;
        const y = 1.45 + Math.sin(pr.t * Math.PI) * 3.5;
        pr.mesh.position.set(x, y, z);
        pr.mesh.rotation.y = Math.atan2(pr.tx - pr.sx, pr.tz - pr.sz);
        pr.mesh.rotation.z = elapsed * 5.0;
        if (pr.t >= 1) {
          fxGroup.remove(pr.mesh);
          (pr.mesh.material as MeshStandardMaterial).dispose();
          pr.onArrive?.();
          projectiles.splice(i, 1);
        }
      }

      // 입자 갱신
      for (let i = particles.length - 1; i >= 0; i -= 1) {
        const pt = particles[i]!;
        pt.x += pt.vx * dt;
        pt.y += pt.vy * dt;
        pt.z += pt.vz * dt;
        pt.vy -= 4.2 * dt;
        pt.life -= dt;
        pt.mesh.position.set(pt.x, pt.y, pt.z);
        if (pt.life <= 0) {
          fxGroup.remove(pt.mesh);
          (pt.mesh.material as MeshStandardMaterial).dispose();
          particles.splice(i, 1);
        }
      }

      return nearestId;
    },
    dispose() {
      for (const id of pendingTimers) window.clearTimeout(id);
      pendingTimers.clear();
      projGeo.dispose();
      partGeo.dispose();
      scene.remove(fxGroup);
    },
  };

  return director;
}
