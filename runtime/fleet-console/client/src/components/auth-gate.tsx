export function AuthGate() {
  return (
    <main className="stage">
      <div className="stage-idle">
        <p className="stage-idle-mark" aria-hidden="true">◌</p>
        <h2>Observer token required</h2>
        <p>
          Open this page through <code>fleet-gateway console</code> so the gateway can hand the
          observer token to this session.
        </p>
      </div>
    </main>
  );
}
