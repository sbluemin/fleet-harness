import { React } from "@fleet-console/sdk/plugin/browser";

import type { JobView, RequestBlockView } from "./types.js";

export function RequestDetails({ job }: { readonly job: JobView }) {
  const request = job.request;
  return (
    <section className="request-details" aria-label={`Request for ${job.label ?? job.jobId}`}>
      <div className="job-overlay-head">
        <span className="job-overlay-kicker">{job.status}</span>
        <strong>{job.label ?? job.jobId}</strong>
      </div>
      {!request ? <p className="request-details-unavailable">Request unavailable for this legacy job.</p> : (
        <div className="request-details-blocks">
          {request.blocks.map((block, index) => <RequestBlock key={`${block.tag}-${index}`} block={block} />)}
          {request.additional.trim().length > 0 ? (
            <section className="request-details-block request-details-additional" aria-label="Additional request">
              <header className="request-details-block-head">
                <span className="request-details-tag">Additional</span>
                <span className="request-details-presence">residual</span>
              </header>
              <pre>{request.additional}</pre>
            </section>
          ) : null}
        </div>
      )}
    </section>
  );
}

function RequestBlock({ block }: { readonly block: RequestBlockView }) {
  const presence = block.present ? (block.body.length === 0 ? "present · empty" : "present") : (block.required ? "missing · required" : "missing · optional");
  return (
    <section className="request-details-block" aria-label={`${block.tag} ${presence}`}>
      <header className="request-details-block-head">
        <span className="request-details-tag">{block.tag}</span>
        <span className="request-details-hint">{block.hint}</span>
        <span className="request-details-required">{block.required ? "required" : "optional"}</span>
        <span className={`request-details-presence ${block.present ? "is-present" : "is-missing"}`}>{presence}</span>
      </header>
      {block.present ? <pre>{block.body}</pre> : null}
    </section>
  );
}
