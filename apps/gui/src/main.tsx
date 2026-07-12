import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html must provide a #root element");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
