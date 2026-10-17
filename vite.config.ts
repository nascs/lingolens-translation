import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  build: {
    target: "chrome115",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        popup: fromRoot("popup.html"),
        options: fromRoot("options.html"),
        translator: fromRoot("translator.html"),
        pdf: fromRoot("pdf.html"),
        "service-worker": fromRoot("src/background/index.ts"),
        content: fromRoot("src/content/index.ts")
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "[name][extname]"
      }
    }
  }
});
