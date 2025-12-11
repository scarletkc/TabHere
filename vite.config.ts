import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background.ts"),
        content: resolve(__dirname, "src/content.ts"),
        options: resolve(__dirname, "src/options/options.html")
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === "options") {
            return "options/options.js";
          }
          return "[name].js";
        },
        chunkFileNames: "chunks/[name].js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith(".css")) {
            return "options/[name][extname]";
          }
          return "[name][extname]";
        }
      }
    }
  }
});

