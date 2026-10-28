/** 브리핑 첨부 이미지 URL — id 로 받아 온다. 경로는 브라우저에 오지 않는다. */
export const attachmentFileUrl = (objectiveId: string, attachmentId: string) =>
  `/api/v1/objectives/attachment/file?objectiveId=${encodeURIComponent(objectiveId)}&attachmentId=${encodeURIComponent(attachmentId)}`;
