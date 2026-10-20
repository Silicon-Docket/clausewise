import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The server serves the built files from its own root, so the default base ("/") is right. The
// content security policy allows only the page's own files: nothing is inlined into the HTML, and
// no asset becomes a data: URL, so the policy never has to be loosened for the build.
const apiServer = "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: {
    // changeOrigin stays false on purpose: the server compares the Origin of a request with its
    // Host header, and a proxy that rewrites Host to the target would make every POST look like a
    // request from another site.
    proxy: {
      "/api": { target: apiServer, changeOrigin: false },
      "/healthz": { target: apiServer, changeOrigin: false },
    },
  },
});
