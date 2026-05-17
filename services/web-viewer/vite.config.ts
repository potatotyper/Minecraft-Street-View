import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: __dirname,
  publicDir: false,
  build: {
    emptyOutDir: true,
    outDir: "public/build",
    sourcemap: true,
    lib: {
      entry: path.resolve(__dirname, "src/main.ts"),
      formats: ["es"],
      fileName: () => "app.js"
    },
    rollupOptions: {
      output: {
        entryFileNames: "app.js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    }
  }
});
