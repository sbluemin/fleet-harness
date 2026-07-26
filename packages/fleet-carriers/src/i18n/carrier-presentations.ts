export const CARRIER_PRESENTATION_LOCALES = ["en", "ko"] as const;

export type CarrierPresentationLocale = typeof CARRIER_PRESENTATION_LOCALES[number];

export interface CarrierPresentation {
  readonly title: string;
  readonly summary: string;
}

export type CarrierPresentationCatalog = Readonly<
  Partial<Record<CarrierPresentationLocale, CarrierPresentation>>
>;

export const CARRIER_PRESENTATIONS: Readonly<Record<string, CarrierPresentationCatalog>> = {
  nimitz: {
    ko: {
      title: "전략 지휘·판단",
      summary: "읽기 전용 전략 지휘 — 구현에 직접 손대지 않고 독트린 판단, 아키텍처 결정, 심층 분석, 트레이드오프 심판으로 기술적 경로를 정합니다. plan_ref가 주어지면 이미 작성된 Fleet Plan을 감사할 수 있습니다.",
    },
  },
  genesis: {
    ko: {
      title: "수석 엔지니어",
      summary: "전방위 구현 주력 — 기능을 구축하고 프로덕션 품질의 클린 코드를 작성하며 구조적 무결성을 끝까지 유지합니다.",
    },
  },
  sentinel: {
    ko: {
      title: "QA·보안 책임자",
      summary: "버그 헌터이자 보안 전문가 — 코드 리뷰, 결함 탐지, 품질 감사, 취약점 사냥, 침투 테스트를 냉정하게 수행합니다.",
    },
  },
  vanguard: {
    ko: {
      title: "정찰 전문가",
      summary: "읽기 전용 코드베이스 인텔리전스 — 로컬·원격 저장소를 탐색하고 심벌을 추적하며 공개 코드와 웹 소스를 조사하고 낯선 구현을 깊이 파고듭니다.",
    },
  },
};

export function resolveCarrierPresentation(
  locale: CarrierPresentationLocale,
  carrierId: string,
  canonical: CarrierPresentation,
  override?: CarrierPresentationCatalog,
): CarrierPresentation {
  const overridePresentation = override?.[locale];
  const catalogPresentation = CARRIER_PRESENTATIONS[carrierId]?.[locale];
  return {
    title: overridePresentation?.title || catalogPresentation?.title || canonical.title,
    summary: overridePresentation?.summary || catalogPresentation?.summary || canonical.summary,
  };
}
