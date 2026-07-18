import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("lucide")) return "icons";
          if (id.includes("pdfjs-dist")) return "pdf";
          if (id.includes("jszip")) return "zip";
        },
      },
    },
  },
});
