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

type Prepared = { readonly objective: Objective; readonly grams: Map<string, number>; readonly words: ReadonlySet<string>; readonly paths: ReadonlySet<string> };
type BoardIndex = { readonly entries: readonly Prepared[]; readonly results: WeakMap<Objective, readonly NearbyMatch[]> };
// Console 보드는 목표·관계 사건마다 새 배열로 교체된다. 배열이 사라지면 색인·결과도 함께 회수된다.
const boards = new WeakMap<readonly Objective[], BoardIndex>();
function indexBoard(objectives: readonly Objective[]): BoardIndex {
  const cached = boards.get(objectives);
  if (cached) return cached;
  const entries = objectives.map((objective) => {
    const text = textOf(objective);
    return { objective, grams: grams(text), words: wordsOf(text), paths: pathsOf(objective.origin?.evidence ?? []) };
  });
  const index = { entries, results: new WeakMap<Objective, readonly NearbyMatch[]>() };
  boards.set(objectives, index);
  return index;
}

/** 요청을 포함한 현재 Theater 말뭉치로 문서 빈도를 정한다. 연결 제안은 저장·완료를 막지 않는 읽기 사실이다. */
export function nearbyObjectives(
  subject: { title: string; note: string; criteria: readonly { text: string }[]; evidence?: readonly (FollowupEvidence | { kind: string; path: string | null })[] },
  objectives: readonly Objective[],
  source?: Subject & Pick<Objective, "id" | "links" | "unrelated">,
): readonly NearbyMatch[] {
  const board = indexBoard(objectives);
  const boardSource = board.entries.find((entry) => entry.objective === source);
  const cacheKey = source && boardSource && subject.title === source.title && subject.note === source.note && subject.criteria === source.criteria &&
    (subject.evidence === source.origin?.evidence || (!source.origin?.evidence?.length && !subject.evidence?.length)) ? boardSource : null;
  const cached = cacheKey ? board.results.get(cacheKey.objective) : undefined;
  if (cached) return cached;
  const candidates = board.entries.filter(({ objective: other }) => !other.done && other.recorded !== false && other.id !== source?.id &&
    !source?.links?.some((link) => link.objectiveId === other.id) && !other.links?.some((link) => link.objectiveId === source?.id) &&
    !source?.unrelated?.includes(other.id) && !(source && other.unrelated?.includes(source.id)) &&
    source?.origin?.objectiveId !== other.id && other.origin?.objectiveId !== source?.id);
  const queryText = cacheKey ? null : textOf(subject);
  const query = cacheKey ? cacheKey.grams : grams(queryText!);
  const words = cacheKey ? cacheKey.words : wordsOf(queryText!);
  const documents = [query, ...candidates.map((entry) => entry.grams)];
  const frequency = new Map<string, number>();
  for (const doc of documents) for (const gram of doc.keys()) frequency.set(gram, (frequency.get(gram) ?? 0) + 1);
  // 작은 보드에서도 모든 공유 gram의 가중치가 0으로 사라지지 않게 최소 IDF를 둔다.
  const weight = (gram: string) => Math.log(documents.length / (frequency.get(gram) ?? documents.length)) + 0.05;
  const norm = (doc: Map<string, number>) => Math.sqrt([...doc].reduce((sum, [gram, count]) => sum + (count * weight(gram)) ** 2, 0));
  const queryNorm = norm(query);
  const wordFrequency = new Map<string, number>();
  for (const docWords of [words, ...candidates.map((entry) => entry.words)]) for (const word of docWords) wordFrequency.set(word, (wordFrequency.get(word) ?? 0) + 1);
  const paths = pathsOf(subject.evidence ?? []);
  const result = candidates.map((entry, at) => {
    const doc = documents[at + 1]!;
    const denominator = queryNorm * norm(doc);
    const score = denominator ? [...query].reduce((sum, [gram, count]) => sum + count * (doc.get(gram) ?? 0) * weight(gram) ** 2, 0) / denominator : 0;
    const overlap = [...paths].filter((path) => entry.paths.has(path));
    return { other: entry.objective, score, paths: overlap, words: [...words].filter((word) => entry.words.has(word)).sort((a, b) => (wordFrequency.get(a) ?? 0) - (wordFrequency.get(b) ?? 0) || b.length - a.length || a.localeCompare(b)).slice(0, 4) };
  }).filter((item) => item.score >= 0.15 || item.paths.length > 0)
    .sort((a, b) => b.paths.length - a.paths.length || b.score - a.score || a.other.id.localeCompare(b.other.id))
    .slice(0, 5)
    .map(({ other, score, words: shared, paths }) => ({ objectiveId: other.id, title: other.title, score: Math.round(score * 1000) / 1000, words: shared, paths }));
  if (cacheKey) board.results.set(cacheKey.objective, result);
  return result;
}
