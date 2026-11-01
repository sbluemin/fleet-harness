import { z } from "zod";

/**
 * 사령관 사이드바 섹션 배치 — 좌측 목록 한 줄(사령관 또는 TaskForce)의 소속을 기억한다.
 * `membership` 키와 `move`·`create` 명령의 행 id는 사령관 UUID와 TF UUID를 함께 받는다
 * (둘 다 UUID 모양이라 판정은 같다). 알 수 없는 id는 읽을 때 정리된다.
 */
export const COMMODORE_SIDEBAR_CHANNEL = "commodore-sidebar";
export const MAX_SIDEBAR_SECTIONS = 100;
export const MAX_SIDEBAR_SECTION_NAME = 80;
const uuid = z.string().uuid();
const sectionName = z.string().trim().min(1).max(MAX_SIDEBAR_SECTION_NAME);
const sectionSchema = z.object({ id: uuid, name: sectionName, collapsed: z.boolean() }).strict();
const layoutSchema = z.object({
  sections: z.array(sectionSchema).max(MAX_SIDEBAR_SECTIONS),
  membership: z.record(uuid, uuid),
  unsectionedCollapsed: z.boolean(),
}).strict();
export type CommodoreSidebarSection = z.infer<typeof sectionSchema>;
export type CommodoreSidebarLayout = z.infer<typeof layoutSchema>;
export const EMPTY_SIDEBAR_LAYOUT: CommodoreSidebarLayout = { sections: [], membership: {}, unsectionedCollapsed: false };

export function sanitizeCommodoreSidebarLayout(value: unknown, knownIds?: ReadonlySet<string>): CommodoreSidebarLayout {
  const parsed = layoutSchema.safeParse(value);
  if (!parsed.success) return EMPTY_SIDEBAR_LAYOUT;
  const seen = new Set<string>();
  const sections = parsed.data.sections.filter((section) => {
    if (seen.has(section.id)) return false;
    seen.add(section.id);
    return true;
  });
  const membership = Object.fromEntries(Object.entries(parsed.data.membership)
    .filter(([id, sectionId]) => seen.has(sectionId) && (!knownIds || knownIds.has(id))));
  return { sections, membership, unsectionedCollapsed: parsed.data.unsectionedCollapsed };
}

export function withoutSidebarCommodore(layout: CommodoreSidebarLayout, commodoreId: string): CommodoreSidebarLayout {
  return { ...layout, membership: Object.fromEntries(Object.entries(layout.membership).filter(([id]) => id !== commodoreId)) };
}

export const commodoreSidebarCommandSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), name: sectionName, afterId: uuid.optional(), rowId: uuid.optional() }).strict(),
  z.object({ op: z.literal("rename"), sectionId: uuid, name: sectionName }).strict(),
  z.object({ op: z.literal("reorder"), sectionId: uuid, direction: z.enum(["up", "down"]) }).strict(),
  z.object({ op: z.literal("collapse"), sectionId: uuid.nullable(), collapsed: z.boolean() }).strict(),
  z.object({ op: z.literal("delete"), sectionId: uuid, confirm: z.literal(true) }).strict(),
  // 행 드롭은 이웃을, 제목 드롭은 섹션 끝을 지정한다. 다른 창의 전체 순서를 덮어쓰지 않는다.
  // rowId/targetId 자리에는 사령관 또는 TF의 행 id가 든다. 라우터의 사령관 판정과 헷갈리지 않게
  // 이름이 다르다 — 행 판정은 호스트의 sidebar assert가 맡는다.
  z.object({ op: z.literal("move"), rowId: uuid, sectionId: uuid.nullable(), targetId: uuid.optional(), after: z.boolean().optional() }).strict(),
]);
export type CommodoreSidebarCommand = z.infer<typeof commodoreSidebarCommandSchema>;
