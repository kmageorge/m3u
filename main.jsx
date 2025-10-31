import React from "react";
import { createRoot } from "react-dom/client";
import App from "./m_3_u_studio_tmdb_powered_playlist_builder.jsx";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element with id 'root' not found");
}

const root = createRoot(rootElement);
root.render(<App />);
