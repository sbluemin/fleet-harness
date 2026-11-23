import {
  AnimationClip,
  AnimationMixer,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  Euler,
  Group,
  InstancedMesh,
  Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Texture,
  Vector3,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";

import { disposeObjectTree as disposeNonSharedTree, markSharedGeometry, markSharedMaterial } from "./instanced-buckets.js";

/**
 * Blender `.glb` 드롭인 3D 에셋 레지스트리 (인스탠싱 · 지붕 틴팅 · 야간 창문 발광 · 지오메트리 추출).
 *
 * `features/the-world/client/assets/models/<slot>.glb` 경로에 파일을 넣어두면
 * Vite가 빌드/서빙 시 자동으로 URL을 매핑하고, `GLTFLoader`로 1회 로드한 뒤
 * 각 구조물·나무·잔디·구역 건물의 프로시저럴 폴백을 자동으로 대체한다.
 *
 * 머티리얼/노드 규약:
 * - `RoofTint*`: 밝은 중립 베이스 → `roofTintHex` / `colorTintHex`로 런타임 사령관 톤 틴팅
 * - `WindowGlow*`: `setNightFactor(nightFactor)` 호출 시 야간 호박색 발광 자동 동기화
 * - `BladePivot` / `blade_pivot`: 풍차 회전 날개 피벗 노드 자동 탐지
 */

export type WorldModelSlot =
  | "guild-hall"
  | "windmill"
  | "well"
  | "signpost"
  | "bridge"
  | "pavilion"
  | "cottage"
  | "tree-oak"
  | "tree-pine"
  | "tree-blossom"
  | "bush"
  | "bench"
  | "streetlamp"
  | "quest-board"
  | "grass-tuft"
  | "district-tier1"
  | "district-tier2"
  | "district-tier3"
  | "district-tier4"
  | "district-tier5"
  | "village-gate-wood"
  | "village-gate-stone"
  | "village-signpost"
  | "river-rock"
  | "reeds"
  | "lilypad"
  | "flowerbed"
  | "butterfly"
  | "koi-fish"
  | "lantern-arch"
  | "trophy-statue";

export interface WorldModelInstance {
  readonly root: Group;
  readonly anchors: Readonly<Record<string, Vector3>>;
  readonly bladePivot: Object3D | null;
  readonly mixer: AnimationMixer | null;
}

export interface InstancedSlotTransform {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotationY?: number | undefined;
  readonly scale?: number | undefined;
  readonly scaleX?: number | undefined;
  readonly scaleY?: number | undefined;
  readonly scaleZ?: number | undefined;
  /** `RoofTint` 서브메시에 per-instance `setColorAt` 틴팅을 적용할 색상(선택). */
  readonly roofTintHex?: number | undefined;
  /** 레이캐스트 식별용 인스턴스 메타데이터(`districtId`/`theaterId` 등, 선택). */
  readonly userData?: Record<string, unknown> | undefined;
}

export interface MountSlotOptions {
  readonly slot: WorldModelSlot;
  readonly container: Group;
  readonly mountFallback: (parent: Group) => void;
  readonly targetHeight?: number | undefined;
  readonly scale?: number | undefined;
  /** `RoofTint` 머티리얼에 적용할 사령관 톤 색상(선택). */
  readonly roofTintHex?: number | undefined;
  readonly castShadow?: boolean | undefined;
  readonly receiveShadow?: boolean | undefined;
  readonly onMounted?: ((instance: WorldModelInstance) => void) | undefined;
}

export interface MountInstancedSlotOptions {
  readonly slot: WorldModelSlot;
  readonly container: Group;
  readonly transforms: readonly InstancedSlotTransform[];
  readonly mountFallback?: ((parent: Group) => void) | undefined;
  readonly targetHeight?: number | undefined;
  readonly scale?: number | undefined;
  /** 전체 인스턴스 공통 `RoofTint` 색상(개별 `transform.roofTintHex`가 우선). */
  readonly colorTintHex?: number | undefined;
  readonly castShadow?: boolean | undefined;
  readonly receiveShadow?: boolean | undefined;
  readonly onMounted?: ((meshes: readonly InstancedMesh[]) => void) | undefined;
}

export interface LoadSlotGeometryOptions {
  readonly targetHeight?: number | undefined;
  readonly scale?: number | undefined;
}

export interface WorldAssetRegistry {
  hasCustomModel(slot: WorldModelSlot): boolean;
  /**
   * 단일 슬롯에 커스텀 `.glb`가 존재하면 `container` 내부를 자동으로 교체한다.
   * 로드 전에는 `mountFallback()`이 즉시 표시되므로 빈 화면이 생기지 않는다.
   */
  mountSlot(options: MountSlotOptions): void;
  /**
   * 다수 인스턴스(나무·관목·사령관 구역 건물 등)를 GLB 서브메시별 `InstancedMesh`로 배칭해
   * 수십~수백 개 배치에도 Draw Call을 극소화한다.
   */
  mountInstancedSlot(options: MountInstancedSlotOptions): void;
  /**
   * `grass-tuft.glb` 등 단일/다중 서브메시 GLB에서 정규화된 `BufferGeometry`(`aBladeH` 포함)를
   * 추출해 기존 바람 셰이더 `InstancedMesh`에 바로 꽂을 수 있게 반환한다.
   */
  loadSlotGeometry(slot: WorldModelSlot, options?: LoadSlotGeometryOptions): Promise<BufferGeometry | null>;
  /** `loadSlotGeometry` 별칭. */
  loadFirstMeshGeometry(slot: WorldModelSlot, options?: LoadSlotGeometryOptions): Promise<BufferGeometry | null>;
  /** 로드된 모든 GLB의 `WindowGlow` 머티리얼 야간 발광 강도를 동기화한다. */
  setNightFactor(nightFactor: number): void;
  update(dt: number): void;
  clearActiveMixers(): void;
  dispose(): void;
}

const DISCOVERED_URLS = import.meta.glob<string>("../assets/models/*.glb", {
  eager: true,
  query: "?url",
  import: "default",
});

const SLOT_URL_MAP = new Map<WorldModelSlot, string>();
for (const [filepath, url] of Object.entries(DISCOVERED_URLS)) {
  const filename = filepath.split("/").pop() ?? "";
  const stem = filename.replace(/\.glb$/iu, "") as WorldModelSlot;
  if (stem && typeof url === "string") {
    SLOT_URL_MAP.set(stem, url);
  }
}

interface TemplateSubMesh {
  readonly geometry: BufferGeometry;
  readonly material: Material;
  /** 바닥 min.y=0, 수평 중심 (0,0) 정규화 전 템플릿 루트 기준 로컬 행렬. */
  readonly localMatrix: Matrix4;
  readonly isRoofTint: boolean;
}

interface LoadedTemplate {
  readonly scene: Object3D;
  readonly animations: readonly AnimationClip[];
  readonly boundsMinY: number;
  readonly boundsCenterX: number;
  readonly boundsCenterZ: number;
  readonly boundsHeight: number;
  readonly subMeshes: readonly TemplateSubMesh[];
}

function isRoofTintMaterial(mat: Material | null | undefined): mat is MeshStandardMaterial {
  return Boolean(mat instanceof MeshStandardMaterial && mat.name.toLowerCase().includes("rooftint"));
}

function isWindowGlowMaterial(mat: Material | null | undefined): mat is MeshStandardMaterial {
  return Boolean(mat instanceof MeshStandardMaterial && mat.name.toLowerCase().includes("windowglow"));
}

function isBladePivotName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "bladepivot" || lower === "blade_pivot" || lower === "windmill_blades" || lower === "blades";
}

