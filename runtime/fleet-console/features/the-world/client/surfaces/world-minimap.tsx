import type { ConsoleLocale } from "@fleet-console/i18n";
import { memo, useMemo, useState, type MouseEvent, type RefObject } from "react";

import type { WorldVillageSpec, WorldZoneSpec } from "../../shared/world-types.js";
import { getWorldT } from "../i18n/index.js";
import { WorldIcon } from "./world-icons.js";

export const MINIMAP_VIEW_SIZE = 164;
export const MINIMAP_CENTER = MINIMAP_VIEW_SIZE / 2;
export const MINIMAP_RADIUS = 74;
export const MINIMAP_WORLD_RADIUS = 56;

type MinimapVillageRecord = WorldVillageSpec & {
  readonly workStep?: string | null | undefined;
  readonly needsAttention?: boolean | undefined;
  readonly hasError?: boolean | undefined;
  readonly routineCount?: number | undefined;
  readonly completedObjectiveCount?: number | undefined;
};

export interface WorldMinimapProps {
  readonly villages: readonly WorldVillageSpec[];
  readonly zones: readonly WorldZoneSpec[];
  readonly selectedDistrictId: string | null;
  readonly overviewMode: boolean;
  readonly locale: ConsoleLocale | undefined;
  readonly playerMarkerRef?: RefObject<SVGGElement | null> | undefined;
  readonly onSelectVillage: (village: WorldVillageSpec) => void;
  readonly onSelectPlaza: () => void;
  readonly onToggleOverview: () => void;
  readonly onClickPoint?: ((x: number, z: number) => void) | undefined;
}

/** 월드 좌표 `(x, z)` → 미니맵 SVG 좌표 `(mx, my)` 변환 (반경 56m 원형 클램프). */
export function worldToMinimapCoords(x: number, z: number): { readonly mx: number; readonly my: number } {
  const dist = Math.hypot(x, z);
  const clampedScale = dist > MINIMAP_WORLD_RADIUS && dist > 0.001 ? MINIMAP_WORLD_RADIUS / dist : 1;
  const cx = x * clampedScale;
  const cz = z * clampedScale;
  const scale = MINIMAP_RADIUS / MINIMAP_WORLD_RADIUS;
  return {
    mx: MINIMAP_CENTER + cx * scale,
    my: MINIMAP_CENTER + cz * scale,
  };
}

/**
 * 0Hz Direct-DOM 갱신용 플레이어 마커 SVG `transform` 문자열 생성.
 *
 * Three.js `player.yaw = atan2(vx, vz)` 기준:
 * - `yaw = 0` (`+Z` 남쪽 = SVG `+Y` 아래) → `rotate(0)`
 * - `yaw = +π/2` (`+X` 동쪽 = SVG `+X` 오른쪽) → `rotate(-90)`
 * - `yaw = π` (`-Z` 북쪽 = SVG `-Y` 위) → `rotate(-180)`
 */
export function formatMinimapPlayerTransform(x: number, z: number, yaw: number): string {
  const { mx, my } = worldToMinimapCoords(x, z);
  const deg = (-yaw * 180) / Math.PI;
  return `translate(${mx.toFixed(1)} ${my.toFixed(1)}) rotate(${deg.toFixed(1)})`;
}

/** `meadow-scene.ts` / `world-projection.ts`와 동일한 시냇물 곡선 SVG path 생성 (1회 계산). */
function buildBrookSvgPath(): string {
  const pts: string[] = [];
  for (let x = -50; x <= 50; x += 4) {
    const z = 9.2 + Math.sin(x * 0.095) * 2.9 + Math.cos(x * 0.04) * 1.1;
    const { mx, my } = worldToMinimapCoords(x, z);
    pts.push(`${pts.length === 0 ? "M" : "L"} ${mx.toFixed(1)} ${my.toFixed(1)}`);
  }
  return pts.join(" ");
}

const BROOK_SVG_PATH = buildBrookSvgPath();
const PLAZA_COORDS = worldToMinimapCoords(0, -1.5);
const EAST_BRIDGE_COORDS = worldToMinimapCoords(8.6, 9.2 + Math.sin(8.6 * 0.095) * 2.9 + Math.cos(8.6 * 0.04) * 1.1);
const WEST_BRIDGE_COORDS = worldToMinimapCoords(-11.5, 9.2 + Math.sin(-11.5 * 0.095) * 2.9 + Math.cos(-11.5 * 0.04) * 1.1);

