# The World — Blender `.glb` 에셋 드롭인 폴더

이 폴더(`features/the-world/client/assets/models/`)에 아래 슬롯 이름과 일치하는 **`.glb` (glTF 2.0 Binary)** 파일을 넣어두고 콘솔을 다시 빌드하면, 「더 월드」가 기존 프로시저럴 도형 대신 해당 Blender 모델을 자동으로 로드해 배치합니다.

## 지원 슬롯 파일명

| 파일명 | 대상 | 권장 높이(기준 스케일) | 선택 Empty 앵커 |
|---|---|---|---|
| `guild-hall.glb` | 본부 길드 회관 | 약 `4.8m` (폭 `5.4m`) | `smoke_anchor` (굴뚝 연기 위치) |
| `windmill.glb` | 풍차 시계탑 | 약 `5.4m` | `blade_pivot` 또는 `blades` (자동 회전) |
| `well.glb` | 중앙 광장 석조 우물 | 약 `2.4m` | — |
| `signpost.glb` | 광장 이정표 | 약 `1.8m` | — |
| `bridge.glb` | 시냇물 아치 목교 | 길이 약 `10.5m`, 폭 `2.5m` | — |
| `pavilion.glb` | 동쪽 벚꽃 정원 파빌리온 | 약 `3.8m` (지름 `5.0m`) | — |
| `cottage.glb` | Objective 공방 오두막 | 약 `3.4m` | — |
| `tree-oak.glb` | 참나무 | 약 `3.0m` (스케일 배율 자동 적용) | — |
| `tree-pine.glb` | 소나무 | 약 `3.5m` (스케일 배율 자동 적용) | — |
| `tree-blossom.glb` | 벚나무 | 약 `3.0m` (스케일 배율 자동 적용) | — |
| `bush.glb` | 수풀/바위 클러스터 | 약 `0.9m` | — |
| `bench.glb` | 통나무 벤치 | 약 `0.65m` | — |
| `streetlamp.glb` | 가로등 | 약 `2.8m` | `lamp_anchor` (야간 불빛 위치) |

## Blender 내보내기 규칙 (glTF 2.0 `.glb`)
1. **축 & 정면:** `+Y Up` (Blender glTF 기본 체크), 정면이 `+Z`를 향하도록 정렬합니다.
2. **피벗(바닥 정렬):** 로더가 모델 바운딩 박스의 최하단(`min.y`)을 자동으로 지면(`y = 0`)에 맞추며 X/Z 중심을 정렬합니다.
3. **머티리얼:** `Principled BSDF` 기반 PBR 텍스처(`Base Color`, `Roughness`, `Normal`, `Emission`)를 사용하세요. Blender 전용 절차적 셰이더 노드는 내보내기 전 이미지 텍스처로 **Bake** 해야 반영됩니다.
4. **애니메이션:** `.glb`에 포함된 키프레임 애니메이션은 로더의 `AnimationMixer`가 자동으로 반복 재생합니다.
5. **용량 팁:** 텍스처는 `512px ~ 1024px` WebP/PNG로 유지하면 60fps 및 빠른 콘솔 로딩을 유지할 수 있습니다.
