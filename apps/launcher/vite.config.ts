import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { randomBytes } from "node:crypto";

const developmentNonce = randomBytes(18).toString("base64");

export default defineConfig({
  plugins: [react(), { name: "development-csp", apply: "serve", transformIndexHtml(html) { return html.replace("script-src 'self'", "script-src 'self' 'nonce-" + developmentNonce + "'"); } }],
  html: { cspNonce: developmentNonce },
  root: "./",
  base: "./",
  build: {
    outDir: "dist-renderer",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@antigravity-gemini-web/contracts": path.resolve(__dirname, "../../packages/contracts/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
  },
});

