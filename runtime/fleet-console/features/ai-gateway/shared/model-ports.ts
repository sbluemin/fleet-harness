import type { ModelRoster, ModelRosterTarget } from "./models.js";
/**
 * 모델 로스터 읽기 — Console의 모든 모델 선택지가 쓰는 원천. 코어 스토어 하나가 캐시를 갖고, Gateway 저장·
 * 서버 브로드캐스트(다른 탭·기기의 저장 포함)·화면 복귀 때 읽은 적 있는 대상을 다시 읽는다. React에서는
 * `AI Gateway useModelRoster`의 `useModelRoster(ctx.models, target)`를 쓴다.
 */
export interface ClientModelsCapability {
  /** 지금 캐시된 로스터. 부수효과가 없다 — 아직 읽지 않았으면 null이고 읽기를 시작하지 않는다. */
  read(target: ModelRosterTarget): ModelRoster | null;
  /** 그 대상을 읽는다(진행 중이면 합류한다). 끝나면 구독자가 깨어난다. */
  load(target: ModelRosterTarget): Promise<ModelRoster>;
  subscribe(listener: () => void): () => void;
  refresh(): void;
}
