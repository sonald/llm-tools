import { defineConfig } from "vite";

export default defineConfig({
  publicDir: "src-tauri/icons",
  build: {
    outDir: "dist",
    emptyOutDir: true
  },
  server: {
    port: 5173,
    strictPort: true
  }
});
