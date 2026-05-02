import * as CarrierJobsServiceFacade from "../admiral/carrier-jobs/index.js";
import * as StreamingEventsFacade from "../admiral/_shared/carrier-job-events.js";
import * as JobServiceFacade from "../services/job/index.js";

export interface FleetJobServices {
  readonly archive: typeof JobServiceFacade;
  readonly carrierJobs: typeof CarrierJobsServiceFacade;
  readonly streaming: {
    readonly register: typeof StreamingEventsFacade.registerStreamHandler;
    readonly unregister: typeof StreamingEventsFacade.unregisterStreamHandler;
  };
}

const JOB_SERVICES: FleetJobServices = {
  archive: JobServiceFacade,
  carrierJobs: CarrierJobsServiceFacade,
  streaming: {
    register: StreamingEventsFacade.registerStreamHandler,
    unregister: StreamingEventsFacade.unregisterStreamHandler,
  },
};

export function createJobServices(): FleetJobServices {
  return JOB_SERVICES;
}
