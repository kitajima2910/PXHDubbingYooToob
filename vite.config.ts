import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "popup.html"),
        content: resolve(__dirname, "src/extension/content.ts"),
        background: resolve(__dirname, "src/extension/background.ts"),
        "page-bridge": resolve(__dirname, "src/extension/youtube/page-bridge.ts"),
        offscreen: resolve(__dirname, "offscreen.html"),
      },
      output: {
        entryFileNames: (chunk) => ["content", "background", "page-bridge"].includes(chunk.name) ? `${chunk.name}.js` : "assets/[name]-[hash].js",
      },
    },
  },
});
