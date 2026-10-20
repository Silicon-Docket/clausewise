import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createServices } from "./services.js";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";

const container = document.getElementById("root");
if (container === null) throw new Error("The page has no element with the id root.");

// Relative URLs and the page's own origin: nothing here names a host. The arrow keeps `fetch`
// bound to the window, which the browser requires.
const services = createServices({ fetch: (input, init) => window.fetch(input, init) });

createRoot(container).render(
  <StrictMode>
    <App services={services} />
  </StrictMode>,
);
