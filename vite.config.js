import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  // Vite supports JSON imports natively.
  // `stringify: false` keeps named exports available and lets tree-shaking
  // work on the topics file as it grows toward thousands of entries.
  json: {
    namedExports: true,
    stringify: false,
  },

  server: {
    port: 5173,
    open: true,
  },

  preview: {
    port: 4173,
  },

  build: {
    outDir: "dist",
    sourcemap: false,
    // topics.json is large and growing; keep it in its own chunk so the
    // app shell stays small and the content file caches independently.
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom"],
          icons: ["lucide-react"],
        },
      },
    },
  },
});
