import type { ObjectiveResult } from "../shared/results.js";

type EvidenceResult = Extract<ObjectiveResult, { kind: "evidence" }>;

/** 파일은 목표·결과물 id 로 받는다. 같은 결과물의 증거가 새 복사본으로 교체되면 evidenceId 가 바뀌므로 그 값을 버전으로 붙여
 *  이미 그려진 썸네일·열린 보기가 옛 파일을 붙들지 않게 한다(서버는 v 를 권한에 쓰지 않고 그 결과물의 현재 파일만 준다). */
export const resultFileUrl = (objectiveId: string, result: Pick<EvidenceResult, "id" | "evidenceId">) => `/api/v1/objectives/result/file?objectiveId=${encodeURIComponent(objectiveId)}&resultId=${encodeURIComponent(result.id)}&v=${encodeURIComponent(result.evidenceId)}`;

/** 브리핑 첨부 이미지 URL — id 로 받아 온다. 경로는 브라우저에 오지 않는다. */
export const attachmentFileUrl = (objectiveId: string, attachmentId: string) =>
  `/api/v1/objectives/attachment/file?objectiveId=${encodeURIComponent(objectiveId)}&attachmentId=${encodeURIComponent(attachmentId)}`;

/** 공유 폴더 파일 URL — 증거 파일(`resultFileUrl`)과 같은 상대 경로·같은 인증 경로를 탄다. download 는 attachment 로 받는다. */
export const sharedFileUrl = (objectiveId: string, path: string, download = false) =>
  `/api/v1/objectives/shared/file?objectiveId=${encodeURIComponent(objectiveId)}&path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;

export const sharedListUrl = (objectiveId: string) => `/api/v1/objectives/shared/list?objectiveId=${encodeURIComponent(objectiveId)}`;
