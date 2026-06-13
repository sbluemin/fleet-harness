import "@fontsource-variable/fraunces";
import "@fontsource-variable/manrope";
import "@fontsource-variable/jetbrains-mono";
import "./styles/theme.css";
import "./styles/layout.css";
import "./styles/components.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./app.js";
import { resetForToken } from "./store.js";
import { readConsoleTokens } from "./token-storage.js";

const app = document.querySelector("#app");
if (app) {
  const tokens = readConsoleTokens();
  resetForToken(tokens.observerToken, tokens.terminalToken);
  createRoot(app).render(
    <StrictMode>
      <BrowserRouter basename="/console">
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
}
