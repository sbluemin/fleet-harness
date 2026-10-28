/** 공유 폴더 파일 URL — 증거 파일(`resultFileUrl`)과 같은 상대 경로·같은 인증 경로를 탄다. download 는 attachment 로 받는다. */
export const sharedFileUrl = (objectiveId: string, path: string, download = false) =>
  `/api/v1/objectives/shared/file?objectiveId=${encodeURIComponent(objectiveId)}&path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;

export const sharedListUrl = (objectiveId: string) => `/api/v1/objectives/shared/list?objectiveId=${encodeURIComponent(objectiveId)}`;
