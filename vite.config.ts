import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [{
    name: "standalone-content-script",
    generateBundle(_options, bundle) {
      const content = Object.values(bundle).find((item) => item.type === "chunk" && item.isEntry && item.name === "content");
      if (content?.type === "chunk" && content.imports.length) {
        this.error(`content.js phải standalone; đang import: ${content.imports.join(", ")}`);
      }
    },
  }],
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    modulePreload: { polyfill: false },
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