/**
 * 다크 크리스탈 RTS 전략 미니맵 (`React.memo`).
 *
 * - 전체 56m 초원의 중앙 광장 · 시냇물 · 사령관 마을(발전도 Tier · 작업 펄스 · 경보 핑)을 한눈에 표시한다.
 * - 플레이어 위치/방향 화살표는 `playerMarkerRef`를 통해 Direct-DOM 갱신되어 React 리렌더가 0Hz로 유지된다.
 * - `M` 하늘 조망 토글 버튼 및 마을/지점 클릭 즉시 이동을 지원한다.
 */
export const WorldMinimap = memo(function WorldMinimap({
  villages,
  zones,
  selectedDistrictId,
  overviewMode,
  locale,
  playerMarkerRef,
  onSelectVillage,
  onSelectPlaza,
  onToggleOverview,
  onClickPoint,
}: WorldMinimapProps) {
  const t = getWorldT(locale);
  const [collapsed, setCollapsed] = useState(false);

  const typedVillages = villages as readonly MinimapVillageRecord[];

  const selectedVillageId = useMemo(() => {
    if (!selectedDistrictId) return null;
    for (const v of villages) {
      if (v.districts.some((d) => d.id === selectedDistrictId)) return v.id;
    }
    return null;
  }, [selectedDistrictId, villages]);

  const outposts = useMemo(
    () => zones.filter((z) => z.kind === "outpost"),
    [zones],
  );

  const workingCount = useMemo(
    () => typedVillages.filter((v) => Boolean(v.workStep)).length,
    [typedVillages],
  );
  const attentionCount = useMemo(
    () => typedVillages.filter((v) => v.needsAttention || v.hasError).length,
    [typedVillages],
  );

  const handleCanvasClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!onClickPoint) return;
    if ((event.target as HTMLElement).closest("button")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const nx = ((event.clientX - rect.left) / rect.width) * MINIMAP_VIEW_SIZE - MINIMAP_CENTER;
    const ny = ((event.clientY - rect.top) / rect.height) * MINIMAP_VIEW_SIZE - MINIMAP_CENTER;
    const scale = MINIMAP_WORLD_RADIUS / MINIMAP_RADIUS;
    const wx = nx * scale;
    const wz = ny * scale;
    if (Math.hypot(wx, wz) > MINIMAP_WORLD_RADIUS) return;
    onClickPoint(wx, wz);
  };

  if (collapsed) {
    return (
      <div
        className="the-world-minimap-collapsed"
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className={`the-world-btn${overviewMode ? " is-active" : ""}`}
          aria-label={t("theWorld.minimap.collapseAria")}
          onClick={() => setCollapsed(false)}
        >
          <WorldIcon name="mapOverview" size={14} tone={overviewMode ? "amber" : "cerulean"} />
          <span>{t("theWorld.minimap.title")}</span>
          {attentionCount > 0 ? <span className="the-world-minimap-badge is-alert">{attentionCount}</span> : null}
        </button>
      </div>
    );
  }

  return (
    <section
      className={`the-world-minimap${overviewMode ? " is-overview" : ""}`}
      aria-label={t("theWorld.minimap.aria")}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="the-world-crest" aria-hidden="true" />

      <header className="the-world-minimap-head">
        <span className="the-world-minimap-title">
          <WorldIcon name="mapOverview" size={13} tone={overviewMode ? "amber" : "cerulean"} />
          <span>{t("theWorld.minimap.title")}</span>
        </span>
        <div className="the-world-minimap-tools">
          <button
            type="button"
            className={`the-world-minimap-keybtn${overviewMode ? " is-active" : ""}`}
            aria-label={t("theWorld.minimap.expandAria")}
            aria-pressed={overviewMode}
            title={t("theWorld.hud.overviewTitle")}
            onClick={onToggleOverview}
          >
            M
          </button>
          <button
            type="button"
            className="the-world-chat-icon-btn"
            aria-label={t("theWorld.minimap.collapseAria")}
            onClick={() => setCollapsed(true)}
          >
            <WorldIcon name="close" size={12} />
          </button>
        </div>
      </header>

      <div className="the-world-minimap-stage" onClick={handleCanvasClick}>
        <svg
          className="the-world-minimap-svg"
          viewBox={`0 0 ${MINIMAP_VIEW_SIZE} ${MINIMAP_VIEW_SIZE}`}
          aria-hidden="true"
        >
          {/* 초원 외곽 경계 (56m) 및 거리 동심원 */}
          <circle
            className="the-world-minimap-meadow"
            cx={MINIMAP_CENTER}
            cy={MINIMAP_CENTER}
            r={MINIMAP_RADIUS}
          />
          <circle
            className="the-world-minimap-ring"
            cx={MINIMAP_CENTER}
            cy={MINIMAP_CENTER}
            r={MINIMAP_RADIUS * (24 / MINIMAP_WORLD_RADIUS)}
          />
          <circle
            className="the-world-minimap-ring"
            cx={MINIMAP_CENTER}
            cy={MINIMAP_CENTER}
            r={MINIMAP_RADIUS * (42 / MINIMAP_WORLD_RADIUS)}
          />

          {/* 시냇물 & 목교 */}
          <path className="the-world-minimap-brook" d={BROOK_SVG_PATH} />
          <rect
            className="the-world-minimap-bridge"
            x={EAST_BRIDGE_COORDS.mx - 2.5}
            y={EAST_BRIDGE_COORDS.my - 4}
            width={5}
            height={8}
            rx={1.2}
          />
          <rect
            className="the-world-minimap-bridge"
            x={WEST_BRIDGE_COORDS.mx - 2.5}
            y={WEST_BRIDGE_COORDS.my - 4}
            width={5}
            height={8}
            rx={1.2}
          />

          {/* 아웃포스트 캠프 다이아몬드 마커 */}
          {outposts.map((op) => {
            const { mx, my } = worldToMinimapCoords(op.x, op.z);
            return (
              <polygon
                key={op.id}
                className="the-world-minimap-outpost"
                points={`${mx},${my - 3.5} ${mx + 3.5},${my} ${mx},${my + 3.5} ${mx - 3.5},${my}`}
              />
            );
          })}

          {/* 제독(플레이어) 실시간 위치 & 시선 화살표 — Direct-DOM transform 갱신 */}
          <g
            ref={playerMarkerRef}
            className="the-world-minimap-player"
            transform={formatMinimapPlayerTransform(0.4, 2.2, Math.PI)}
          >
            <polygon className="the-world-minimap-player-cone" points="0,0 -6,12 6,12" />
            <polygon className="the-world-minimap-player-arrow" points="0,5.6 -3.8,-3.6 0,-1.6 3.8,-3.6" />
          </g>
        </svg>

        <span className="the-world-minimap-north" aria-hidden="true">N</span>

        {/* 중앙 길드 광장 클릭 노드 */}
        <button
          type="button"
          className="the-world-minimap-plaza"
          style={{
            left: `${(PLAZA_COORDS.mx / MINIMAP_VIEW_SIZE) * 100}%`,
            top: `${(PLAZA_COORDS.my / MINIMAP_VIEW_SIZE) * 100}%`,
          }}
          aria-label={t("theWorld.minimap.plazaAria")}
          title={t("theWorld.minimap.plazaAria")}
          onClick={onSelectPlaza}
        />

        {/* 사령관별 마을 클릭 노드 */}
        {typedVillages.map((village) => {
          const { mx, my } = worldToMinimapCoords(village.x, village.z);
          const isSelected = selectedVillageId === village.id;
          const isWorking = Boolean(village.workStep);
          const isAttention = village.needsAttention === true;
          const isError = village.hasError === true;
          const sizePx = Math.max(16, Math.min(24, Math.round(14 + village.overallTier * 1.8)));
          return (
            <button
              key={village.id}
              type="button"
              className={`the-world-minimap-node${isSelected ? " is-selected" : ""}${isWorking ? " is-working" : ""}${isAttention ? " is-attention" : ""}${isError ? " is-error" : ""}`}
              data-tone={village.tone}
              style={{
                left: `${(mx / MINIMAP_VIEW_SIZE) * 100}%`,
                top: `${(my / MINIMAP_VIEW_SIZE) * 100}%`,
                width: `${sizePx}px`,
                height: `${sizePx}px`,
              }}
              aria-label={t("theWorld.minimap.villageAria", {
                name: village.label,
                tier: village.overallTier,
              })}
              title={`${village.label} · Tier ${village.overallTier}`}
              onClick={() => onSelectVillage(village)}
            >
              <span className="the-world-minimap-node-tier">{village.overallTier}</span>
              {isAttention || isError ? (
                <span className="the-world-minimap-node-ping" aria-hidden="true">!</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <footer className="the-world-minimap-foot">
        <span className="the-world-minimap-hint">{t("theWorld.minimap.overviewHint")}</span>
        <div className="the-world-minimap-counts">
          {workingCount > 0 ? (
            <span className="the-world-minimap-stat is-working">
              <span className="the-world-minimap-stat-dot" aria-hidden="true" />
              <span>{t("theWorld.minimap.workingLegend")} {workingCount}</span>
            </span>
          ) : null}
          {attentionCount > 0 ? (
            <span className="the-world-minimap-stat is-alert">
              <span className="the-world-minimap-stat-dot" aria-hidden="true" />
              <span>{t("theWorld.minimap.alertLegend")} {attentionCount}</span>
            </span>
          ) : null}
        </div>
      </footer>
    </section>
  );
});
