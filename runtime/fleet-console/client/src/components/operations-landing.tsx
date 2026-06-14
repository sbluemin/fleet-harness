interface OperationsLandingProps {
  readonly creating: boolean;
  readonly error: string | null;
  readonly hasTheaters: boolean;
  readonly activeTheaterId: string | null;
}

export function OperationsLanding({ creating, error, hasTheaters, activeTheaterId }: OperationsLandingProps) {
  const title = !hasTheaters ? "Add a Theater" : activeTheaterId ? "No operations in this Theater" : "Choose a Theater";
  const copy = !hasTheaters
    ? "Use the top bar Theater control to add a project root."
    : activeTheaterId
      ? "Launch an operation from the Operations sidebar."
      : "Theater-scoped operations and carrier activity will appear here.";
  return (
    <section className="operations-landing" aria-label="Operations workspace landing">
      <div className="operations-landing-mark" aria-hidden="true" />
      <div>
        <p className="operations-landing-eyebrow">Operation</p>
        <h1>{title}</h1>
        <p>{copy}</p>
      </div>
      <p className={`operations-landing-status ${creating ? "is-live" : ""}`}>{creating ? "Launching operation" : "No terminal session selected"}</p>
      {error ? <p className="operations-landing-error">{error}</p> : null}
    </section>
  );
}
