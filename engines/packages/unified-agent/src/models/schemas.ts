/**
 * 모델 레지스트리 Zod 스키마 및 타입 정의
 * models.json의 구조를 검증하고 타입을 추론합니다.
 */

import { z } from 'zod';

// Zod 추론 타입은 아래 스키마 const를 기반으로 계산되므로,
// 이 파일은 예외적으로 스키마 상수를 타입 선언보다 먼저 둡니다.
/** effort 허용 토큰 스키마 */
export const EffortLevelSchema: z.ZodType<string> = z.enum([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/** effort 지원 스키마 (discriminated union) */
export const EffortSchema = z.union([
  z.object({
    supported: z.literal(true),
    levels: z.array(EffortLevelSchema).min(1),
    default: EffortLevelSchema,
  }).strict(),
  z.object({
    supported: z.literal(false),
  }).strict(),
]);

/** 개별 모델 항목 스키마 */
export const ModelEntrySchema = z.object({
  /** 모델 고유 식별자 (session/set_model에 전달되는 값) */
  modelId: z.string(),
  /** 사람이 읽을 수 있는 모델 이름 */
  name: z.string(),
  /** 모델 설명 (선택) */
  description: z.string().optional(),
  /** spawn 시 실제 CLI 모델 ID를 조립해야 하는 경우의 템플릿 */
  spawnModelTemplate: z.string().optional(),
  /** 모델별 effort 설정 */
  effort: EffortSchema,
}).check((ctx) => {
  const effort = ctx.value.effort;
  if (effort.supported && !effort.levels.includes(effort.default)) {
    ctx.issues.push({
      code: 'custom',
      input: effort.default,
      message: `effort.default "${effort.default}"은(는) levels 목록에 존재해야 합니다`,
      path: ['effort', 'default'],
    });
  }
  if (effort.supported && ctx.value.spawnModelTemplate && !ctx.value.spawnModelTemplate.includes('{effort}')) {
    ctx.issues.push({
      code: 'custom',
      input: ctx.value.spawnModelTemplate,
      message: 'effort 지원 모델의 spawnModelTemplate은 "{effort}" 플레이스홀더를 포함해야 합니다',
      path: ['spawnModelTemplate'],
    });
  }
});

/** 모델 매핑 스키마 (modelId → 실제 모델명) */
export const ModelsMappingSchema = z.record(z.string(), z.string());

/** 프로바이더 스키마 (교차 필드 검증 포함) */
export const ProviderSchema = z.object({
  /** 프로바이더 표시 이름 */
  name: z.string(),
  /** 기본 모델 ID */
  defaultModel: z.string(),
  /** 사용 가능한 모델 목록 */
  models: z.array(ModelEntrySchema).min(1),
  /** modelId와 연관된 매핑 모델 (선택) */
  modelsMapping: ModelsMappingSchema.optional(),
}).check((ctx) => {
  const ids = new Set(ctx.value.models.map((m) => m.modelId));

  if (!ids.has(ctx.value.defaultModel)) {
    ctx.issues.push({
      code: 'custom',
      input: ctx.value.defaultModel,
      message: `defaultModel "${ctx.value.defaultModel}"은(는) models 목록에 존재해야 합니다`,
      path: ['defaultModel'],
    });
  }
});

/** 모델 매핑 스키마 (modelId → 실제 모델명) */
export const ModelMappingSchema = z.record(z.string(), z.string());

/** modelsMapper 개별 항목 스키마 */
export const ModelsMapperEntrySchema = z.object({
  /** modelId와 연관된 매핑 모델 */
  modelMapping: ModelMappingSchema,
  /** 추가 환경변수 (선택) */
  env: z.record(z.string(), z.string()).optional(),
});

/** modelsMapper 전체 스키마 */
export const ModelsMapperSchema = z.record(z.string(), ModelsMapperEntrySchema);

/** 모델 레지스트리 전체 스키마 */
export const ModelsRegistrySchema = z.object({
  /** 스키마 버전 */
  version: z.number().int().positive(),
  /** 최종 업데이트 시각 */
  updatedAt: z.string(),
  /** 프로바이더별 모델 정보 */
  providers: z.record(z.string(), ProviderSchema),
});

// ─── 타입 추론 ─────────────────────────────────────────

/** 개별 모델 항목 */
export type ModelEntry = z.infer<typeof ModelEntrySchema>;

/** effort 설정 */
export type Effort = z.infer<typeof EffortSchema>;

/** raw thinking level 허용 토큰 */
export type ThinkingLevel = z.infer<typeof EffortLevelSchema>;

/** effort 허용 토큰 (호환 alias) */
export type EffortLevel = ThinkingLevel;

/** 모델 매핑 (modelId → 실제 모델명) */
export type ModelsMapping = z.infer<typeof ModelsMappingSchema>;

/** 프로바이더 모델 정보 */
export type ProviderModelInfo = z.infer<typeof ProviderSchema>;

/** 모델 레지스트리 전체 */
export type ModelsRegistry = z.infer<typeof ModelsRegistrySchema>;
