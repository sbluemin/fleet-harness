export function AuthGate() {
  return (
    <main className="stage">
      <div className="stage-idle">
        <p className="stage-idle-mark" aria-hidden="true">◌</p>
        <h2>Console tokens required</h2>
        <p>
          Open this page through <code>fleet console</code> so the console can hand observer and
          terminal tokens to this session.
        </p>
      </div>
    </main>
  );
}
