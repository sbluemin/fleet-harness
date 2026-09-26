import type { FollowupEvidence, Objective } from "./types.js";

export interface NearbyMatch {
  readonly objectiveId: string;
  readonly title: string;
  readonly score: number;
  readonly words: readonly string[];
  readonly paths: readonly string[];
}

type Subject = Pick<Objective, "title" | "note" | "criteria" | "origin">;
const textOf = (subject: { title: string; note: string; criteria: readonly { text: string }[] }) => [subject.title, subject.note, ...subject.criteria.map((entry) => entry.text)].join(" ").normalize("NFC").toLocaleLowerCase();
const grams = (text: string): Map<string, number> => {
  const result = new Map<string, number>();
  // 낱말 안의 인접 문자만. 공백을 넘어 우연히 닿은 글자와 한글·영문 인위 분리는 제외한다.
  for (const token of text.match(/[\p{L}\p{N}]+/gu) ?? []) for (let i = 0; i < token.length - 1; i += 1) {
    const pair = token.slice(i, i + 2);
    result.set(pair, (result.get(pair) ?? 0) + 1);
  }
  return result;
};
const wordsOf = (text: string) => new Set(text.match(/[\p{L}\p{N}]+/gu)?.filter((word) => word.length > 1) ?? []);
const pathsOf = (evidence: readonly (FollowupEvidence | { kind: string; path: string | null })[]) => new Set(evidence.flatMap((item) => "path" in item && item.path ? [item.path] : []));

/** 요청을 포함한 현재 Theater 말뭉치로 문서 빈도를 정한다. 연결 제안은 저장·완료를 막지 않는 읽기 사실이다. */
export function nearbyObjectives(
  subject: { title: string; note: string; criteria: readonly { text: string }[]; evidence?: readonly (FollowupEvidence | { kind: string; path: string | null })[] },
  objectives: readonly Objective[],
  source?: Subject & Pick<Objective, "id" | "links" | "unrelated">,
): readonly NearbyMatch[] {
  const candidates = objectives.filter((other) => !other.done && other.recorded !== false && other.id !== source?.id &&
    !source?.links?.some((link) => link.objectiveId === other.id) && !other.links?.some((link) => link.objectiveId === source?.id) &&
    !source?.unrelated?.includes(other.id) && !(source && other.unrelated?.includes(source.id)) &&
    source?.origin?.objectiveId !== other.id && other.origin?.objectiveId !== source?.id);
  const documents = [subject, ...candidates].map((entry) => grams(textOf(entry)));
  const frequency = new Map<string, number>();
  for (const doc of documents) for (const gram of doc.keys()) frequency.set(gram, (frequency.get(gram) ?? 0) + 1);
  const weight = (gram: string) => Math.log(documents.length / (frequency.get(gram) ?? documents.length));
  const norm = (doc: Map<string, number>) => Math.sqrt([...doc].reduce((sum, [gram, count]) => sum + (count * weight(gram)) ** 2, 0));
  const query = documents[0]!;
  const queryNorm = norm(query);
  const words = wordsOf(textOf(subject));
  const wordFrequency = new Map<string, number>();
  for (const entry of [subject, ...candidates]) for (const word of wordsOf(textOf(entry))) wordFrequency.set(word, (wordFrequency.get(word) ?? 0) + 1);
  const paths = pathsOf(subject.evidence ?? []);
  return candidates.map((other, at) => {
    const doc = documents[at + 1]!;
    const denominator = queryNorm * norm(doc);
    // 두 문서만 있고 본문이 같으면 모든 gram의 IDF가 0이다. 완전 중복은 숨기지 않는다.
    const rawNorm = (value: Map<string, number>) => Math.sqrt([...value.values()].reduce((sum, count) => sum + count ** 2, 0));
    const score = denominator ? [...query].reduce((sum, [gram, count]) => sum + count * (doc.get(gram) ?? 0) * weight(gram) ** 2, 0) / denominator
      : queryNorm === 0 && norm(doc) === 0 && rawNorm(query) * rawNorm(doc) > 0
        ? [...query].reduce((sum, [gram, count]) => sum + count * (doc.get(gram) ?? 0), 0) / (rawNorm(query) * rawNorm(doc)) : 0;
    const overlap = [...paths].filter((path) => pathsOf(other.origin?.evidence ?? []).has(path));
    return { other, score, paths: overlap, words: [...words].filter((word) => wordsOf(textOf(other)).has(word)).sort((a, b) => (wordFrequency.get(a) ?? 0) - (wordFrequency.get(b) ?? 0) || b.length - a.length || a.localeCompare(b)).slice(0, 4) };
  }).filter((item) => item.score >= 0.15 || item.paths.length > 0)
    .sort((a, b) => b.paths.length - a.paths.length || b.score - a.score || a.other.id.localeCompare(b.other.id))
    .slice(0, 5)
    .map(({ other, score, words: shared, paths }) => ({ objectiveId: other.id, title: other.title, score: Math.round(score * 1000) / 1000, words: shared, paths }));
}
