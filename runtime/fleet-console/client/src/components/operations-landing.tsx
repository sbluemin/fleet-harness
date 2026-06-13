interface OperationsLandingProps {
  readonly creating: boolean;
  readonly error: string | null;
}

export function OperationsLanding({ creating, error }: OperationsLandingProps) {
  return (
    <section className="operations-landing" aria-label="Operations workspace landing">
      <div className="operations-landing-mark" aria-hidden="true" />
      <div>
        <p className="operations-landing-eyebrow">Operations</p>
        <h1>Choose a workspace</h1>
        <p>Local terminal sessions and carrier activity will appear here.</p>
      </div>
      <p className={`operations-landing-status ${creating ? "is-live" : ""}`}>{creating ? "Opening folder picker" : "No terminal session selected"}</p>
      {error ? <p className="operations-landing-error">{error}</p> : null}
    </section>
  );
}