function disposeFullTemplate(obj: Object3D): void {
  const geos = new Set<BufferGeometry>();
  const mats = new Set<Material>();
  const textures = new Set<Texture>();
  obj.traverse((child) => {
    if (child instanceof Mesh) {
      if (child.geometry) geos.add(child.geometry);
      const list = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of list) {
        if (!m) continue;
        mats.add(m);
        for (const value of Object.values(m)) {
          if (value instanceof Texture) textures.add(value);
        }
      }
    }
  });
  for (const t of textures) t.dispose();
  for (const g of geos) g.dispose();
  for (const m of mats) m.dispose();
}

function applyWindowGlowState(mat: MeshStandardMaterial, nightFactor: number): void {
  mat.emissive.setHex(0xffb830);
  mat.emissiveIntensity = 0.10 + nightFactor * 1.65;
}

function extractMergedSlotGeometry(template: LoadedTemplate, options?: LoadSlotGeometryOptions): BufferGeometry | null {
  if (template.subMeshes.length === 0) return null;

  const baseScale = options?.scale ?? 1;
  const normScale =
    options?.targetHeight !== undefined && template.boundsHeight > 0.001
      ? (options.targetHeight / template.boundsHeight) * baseScale
      : baseScale;

  const normMat = new Matrix4().makeScale(normScale, normScale, normScale);
  const translateMat = new Matrix4().makeTranslation(
    -template.boundsCenterX,
    -template.boundsMinY,
    -template.boundsCenterZ,
  );
  normMat.multiply(translateMat);

  const mergedPositions: number[] = [];
  const mergedNormals: number[] = [];
  const tmpV = new Vector3();
  const tmpN = new Vector3();
  const combinedMat = new Matrix4();
  const normalMat = new Matrix4();
  let minY = Infinity;
  let maxY = -Infinity;

  for (const sub of template.subMeshes) {
    const srcGeo = sub.geometry;
    const posAttr = srcGeo.getAttribute("position");
    if (!posAttr) continue;
    const normAttr = srcGeo.getAttribute("normal");
    const index = srcGeo.getIndex();

    combinedMat.multiplyMatrices(normMat, sub.localMatrix);
    normalMat.copy(combinedMat).invert().transpose();

    const pushVertex = (vi: number) => {
      tmpV.fromBufferAttribute(posAttr, vi).applyMatrix4(combinedMat);
      mergedPositions.push(tmpV.x, tmpV.y, tmpV.z);
      if (tmpV.y < minY) minY = tmpV.y;
      if (tmpV.y > maxY) maxY = tmpV.y;

      if (normAttr) {
        tmpN.fromBufferAttribute(normAttr, vi).transformDirection(normalMat).normalize();
        // 잔디 등 초원 자연물 쉐이딩이 자연스럽도록 부드럽게 상향 보정 가능
        mergedNormals.push(tmpN.x, tmpN.y, tmpN.z);
      } else {
        mergedNormals.push(0, 1, 0);
      }
    };

    if (index) {
      for (let i = 0; i < index.count; i += 1) {
        pushVertex(index.getX(i));
      }
    } else {
      for (let i = 0; i < posAttr.count; i += 1) {
        pushVertex(i);
      }
    }
  }

  if (mergedPositions.length === 0) return null;

  const vertCount = mergedPositions.length / 3;
  const bladeH = new Float32Array(vertCount);
  const spanY = Math.max(0.001, maxY - minY);
  for (let i = 0; i < vertCount; i += 1) {
    const py = mergedPositions[i * 3 + 1]!;
    bladeH[i] = Math.max(0, Math.min(1, (py - minY) / spanY));
  }

  const out = new BufferGeometry();
  out.setAttribute("position", new BufferAttribute(new Float32Array(mergedPositions), 3));
  out.setAttribute("normal", new BufferAttribute(new Float32Array(mergedNormals), 3));
  out.setAttribute("aBladeH", new BufferAttribute(bladeH, 1));
  out.computeBoundingSphere();
  return markSharedGeometry(out);
}

