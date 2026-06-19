import { useEffect, useState } from "react";

import { loadModelAuth, signInModel, signOutModel, useModelAuthStore } from "../model-auth-store.js";
import type { ModelAuthProviderState } from "../types.js";

interface ProviderRowProps {
  readonly provider: ModelAuthProviderState;
  readonly busy: boolean;
}

export function ModelAuthSection() {
  const store = useModelAuthStore();

  useEffect(() => {
    const controller = new AbortController();
    void loadModelAuth(controller.signal);
    return () => controller.abort();
  }, []);

  return (
    <section className="global-settings-card" aria-label="Model sign-in">
      <div className="model-auth-head">
        <p className="global-settings-resp-title">Model Sign-in</p>
        <p className="global-settings-help">
          Register a provider API key so carriers can run on that model. Keys are validated against the provider, stored
          locally, and never shown back in the browser.
        </p>
      </div>

      {store.error ? <p className="global-settings-error" role="alert">{store.error}</p> : null}
      {store.loading && !store.state ? <p className="global-settings-help">Loading sign-in state.</p> : null}

      {store.state?.providers.map((provider) => (
        <ProviderRow key={provider.cli} provider={provider} busy={store.busyCli === provider.cli} />
      ))}

      <p className="global-settings-foot">Sign-in changes apply to newly launched sessions. Running sessions keep their current credentials until relaunched.</p>
    </section>
  );
}

function ProviderRow({ provider, busy }: ProviderRowProps) {
  const [apiKey, setApiKey] = useState("");

  const handleSignIn = async () => {
    const ok = await signInModel(provider.cli, apiKey);
    if (ok) setApiKey("");
  };

  const handleSignOut = async () => {
    await signOutModel(provider.cli);
  };

  return (
    <div className="model-auth-row">
      <div className="model-auth-row-head">
        <span className="model-auth-name">{provider.displayName}</span>
        <span className={`model-auth-status ${provider.signedIn ? "is-on" : ""}`}>
          {provider.signedIn ? "Signed in" : "Not signed in"}
        </span>
      </div>

      {provider.signedIn ? (
        <div className="model-auth-actions">
          <button type="button" className="model-auth-button" disabled={busy} onClick={() => void handleSignOut()}>
            {busy ? "Working…" : "Sign out"}
          </button>
        </div>
      ) : (
        <form
          className="model-auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSignIn();
          }}
        >
          <input
            type="password"
            className="model-auth-input"
            placeholder="API key"
            value={apiKey}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            aria-label={`${provider.displayName} API key`}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <button type="submit" className="model-auth-button is-primary" disabled={busy || apiKey.trim().length === 0}>
            {busy ? "Verifying…" : "Sign in"}
          </button>
        </form>
      )}
    </div>
  );
}
