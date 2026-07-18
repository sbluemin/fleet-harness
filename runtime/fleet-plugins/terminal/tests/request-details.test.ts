import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { RequestDetails } from "../client/agent/request-details.js";
import type { JobView } from "../client/agent/types.js";

function makeJob(): JobView {
  return {
    jobId: "job-1", tenantId: "tenant-1", label: "Task Force", status: "active", updatedAt: 1, trackOrder: ["a", "b"], tracks: {}, lastEventId: 1,
    request: {
      blocks: [
        { tag: "objective", hint: "Goal", required: true, present: true, body: "  /tmp/fake & <script>literal</script>  " },
        { tag: "constraints", hint: "Boundaries", required: false, present: false, body: "" },
        { tag: "output", hint: "Deliverable", required: false, present: true, body: "" },
      ],
      additional: "<unknown>keep & every character</unknown>",
    },
    recentEvents: [],
  };
}

describe("RequestDetails", () => {
  it("renders the contract order, presence states, and Additional exactly once per job", () => {
    const html = renderToStaticMarkup(createElement(RequestDetails, { job: makeJob() }));
    expect(html.indexOf("objective")).toBeLessThan(html.indexOf("constraints"));
    expect(html.indexOf("constraints")).toBeLessThan(html.indexOf("output"));
    expect(html).toContain("missing · optional");
    expect(html).toContain("present · empty");
    expect(html).toContain("Additional");
    expect(html.match(/class="request-details"/g)).toHaveLength(1);
  });

  it("uses React text escaping for script-shaped, ampersand, and unknown-tag request text", () => {
    const html = renderToStaticMarkup(createElement(RequestDetails, { job: makeJob() }));
    expect(html).toContain("&lt;script&gt;literal&lt;/script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&lt;unknown&gt;keep &amp; every character&lt;/unknown&gt;");
    expect(html).not.toContain("<script>");
  });

  it("omits Additional when the residual contains only whitespace", () => {
    const job = makeJob();
    const request = { ...job.request!, additional: "\n  \t" };
    const html = renderToStaticMarkup(createElement(RequestDetails, { job: { ...job, request } }));
    expect(html).not.toContain("Additional");
    expect(html).not.toContain("residual");
  });

  it("labels legacy jobs as unavailable", () => {
    const job = { ...makeJob(), request: undefined };
    expect(renderToStaticMarkup(createElement(RequestDetails, { job }))).toContain("Request unavailable for this legacy job.");
  });
});
