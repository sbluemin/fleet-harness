/** 그룹의 소유는 사령관 UUID다. Theater가 없어도 생성·조회할 수 있다. */
export interface CommodoreGroupCreateInput {
  readonly commodoreId: string;
  readonly id?: string;
  readonly name: string;
  readonly color: string;
  readonly order?: number;
}
export interface CommodoreGroupQuery { readonly commodoreId?: string }
// GET /api/v1/objectives/records/groups?commodoreId=<uuid>
// POST /api/v1/objectives/records/groups, body: CommodoreGroupCreateInput
