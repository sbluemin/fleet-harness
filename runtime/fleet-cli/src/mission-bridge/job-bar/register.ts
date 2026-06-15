import type { JobBarState } from "./state.js";

export interface JobBarRegistrationOptions {
  readonly jobBarState: JobBarState;
}

export function subscribeJobBar(options: JobBarRegistrationOptions): () => void {
  const unsubscribe = options.jobBarState.carrierRuntime.jobs.streaming.register((event) => options.jobBarState.handleCarrierJobStreamEvent(event));

  return () => {
    unsubscribe();
    options.jobBarState.dispose();
  };
}
