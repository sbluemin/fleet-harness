/** 직전 명부의 별칭만 다룬다. archive/백업은 이관 원본이 아니다. */
export interface LegacyTheaterAlias {
  readonly theaterId: string;
  readonly alias: unknown;
  readonly registered: boolean;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function legacyTheaterAliases(source: Record<string, unknown>): readonly LegacyTheaterAlias[] {
  const aliases: LegacyTheaterAlias[] = [];
  const collect = (value: unknown, registered: boolean) => {
    if (record(value) && typeof value.id === "string" && Object.hasOwn(value, "alias")) aliases.push({ theaterId: value.id, alias: value.alias, registered });
  };
  if (Array.isArray(source.theaters)) for (const theater of source.theaters) collect(theater, true);
  if (Array.isArray(source.deletionTombstones)) for (const row of source.deletionTombstones) if (record(row) && row.kind === "theater") collect(row.theater, false);
  return aliases;
}

/** 원본 순서·버전·나머지 필드와 객체를 그대로 두고 별칭 키만 제거한다. 저널에는 이 투영만 적용한다. */
export function withoutTheaterAliases(source: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const clean = (value: unknown): unknown => {
    if (!record(value) || !Object.hasOwn(value, "alias")) return value;
    changed = true;
    const { alias: _alias, ...rest } = value;
    return rest;
  };
  const theaters = Array.isArray(source.theaters) ? source.theaters.map(clean) : source.theaters;
  const deletionTombstones = Array.isArray(source.deletionTombstones) ? source.deletionTombstones.map((row) => {
    if (!record(row) || row.kind !== "theater") return row;
    const theater = clean(row.theater);
    return theater === row.theater ? row : { ...row, theater };
  }) : source.deletionTombstones;
  return changed ? { ...source, ...(Array.isArray(theaters) ? { theaters } : {}), ...(Array.isArray(deletionTombstones) ? { deletionTombstones } : {}) } : source;
}

/** 복구 중인 구 저널은 기존 해시의 입력을 유지한다. 기동이 끝나면 이 임시 사본도 정리한다. */
export function retainRegistrationAliases(source: Record<string, unknown>, normalized: Record<string, unknown>): Record<string, unknown> {
  const retain = (value: unknown, old: unknown): unknown => record(value) && record(old) && Object.hasOwn(old, "alias") ? { ...value, alias: old.alias } : value;
  const oldTheaters = Array.isArray(source.theaters) ? source.theaters : [];
  const oldDeletions = Array.isArray(source.deletionTombstones) ? source.deletionTombstones : [];
  return { ...normalized,
    theaters: Array.isArray(normalized.theaters) ? normalized.theaters.map((row) => retain(row, oldTheaters.find((old) => record(row) && record(old) && old.id === row.id))) : normalized.theaters,
    ...(Array.isArray(normalized.deletionTombstones) ? { deletionTombstones: normalized.deletionTombstones.map((row) => {
      if (!record(row) || row.kind !== "theater") return row;
      const old = oldDeletions.find((old) => record(old) && old.deletionId === row.deletionId);
      return { ...row, theater: retain(row.theater, record(old) ? old.theater : undefined) };
    }) } : {}),
  };
}
