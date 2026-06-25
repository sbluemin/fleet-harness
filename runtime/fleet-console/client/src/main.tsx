import "@fontsource-variable/fraunces";
import "@fontsource-variable/fraunces/standard-italic.css";
import "@fontsource-variable/manrope";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/cascadia-code";
import "@fontsource-variable/fira-code";
import "@fontsource-variable/source-code-pro";
import "./styles/theme.css";
import "./styles/layout.css";
import "./styles/components.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./app.js";
import { initThemeFromStorage } from "./store.js";

initThemeFromStorage();

const app = document.querySelector("#app");
if (app) {
  createRoot(app).render(
    <StrictMode>
      <BrowserRouter basename="/console">
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
}
