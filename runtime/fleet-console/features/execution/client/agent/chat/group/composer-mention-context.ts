import { createContext, useMemo, useState } from "react";

/** 보이는 그룹 입력창이 게시하는 받는 이 포트. 후보와 삽입은 composer가 소유한다. */
export interface GroupComposerMentionPort {
  readonly rootObjectiveId: string;
  readonly memberIds: readonly string[];
  readonly commanderId: string | null;
  readonly pick: (objectiveId: string) => boolean;
}

type PublishMentionPort = (port: GroupComposerMentionPort) => () => void;
export const GroupComposerMentionContext = createContext<PublishMentionPort | null>(null);

/** 같은 대화 본문이 게시한 포트만 그 대화의 머리에서 읽는다. */
export function useGroupComposerMentionHost(objectiveId: string, bodyId: string) {
  const [published, setPublished] = useState<{
    readonly objectiveId: string;
    readonly bodyId: string;
    readonly token: symbol;
    readonly port: GroupComposerMentionPort;
  } | null>(null);
  const publish = useMemo<PublishMentionPort>(() => (port) => {
    if (port.rootObjectiveId !== objectiveId) return () => undefined;
    const token = Symbol();
    setPublished({ objectiveId, bodyId, token, port });
    return () => setPublished((current) => current?.token === token ? null : current);
  }, [objectiveId, bodyId]);
  const port = published?.objectiveId === objectiveId && published.bodyId === bodyId ? published.port : null;
  return { publish, port };
}
