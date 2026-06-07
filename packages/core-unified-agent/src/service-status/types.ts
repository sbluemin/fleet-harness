import type { CliType } from '../config/CliConfigs.js';

/** 서비스 상태 프로바이더 키 */
export type ProviderKey = CliType;

/** 서비스 헬스 상태 */
export type HealthStatus =
  | 'operational'
  | 'partial_outage'
  | 'major_outage'
  | 'maintenance'
  | 'unknown';

/** 서비스 상태 스냅샷 */
export interface ServiceSnapshot {
  provider: ProviderKey;
  label: string;
  status: HealthStatus;
  matchedTarget: string;
  sourceUrl: string;
  checkedAt: number;
  note?: string;
}
