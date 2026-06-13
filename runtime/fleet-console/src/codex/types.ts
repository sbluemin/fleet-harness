export interface AllowedAccessSets {
  allowedHosts: Set<string>;
  allowedOrigins: Set<string>;
  externalMode: boolean;
}
