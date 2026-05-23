export type CarrierJobsAction = "status" | "result" | "cancel" | "list";
export type CarrierJobsFormat = "summary" | "full";

export interface CarrierJobsParams {
  action: CarrierJobsAction;
  format?: CarrierJobsFormat;
  job_id?: string;
}

export interface CarrierJobsAvailability {
  summary_available: boolean;
  full_available: boolean;
  full_invalidated: boolean;
}
