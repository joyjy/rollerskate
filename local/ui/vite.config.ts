import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [vue()],
  base: "/console/",
  server: {
    host: "127.0.0.1",
    port: 4300,
    strictPort: true
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src")
    }
  }
});
