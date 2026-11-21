import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  Euler,
  Group,
  InstancedMesh,
  Material,
  Matrix4,
  Mesh,
  Object3D,
  OctahedronGeometry,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from "three";

/**
 * 초원 월드 & 심시티 사령관 마을용 공용 단위 지오메트리 풀 + 재질 버킷 `InstancedMesh` 빌더.
 *
 * - 단위 프리미티브 지오메트리(`box`, `cylinder`, `cone`, `sphere`, `dodecaSmooth`, `dodecaFlat`,
 *   `octahedron`, `planeXZ`, `torusXZ`, `gableWall`)를 모듈 레벨에서 1회만 생성해 재사용한다.
 * - 동일 `(geometry, material, castShadow, receiveShadow, renderOrder)` 조합을 하나의 `InstancedMesh`로
 *   배칭해, 마을·Theater 구역이 50~150개 늘어나도 추가 draw call을 15~20개 이내로 억제한다.
 * - `disposeObjectTree()`는 `userData.shared === true`로 표시된 공용 지오메트리·머티리얼은 보존하면서
 *   `InstancedMesh` 인스턴스 버퍼와 비공유 리소스만 안전하게 해제해 GPU 메모리 누수를 차단한다.
 */

export type UnitGeometryKey =
  | "box"
  | "cylinder"
  | "cylinderTapered"
  | "cone"
  | "sphere"
  | "dodecaSmooth"
  | "dodecaFlat"
  | "octahedron"
  | "planeXZ"
  | "torusXZ"
  | "gableWall";

export type Vec3Tuple = readonly [number, number, number];

export interface BucketInstanceOptions {
  readonly color?: number | Color | undefined;
  readonly castShadow?: boolean | undefined;
  readonly receiveShadow?: boolean | undefined;
  readonly renderOrder?: number | undefined;
}

export interface PitchedRoofOptions {
  readonly x?: number | undefined;
  readonly y: number;
  readonly z?: number | undefined;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly roofColor?: number | Color | undefined;
  readonly includeGableWall?: boolean | undefined;
  readonly castShadow?: boolean | undefined;
  readonly receiveShadow?: boolean | undefined;
}

export interface InstancedBucketStats {
  readonly bucketCount: number;
  readonly totalInstances: number;
}

export interface InstancedBucketBuilder {
  /** 로컬 좌표계 프레임을 푸시한다(중첩 가능). 마을 → 구역 → 건물 단위로 로컬 좌표를 그대로 작성할 수 있다. */
  withFrame(x: number, y: number, z: number, rotY: number, scale: number, fn: () => void): void;
  /** 임의의 로컬-투-월드 행렬로 인스턴스를 추가한다. */
  addMatrix(
    geoKey: UnitGeometryKey,
    material: Material,
    localMatrix: Matrix4,
    options?: BucketInstanceOptions,
  ): void;
  /** 일반 단위 프리미티브 추가 (현재 프레임 기준 위치·크기·오일러 회전). */
  add(
    geoKey: UnitGeometryKey,
    material: Material,
    position: Vec3Tuple,
    scale: Vec3Tuple,
    rotation?: Vec3Tuple,
    options?: BucketInstanceOptions,
  ): void;
  addBox(
    material: Material,
    position: Vec3Tuple,
    scale: Vec3Tuple,
    rotation?: Vec3Tuple,
    options?: BucketInstanceOptions,
  ): void;
  addCylinder(
    material: Material,
    position: Vec3Tuple,
    scale: Vec3Tuple,
    rotation?: Vec3Tuple,
    options?: BucketInstanceOptions & { readonly tapered?: boolean | undefined },
  ): void;
  addCone(
    material: Material,
    position: Vec3Tuple,
    scale: Vec3Tuple,
    rotation?: Vec3Tuple,
    options?: BucketInstanceOptions,
  ): void;
  addSphere(
    material: Material,
    position: Vec3Tuple,
    scale: Vec3Tuple,
    rotation?: Vec3Tuple,
    options?: BucketInstanceOptions,
  ): void;
  addDodeca(
    material: Material,
    position: Vec3Tuple,
    scale: Vec3Tuple,
    rotation?: Vec3Tuple,
    options?: BucketInstanceOptions & { readonly flat?: boolean | undefined },
  ): void;
  addOctahedron(
    material: Material,
    position: Vec3Tuple,
    scale: Vec3Tuple,
    rotation?: Vec3Tuple,
    options?: BucketInstanceOptions,
  ): void;
  addPlane(
    material: Material,
    position: Vec3Tuple,
    scale: Vec3Tuple,
    rotation?: Vec3Tuple,
    options?: BucketInstanceOptions,
  ): void;
  addTorus(
    material: Material,
    position: Vec3Tuple,
    scale: Vec3Tuple,
    rotation?: Vec3Tuple,
    options?: BucketInstanceOptions,
  ): void;
  /** 박공지붕(좌/우 지붕면 + 용마루 + 선택적 삼각 박공벽/동바리)을 버킷에 일괄 추가한다. */
  addPitchedRoof(
    roofMaterial: Material,
    gableWallMaterial: Material,
    timberMaterial: Material,
    options: PitchedRoofOptions,
  ): void;
  /** 누적된 버킷을 `InstancedMesh`로 컴파일해 단일 `Group`으로 반환한다. */
  build(name?: string): Group;
  /** 현재까지 누적된 버킷/인스턴스 통계를 조회한다. */
  getStats(): InstancedBucketStats;
}

