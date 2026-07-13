import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./index.css";

// OS theme → the `.dark` class the palette keys off (index.css
// @custom-variant). Without this the dark theme block is unreachable.
const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", darkMedia.matches);
applyTheme();
darkMedia.addEventListener("change", applyTheme);

const root = document.getElementById("root");
if (!root) throw new Error("index.html must provide a #root element");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
