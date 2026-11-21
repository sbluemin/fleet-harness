import {
  AnimationClip,
  AnimationMixer,
  Box3,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";

/**
 * Blender `.glb` 드롭인 3D 에셋 레지스트리.
 *
 * `features/the-world/client/assets/models/<slot>.glb` 경로에 파일을 넣어두면
 * Vite가 빌드/서빙 시 자동으로 URL을 매핑하고, `GLTFLoader`로 1회 로드한 뒤
 * 각 구조물·나무·소품 슬롯의 프로시저럴 폴백을 자동으로 대체한다.
 *
 * 파일이 비어 있을 때는 네트워크 요청이나 번들 오버헤드가 전혀 발생하지 않는다.
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
  | "streetlamp";

export interface WorldModelInstance {
  readonly root: Group;
  readonly anchors: Readonly<Record<string, Vector3>>;
  readonly bladePivot: Object3D | null;
  readonly mixer: AnimationMixer | null;
}

export interface WorldAssetRegistry {
  hasCustomModel(slot: WorldModelSlot): boolean;
  /**
   * 슬롯에 커스텀 `.glb`가 존재하면 `container` 내부를 자동으로 교체한다.
   * 로드 전에는 `mountFallback()`으로 만든 프로시저럴 메시가 즉시 표시되므로 빈 화면이 생기지 않는다.
   */
  mountSlot(options: {
    readonly slot: WorldModelSlot;
    readonly container: Group;
    readonly mountFallback: (parent: Group) => void;
    readonly targetHeight?: number | undefined;
    readonly scale?: number | undefined;
    readonly onMounted?: (instance: WorldModelInstance) => void;
  }): void;
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

interface LoadedTemplate {
  readonly scene: Object3D;
  readonly animations: readonly AnimationClip[];
}

function disposeObjectTree(obj: Object3D): void {
  obj.traverse((child) => {
    if (child instanceof Mesh) {
      child.geometry?.dispose();
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of mats) {
        if (mat && typeof mat.dispose === "function") mat.dispose();
      }
    }
  });
}

function prepareClonedInstance(
  template: LoadedTemplate,
  targetHeight?: number,
  scale = 1,
): WorldModelInstance {
  const cloned = cloneSkeleton(template.scene);
  const root = new Group();
  root.add(cloned);

  // 바닥 기준점(min.y = 0)과 선택적 높이 정규화
  const box = new Box3().setFromObject(cloned);
  if (!box.isEmpty()) {
    const size = new Vector3();
    const center = new Vector3();
    box.getSize(size);
    box.getCenter(center);

    let normScale = scale;
    if (targetHeight !== undefined && size.y > 0.001) {
      normScale = (targetHeight / size.y) * scale;
    }
    cloned.scale.multiplyScalar(normScale);
    cloned.position.set(
      -center.x * normScale,
      -box.min.y * normScale,
      -center.z * normScale,
    );
  }

  root.updateMatrixWorld(true);

  const anchors: Record<string, Vector3> = {};
  let bladePivot: Object3D | null = null;

  cloned.traverse((child) => {
    if (child instanceof Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of mats) {
        if (mat instanceof MeshStandardMaterial) {
          mat.envMapIntensity = Math.max(mat.envMapIntensity, 0.75);
        }
      }
    }
    const lower = child.name.toLowerCase();
    if (lower.endsWith("_anchor") || lower === "smoke_anchor" || lower === "lamp_anchor") {
      const world = new Vector3();
      child.getWorldPosition(world);
      anchors[lower] = world;
    }
    if (!bladePivot && (lower === "blade_pivot" || lower === "windmill_blades" || lower === "blades")) {
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

export function createWorldAssetRegistry(): WorldAssetRegistry {
  const loader = new GLTFLoader();
  const cache = new Map<WorldModelSlot, Promise<LoadedTemplate | null>>();
  const loadedTemplates: LoadedTemplate[] = [];
  const activeMixers = new Set<AnimationMixer>();
  let disposed = false;

  function loadTemplate(slot: WorldModelSlot): Promise<LoadedTemplate | null> {
    const existing = cache.get(slot);
    if (existing) return existing;
    const url = SLOT_URL_MAP.get(slot);
    if (!url) return Promise.resolve(null);

    const promise = loader
      .loadAsync(url)
      .then((gltf) => {
        const entry: LoadedTemplate = {
          scene: gltf.scene,
          animations: gltf.animations ?? [],
        };
        if (disposed) {
          disposeObjectTree(entry.scene);
          return null;
        }
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

  return {
    hasCustomModel(slot) {
      return SLOT_URL_MAP.has(slot);
    },
    mountSlot({ slot, container, mountFallback, targetHeight, scale = 1, onMounted }) {
      const fallbackGroup = new Group();
      mountFallback(fallbackGroup);
      container.add(fallbackGroup);

      if (!SLOT_URL_MAP.has(slot)) return;

      void loadTemplate(slot).then((template) => {
        if (disposed || !template || !container.parent) return;
        container.remove(fallbackGroup);
        const instance = prepareClonedInstance(template, targetHeight, scale);
        container.add(instance.root);
        if (instance.mixer) activeMixers.add(instance.mixer);
        onMounted?.(instance);
      });
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
      for (const tpl of loadedTemplates) {
        disposeObjectTree(tpl.scene);
      }
      loadedTemplates.length = 0;
      cache.clear();
    },
  };
}