const WHITE_COLOR = new Color(0xffffff);
const TMP_COLOR = new Color();
const TMP_POS = new Vector3();
const TMP_SCALE = new Vector3();
const TMP_EULER = new Euler();
const TMP_QUAT = new Quaternion();
const TMP_INST_MAT = new Matrix4();
const TMP_FINAL_MAT = new Matrix4();
const TMP_NORM_MAT = new Matrix4();
const TMP_TRANS_MAT = new Matrix4();

export function createWorldAssetRegistry(): WorldAssetRegistry {
  const loader = new GLTFLoader();
  const cache = new Map<WorldModelSlot, Promise<LoadedTemplate | null>>();
  const loadedTemplates: LoadedTemplate[] = [];
  const extractedGeometries = new Map<string, Promise<BufferGeometry | null>>();
  const ownedExtractedGeos: BufferGeometry[] = [];
  const tintedMaterialCache = new Map<string, MeshStandardMaterial>();
  const windowGlowMaterials = new Set<MeshStandardMaterial>();
  const activeMixers = new Set<AnimationMixer>();

  let lastNightFactor = 0;
  let disposed = false;

  function getTintedRoofMaterial(baseMat: MeshStandardMaterial, hex: number): MeshStandardMaterial {
    const key = `${baseMat.uuid}:${hex}`;
    let cached = tintedMaterialCache.get(key);
    if (!cached) {
      cached = baseMat.clone();
      cached.color.setHex(hex);
      cached.envMapIntensity = Math.max(cached.envMapIntensity, 0.75);
      markSharedMaterial(cached);
      tintedMaterialCache.set(key, cached);
    }
    return cached;
  }

  function applySlotGeometryPolish(slot: WorldModelSlot, root: Object3D): void {
    if (slot !== "district-tier1") return;
    // Tier 1 캠프 텐트 주변 모닥불·통나무 벤치 파고듦 보정 + 텐트 바닥판 경계 완화
    const campfireNodes = new Set(["EmberCore", "Part_BarkDark", "Part_StoneDark", "Part_StoneMid"]);
    root.traverse((child) => {
      if (campfireNodes.has(child.name)) {
        child.position.x += 0.38;
        child.position.z += 0.26;
      } else if (child.name === "LogBench") {
        child.position.x += 0.18;
        child.position.y -= 0.015;
        child.position.z += 0.44;
      } else if (child.name === "CampPad") {
        child.scale.y *= 0.45;
        child.position.y -= 0.022;
        if (child instanceof Mesh && child.material instanceof MeshStandardMaterial) {
          child.material.roughness = 0.96;
          child.material.color.setHex(0xc7c2b8);
          child.material.polygonOffset = true;
          child.material.polygonOffsetFactor = 1;
          child.material.polygonOffsetUnits = 1;
        }
      }
    });
  }

  function registerTemplateResources(slot: WorldModelSlot, root: Object3D): LoadedTemplate {
    // 정규화 바운드는 원본 텐트/바닥판 기준을 유지해 소품 보정 후에도 스케일·중심이 흔들리지 않게 한다.
    root.updateMatrixWorld(true);
    const box = new Box3().setFromObject(root);
    const size = new Vector3();
    const center = new Vector3();
    if (!box.isEmpty()) {
      box.getSize(size);
      box.getCenter(center);
    }

    applySlotGeometryPolish(slot, root);
    root.updateMatrixWorld(true);

    const subMeshes: TemplateSubMesh[] = [];
    root.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      if (child.geometry) {
        markSharedGeometry(child.geometry);
      }
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of mats) {
        if (!mat) continue;
        markSharedMaterial(mat);
        if (mat instanceof MeshStandardMaterial) {
          mat.envMapIntensity = Math.max(mat.envMapIntensity, 0.75);
          if (isWindowGlowMaterial(mat)) {
            windowGlowMaterials.add(mat);
            applyWindowGlowState(mat, lastNightFactor);
          }
        }
      }
      // 단일 머티리얼 서브메시(또는 첫 머티리얼)를 인스탠싱 목록에 등록
      const primaryMat = Array.isArray(child.material) ? child.material[0] : child.material;
      if (child.geometry && primaryMat) {
        subMeshes.push({
          geometry: child.geometry,
          material: primaryMat,
          localMatrix: child.matrixWorld.clone(),
          isRoofTint: isRoofTintMaterial(primaryMat),
        });
      }
    });

    return {
      scene: root,
      animations: [],
      boundsMinY: box.isEmpty() ? 0 : box.min.y,
      boundsCenterX: box.isEmpty() ? 0 : center.x,
      boundsCenterZ: box.isEmpty() ? 0 : center.z,
      boundsHeight: size.y,
      subMeshes,
    };
  }

  function loadTemplate(slot: WorldModelSlot): Promise<LoadedTemplate | null> {
    const existing = cache.get(slot);
    if (existing) return existing;
    const url = SLOT_URL_MAP.get(slot);
    if (!url) return Promise.resolve(null);

    const promise = loader
      .loadAsync(url)
      .then((gltf) => {
        if (disposed) {
          disposeFullTemplate(gltf.scene);
          return null;
        }
        const registered = registerTemplateResources(slot, gltf.scene);
        const entry: LoadedTemplate = {
          ...registered,
          animations: gltf.animations ?? [],
        };
        loadedTemplates.push(entry);
        return entry;
      })
      .catch((error: unknown) => {
        console.warn(`[the-world] Failed to load custom GLB for slot "${slot}":`, error);
        return null;
      });

    cache.set(slot, promise);
    return promise;
  }

  function prepareClonedInstance(
    template: LoadedTemplate,
    opts: {
      readonly targetHeight?: number | undefined;
      readonly scale: number;
      readonly roofTintHex?: number | undefined;
      readonly castShadow: boolean;
      readonly receiveShadow: boolean;
    },
  ): WorldModelInstance {
    const cloned = cloneSkeleton(template.scene);
    const root = new Group();
    root.add(cloned);

    let normScale = opts.scale;
    if (opts.targetHeight !== undefined && template.boundsHeight > 0.001) {
      normScale = (opts.targetHeight / template.boundsHeight) * opts.scale;
    }
    cloned.scale.multiplyScalar(normScale);
    cloned.position.set(
      -template.boundsCenterX * normScale,
      -template.boundsMinY * normScale,
      -template.boundsCenterZ * normScale,
    );

    root.updateMatrixWorld(true);

    const anchors: Record<string, Vector3> = {};
    let bladePivot: Object3D | null = null;

    cloned.traverse((child) => {
      if (child instanceof Mesh) {
        child.castShadow = opts.castShadow;
        child.receiveShadow = opts.receiveShadow;
        if (opts.roofTintHex !== undefined) {
          if (Array.isArray(child.material)) {
            child.material = child.material.map((m) =>
              isRoofTintMaterial(m) ? getTintedRoofMaterial(m, opts.roofTintHex!) : m,
            );
          } else if (isRoofTintMaterial(child.material)) {
            child.material = getTintedRoofMaterial(child.material, opts.roofTintHex);
          }
        }
      }
      const lower = child.name.toLowerCase();
      if (lower.endsWith("_anchor") || lower === "smoke_anchor" || lower === "lamp_anchor") {
        const world = new Vector3();
        child.getWorldPosition(world);
        anchors[lower] = world;
      }
      if (!bladePivot && isBladePivotName(child.name)) {
        bladePivot = child;
      }
    });

    let mixer: AnimationMixer | null = null;
    if (template.animations.length > 0) {
      mixer = new AnimationMixer(cloned);
      for (const clip of template.animations) {
        mixer.clipAction(clip).play();
      }
    }

    return { root, anchors, bladePivot, mixer };
  }

  function buildInstancedMeshes(
    template: LoadedTemplate,
    opts: MountInstancedSlotOptions,
  ): InstancedMesh[] {
    const count = opts.transforms.length;
    if (count === 0 || template.subMeshes.length === 0) return [];

    const baseScale = opts.scale ?? 1;
    const normScale =
      opts.targetHeight !== undefined && template.boundsHeight > 0.001
        ? (opts.targetHeight / template.boundsHeight) * baseScale
        : baseScale;
    const castShadow = opts.castShadow ?? true;
    const receiveShadow = opts.receiveShadow ?? true;

    TMP_NORM_MAT.makeScale(normScale, normScale, normScale);
    TMP_TRANS_MAT.makeTranslation(-template.boundsCenterX, -template.boundsMinY, -template.boundsCenterZ);
    TMP_NORM_MAT.multiply(TMP_TRANS_MAT);

    const hasPerInstanceTint = opts.transforms.some((t) => t.roofTintHex !== undefined);
    const hasInstanceMeta = opts.transforms.some((t) => t.userData !== undefined);
    const instanceMeta = hasInstanceMeta ? opts.transforms.map((t) => t.userData ?? null) : null;
    const meshes: InstancedMesh[] = [];

    for (const sub of template.subMeshes) {
      // 모든 인스턴스가 동일 틴트색만 쓰면 캐시된 틴트 머티리얼로, 인스턴스별 색이 다르면 base 화이트 + setColorAt 사용
      let mat: Material = sub.material;
      let useInstanceColor = false;
      if (sub.isRoofTint && sub.material instanceof MeshStandardMaterial) {
        if (hasPerInstanceTint) {
          // instanceColor와 곱해지도록 중립 화이트 베이스(0xffffff)를 캐시해 사용한다.
          mat = getTintedRoofMaterial(sub.material, 0xffffff);
          useInstanceColor = true;
        } else if (opts.colorTintHex !== undefined) {
          mat = getTintedRoofMaterial(sub.material, opts.colorTintHex);
        }
      }

      const inst = new InstancedMesh(sub.geometry, mat, count);
      inst.castShadow = castShadow;
      inst.receiveShadow = receiveShadow;
      inst.userData["slot"] = opts.slot;
      if (instanceMeta) {
        inst.userData["instanceMeta"] = instanceMeta;
      }

      const subNormMat = new Matrix4().multiplyMatrices(TMP_NORM_MAT, sub.localMatrix);

      for (let i = 0; i < count; i += 1) {
        const tf = opts.transforms[i]!;
        const s = tf.scale ?? 1;
        TMP_POS.set(tf.x, tf.y, tf.z);
        TMP_EULER.set(0, tf.rotationY ?? 0, 0);
        TMP_QUAT.setFromEuler(TMP_EULER);
        TMP_SCALE.set((tf.scaleX ?? 1) * s, (tf.scaleY ?? 1) * s, (tf.scaleZ ?? 1) * s);
        TMP_INST_MAT.compose(TMP_POS, TMP_QUAT, TMP_SCALE);
        TMP_FINAL_MAT.multiplyMatrices(TMP_INST_MAT, subNormMat);
        inst.setMatrixAt(i, TMP_FINAL_MAT);

        if (useInstanceColor) {
          const hex = tf.roofTintHex ?? opts.colorTintHex;
          if (hex !== undefined) {
            TMP_COLOR.setHex(hex);
            inst.setColorAt(i, TMP_COLOR);
          } else {
            inst.setColorAt(i, WHITE_COLOR);
          }
        }
      }

      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      inst.computeBoundingSphere();
      meshes.push(inst);
    }

    return meshes;
  }

  function loadSlotGeometry(
    slot: WorldModelSlot,
    options?: LoadSlotGeometryOptions,
  ): Promise<BufferGeometry | null> {
    if (!SLOT_URL_MAP.has(slot)) return Promise.resolve(null);
    const key = `${slot}:${options?.targetHeight ?? ""}:${options?.scale ?? 1}`;
    const existing = extractedGeometries.get(key);
    if (existing) return existing;

    const promise = loadTemplate(slot).then((template) => {
      if (disposed || !template) return null;
      const geo = extractMergedSlotGeometry(template, options);
      if (geo) ownedExtractedGeos.push(geo);
      return geo;
    });
    extractedGeometries.set(key, promise);
    return promise;
  }

  return {
    hasCustomModel(slot) {
      return SLOT_URL_MAP.has(slot);
    },
    mountSlot({
      slot,
      container,
      mountFallback,
      targetHeight,
      scale = 1,
      roofTintHex,
      castShadow = true,
      receiveShadow = true,
      onMounted,
    }) {
      const fallbackGroup = new Group();
      mountFallback(fallbackGroup);
      container.add(fallbackGroup);

      if (!SLOT_URL_MAP.has(slot)) return;

      void loadTemplate(slot).then((template) => {
        if (disposed || !template || !container.parent) return;
        container.remove(fallbackGroup);
        disposeNonSharedTree(fallbackGroup);
        const instance = prepareClonedInstance(template, {
          targetHeight,
          scale,
          roofTintHex,
          castShadow,
          receiveShadow,
        });
        container.add(instance.root);
        if (instance.mixer) activeMixers.add(instance.mixer);
        onMounted?.(instance);
      });
    },
    mountInstancedSlot(opts) {
      if (opts.transforms.length === 0) return;

      let fallbackGroup: Group | null = null;
      if (opts.mountFallback) {
        fallbackGroup = new Group();
        opts.mountFallback(fallbackGroup);
        opts.container.add(fallbackGroup);
      }

      if (!SLOT_URL_MAP.has(opts.slot)) return;

      void loadTemplate(opts.slot).then((template) => {
        if (disposed || !template || !opts.container.parent) return;
        if (fallbackGroup) {
          opts.container.remove(fallbackGroup);
          disposeNonSharedTree(fallbackGroup);
          fallbackGroup = null;
        }
        const meshes = buildInstancedMeshes(template, opts);
        for (const m of meshes) {
          opts.container.add(m);
        }
        opts.onMounted?.(meshes);
      });
    },
    loadSlotGeometry,
    loadFirstMeshGeometry: loadSlotGeometry,
    setNightFactor(nightFactor) {
      if (Math.abs(nightFactor - lastNightFactor) < 0.004) return;
      lastNightFactor = nightFactor;
      for (const mat of windowGlowMaterials) {
        applyWindowGlowState(mat, nightFactor);
      }
    },
    update(dt) {
      for (const mixer of activeMixers) {
        mixer.update(dt);
      }
    },
    clearActiveMixers() {
      for (const mixer of activeMixers) {
        mixer.stopAllAction();
      }
      activeMixers.clear();
    },
    dispose() {
      disposed = true;
      for (const mixer of activeMixers) {
        mixer.stopAllAction();
      }
      activeMixers.clear();
      windowGlowMaterials.clear();
      for (const mat of tintedMaterialCache.values()) {
        mat.dispose();
      }
      tintedMaterialCache.clear();
      for (const geo of ownedExtractedGeos) {
        geo.dispose();
      }
      ownedExtractedGeos.length = 0;
      extractedGeometries.clear();
      for (const tpl of loadedTemplates) {
        disposeFullTemplate(tpl.scene);
      }
      loadedTemplates.length = 0;
      cache.clear();
    },
  };
}
