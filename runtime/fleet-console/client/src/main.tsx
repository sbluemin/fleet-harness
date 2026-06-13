import "@fontsource-variable/fraunces";
import "@fontsource-variable/manrope";
import "@fontsource-variable/jetbrains-mono";
import "./styles/theme.css";
import "./styles/layout.css";
import "./styles/components.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.js";
import { resetForToken } from "./store.js";
import { readObserverToken } from "./token-storage.js";

const app = document.querySelector("#app");
if (app) {
  resetForToken(readObserverToken());
  createRoot(app).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