const SHARED_FLAG = "__fleetSharedResource";

export function markSharedGeometry<T extends BufferGeometry>(geo: T): T {
  geo.userData[SHARED_FLAG] = true;
  return geo;
}

export function markSharedMaterial<T extends Material>(mat: T): T {
  mat.userData[SHARED_FLAG] = true;
  return mat;
}

export function isSharedResource(obj: { readonly userData: Record<string, unknown> } | null | undefined): boolean {
  return Boolean(obj?.userData?.[SHARED_FLAG]);
}

function createUnitGableWallGeometry(): BufferGeometry {
  const positions = new Float32Array([
    // 전면 삼각형 (+Z)
    -0.5, 0, 0.5,
    0.5, 0, 0.5,
    0, 1, 0.5,
    // 후면 삼각형 (-Z)
    0.5, 0, -0.5,
    -0.5, 0, -0.5,
    0, 1, -0.5,
  ]);
  const normals = new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1,
    0, 0, -1, 0, 0, -1, 0, 0, -1,
  ]);
  const uvs = new Float32Array([
    0, 0, 1, 0, 0.5, 1,
    0, 0, 1, 0, 0.5, 1,
  ]);
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(positions, 3));
  geo.setAttribute("normal", new BufferAttribute(normals, 3));
  geo.setAttribute("uv", new BufferAttribute(uvs, 2));
  geo.computeBoundingSphere();
  return markSharedGeometry(geo);
}

let unitGeometries: Readonly<Record<UnitGeometryKey, BufferGeometry>> | null = null;

/** 단위 프리미티브 지오메트리 풀을 지연 1회 생성해 반환한다. */
export function getUnitGeometries(): Readonly<Record<UnitGeometryKey, BufferGeometry>> {
  if (unitGeometries) return unitGeometries;

  const planeXZ = new PlaneGeometry(1, 1);
  planeXZ.rotateX(-Math.PI * 0.5);
  planeXZ.computeBoundingSphere();

  const torusXZ = new TorusGeometry(0.5, 0.085, 8, 16);
  torusXZ.rotateX(Math.PI * 0.5);
  torusXZ.computeBoundingSphere();

  const box = new BoxGeometry(1, 1, 1);
  const cylinder = new CylinderGeometry(0.5, 0.5, 1, 10);
  const cylinderTapered = new CylinderGeometry(0.36, 0.5, 1, 10);
  const cone = new ConeGeometry(0.5, 1, 8);
  const sphere = new SphereGeometry(0.5, 10, 8);
  const dodecaSmooth = new DodecahedronGeometry(0.5, 1);
  const dodecaFlat = new DodecahedronGeometry(0.5, 0);
  const octahedron = new OctahedronGeometry(0.5, 0);

  for (const geo of [box, cylinder, cylinderTapered, cone, sphere, dodecaSmooth, dodecaFlat, octahedron]) {
    geo.computeBoundingSphere();
    markSharedGeometry(geo);
  }
  markSharedGeometry(planeXZ);
  markSharedGeometry(torusXZ);

  unitGeometries = {
    box,
    cylinder,
    cylinderTapered,
    cone,
    sphere,
    dodecaSmooth,
    dodecaFlat,
    octahedron,
    planeXZ,
    torusXZ,
    gableWall: createUnitGableWallGeometry(),
  };
  return unitGeometries;
}

interface BucketEntry {
  readonly geoKey: UnitGeometryKey;
  readonly material: Material;
  readonly castShadow: boolean;
  readonly receiveShadow: boolean;
  readonly renderOrder: number;
  readonly matrices: number[];
  readonly colors: (number | null)[];
  hasColor: boolean;
}

const WHITE_COLOR = new Color(0xffffff);
const TMP_POS = new Vector3();
const TMP_SCALE = new Vector3();
const TMP_EULER = new Euler();
const TMP_QUAT = new Quaternion();
const TMP_LOCAL_MAT = new Matrix4();
const TMP_WORLD_MAT = new Matrix4();
const TMP_FRAME_MAT = new Matrix4();
const TMP_COLOR = new Color();

