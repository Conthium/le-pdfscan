import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    define: {
      __LE_PDFSCAN_GEMINI_KEY__: JSON.stringify(
        env.VITE_GEMINI_API_KEY || "",
      ),
    },
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
  };
});