export function createInstancedBucketBuilder(): InstancedBucketBuilder {
  const buckets = new Map<string, BucketEntry>();
  const frameStack: Matrix4[] = [];
  let totalInstances = 0;

  function getOrCreateBucket(
    geoKey: UnitGeometryKey,
    material: Material,
    options?: BucketInstanceOptions,
  ): BucketEntry {
    const castShadow = options?.castShadow === true;
    const receiveShadow = options?.receiveShadow === true;
    const renderOrder = options?.renderOrder ?? 0;
    const key = `${geoKey}|${material.uuid}|${castShadow ? 1 : 0}|${receiveShadow ? 1 : 0}|${renderOrder}`;
    let entry = buckets.get(key);
    if (!entry) {
      entry = {
        geoKey,
        material,
        castShadow,
        receiveShadow,
        renderOrder,
        matrices: [],
        colors: [],
        hasColor: false,
      };
      buckets.set(key, entry);
    }
    return entry;
  }

  function pushMatrixInternal(
    geoKey: UnitGeometryKey,
    material: Material,
    localMatrix: Matrix4,
    options?: BucketInstanceOptions,
  ): void {
    const bucket = getOrCreateBucket(geoKey, material, options);
    const parentFrame = frameStack.length > 0 ? frameStack[frameStack.length - 1] : undefined;
    const finalMat = parentFrame
      ? TMP_WORLD_MAT.multiplyMatrices(parentFrame, localMatrix)
      : localMatrix;

    const e = finalMat.elements;
    for (let i = 0; i < 16; i += 1) {
      bucket.matrices.push(e[i]!);
    }

    if (options?.color !== undefined) {
      bucket.hasColor = true;
      const hex = typeof options.color === "number" ? options.color : options.color.getHex();
      bucket.colors.push(hex);
    } else {
      bucket.colors.push(null);
    }
    totalInstances += 1;
  }

  function addPrimitive(
    geoKey: UnitGeometryKey,
    material: Material,
    position: Vec3Tuple,
    scale: Vec3Tuple,
    rotation?: Vec3Tuple,
    options?: BucketInstanceOptions,
  ): void {
    TMP_POS.set(position[0], position[1], position[2]);
    if (rotation) {
      TMP_EULER.set(rotation[0], rotation[1], rotation[2]);
      TMP_QUAT.setFromEuler(TMP_EULER);
    } else {
      TMP_QUAT.identity();
    }
    TMP_SCALE.set(scale[0], scale[1], scale[2]);
    TMP_LOCAL_MAT.compose(TMP_POS, TMP_QUAT, TMP_SCALE);
    pushMatrixInternal(geoKey, material, TMP_LOCAL_MAT, options);
  }

  const builder: InstancedBucketBuilder = {
    withFrame(x, y, z, rotY, scale, fn) {
      TMP_POS.set(x, y, z);
      TMP_EULER.set(0, rotY, 0);
      TMP_QUAT.setFromEuler(TMP_EULER);
      TMP_SCALE.set(scale, scale, scale);
      TMP_FRAME_MAT.compose(TMP_POS, TMP_QUAT, TMP_SCALE);

      const nextFrame = new Matrix4();
      const parentFrame = frameStack.length > 0 ? frameStack[frameStack.length - 1] : undefined;
      if (parentFrame) {
        nextFrame.multiplyMatrices(parentFrame, TMP_FRAME_MAT);
      } else {
        nextFrame.copy(TMP_FRAME_MAT);
      }
      frameStack.push(nextFrame);
      try {
        fn();
      } finally {
        frameStack.pop();
      }
    },
    addMatrix(geoKey, material, localMatrix, options) {
      pushMatrixInternal(geoKey, material, localMatrix, options);
    },
    add: addPrimitive,
    addBox(material, position, scale, rotation, options) {
      addPrimitive("box", material, position, scale, rotation, options);
    },
    addCylinder(material, position, scale, rotation, options) {
      const geoKey: UnitGeometryKey = options?.tapered ? "cylinderTapered" : "cylinder";
      addPrimitive(geoKey, material, position, scale, rotation, options);
    },
    addCone(material, position, scale, rotation, options) {
      addPrimitive("cone", material, position, scale, rotation, options);
    },
    addSphere(material, position, scale, rotation, options) {
      addPrimitive("sphere", material, position, scale, rotation, options);
    },
    addDodeca(material, position, scale, rotation, options) {
      const geoKey: UnitGeometryKey = options?.flat ? "dodecaFlat" : "dodecaSmooth";
      addPrimitive(geoKey, material, position, scale, rotation, options);
    },
    addOctahedron(material, position, scale, rotation, options) {
      addPrimitive("octahedron", material, position, scale, rotation, options);
    },
    addPlane(material, position, scale, rotation, options) {
      addPrimitive("planeXZ", material, position, scale, rotation, options);
    },
    addTorus(material, position, scale, rotation, options) {
      addPrimitive("torusXZ", material, position, scale, rotation, options);
    },
    addPitchedRoof(roofMaterial, gableWallMaterial, timberMaterial, opts) {
      const ox = opts.x ?? 0;
      const oy = opts.y;
      const oz = opts.z ?? 0;
      const { width, height, depth } = opts;
      const castShadow = opts.castShadow ?? true;
      const receiveShadow = opts.receiveShadow ?? true;
      const includeGableWall = opts.includeGableWall ?? true;
      const slopeLen = Math.hypot(width * 0.5 + 0.28, height);
      const slopeAngle = Math.atan2(height, width * 0.5 + 0.28);

      addPrimitive(
        "box",
        roofMaterial,
        [ox - (width * 0.25 + 0.10), oy + height * 0.48, oz],
        [slopeLen, 0.11, depth + 0.44],
        [0, 0, slopeAngle],
        { color: opts.roofColor, castShadow, receiveShadow },
      );
      addPrimitive(
        "box",
        roofMaterial,
        [ox + (width * 0.25 + 0.10), oy + height * 0.48, oz],
        [slopeLen, 0.11, depth + 0.44],
        [0, 0, -slopeAngle],
        { color: opts.roofColor, castShadow, receiveShadow },
      );
      addPrimitive(
        "box",
        timberMaterial,
        [ox, oy + height - 0.02, oz],
        [0.16, 0.14, depth + 0.50],
        undefined,
        { castShadow },
      );

      if (includeGableWall) {
        const gw = width * 0.99;
        const gh = height * 0.94;
        const gd = depth * 0.99;
        addPrimitive(
          "gableWall",
          gableWallMaterial,
          [ox, oy, oz],
          [gw, gh, gd],
          undefined,
          { castShadow, receiveShadow },
        );
        const hd = depth * 0.495;
        addPrimitive("box", timberMaterial, [ox, oy + gh * 0.48, oz + hd + 0.02], [0.11, gh * 0.96, 0.08]);
        addPrimitive("box", timberMaterial, [ox, oy + gh * 0.48, oz - hd - 0.02], [0.11, gh * 0.96, 0.08]);
      }
    },
    build(name = "instanced-world-buckets") {
      const geos = getUnitGeometries();
      const group = new Group();
      group.name = name;
      const mat4 = new Matrix4();

      for (const bucket of buckets.values()) {
        const count = bucket.colors.length;
        if (count === 0) continue;
        const mesh = new InstancedMesh(geos[bucket.geoKey], bucket.material, count);
        mesh.castShadow = bucket.castShadow;
        mesh.receiveShadow = bucket.receiveShadow;
        mesh.renderOrder = bucket.renderOrder;

        for (let i = 0; i < count; i += 1) {
          const offset = i * 16;
          mat4.fromArray(bucket.matrices, offset);
          mesh.setMatrixAt(i, mat4);
          if (bucket.hasColor) {
            const hex = bucket.colors[i];
            if (hex !== null && hex !== undefined) {
              TMP_COLOR.setHex(hex);
              mesh.setColorAt(i, TMP_COLOR);
            } else {
              mesh.setColorAt(i, WHITE_COLOR);
            }
          }
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        group.add(mesh);
      }

      return group;
    },
    getStats() {
      return { bucketCount: buckets.size, totalInstances };
    },
  };

  return builder;
}

/**
 * 서브트리 내 모든 비공유 지오메트리·머티리얼과 `InstancedMesh` GPU 버퍼를 안전하게 해제한다.
 * `markSharedGeometry` / `markSharedMaterial`로 표시된 공용 리소스는 건드리지 않는다.
 */
export function disposeObjectTree(
  root: Object3D,
  options?: {
    readonly skipGeometries?: ReadonlySet<BufferGeometry> | undefined;
    readonly skipMaterials?: ReadonlySet<Material> | undefined;
  },
): void {
  const disposedGeos = new Set<BufferGeometry>();
  const disposedMats = new Set<Material>();

  root.traverse((child) => {
    if (child instanceof InstancedMesh) {
      // InstancedMesh.dispose()는 instanceMatrix / instanceColor 버퍼만 해제한다.
      child.dispose();
    }
    if (child instanceof Mesh) {
      const geo = child.geometry;
      if (
        geo
        && !disposedGeos.has(geo)
        && !isSharedResource(geo)
        && !options?.skipGeometries?.has(geo)
      ) {
        geo.dispose();
        disposedGeos.add(geo);
      }
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of mats) {
        if (
          mat
          && !disposedMats.has(mat)
          && !isSharedResource(mat)
          && !options?.skipMaterials?.has(mat)
        ) {
          mat.dispose();
          disposedMats.add(mat);
        }
      }
    }
  });
}
