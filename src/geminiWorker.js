import { reviewDocumentDifferenceFromImages } from "./gemini.js";

globalThis.addEventListener("message", async (event) => {
  const { id, args } = event.data || {};
  if (!id || !args) return;
  try {
    const result = await reviewDocumentDifferenceFromImages(args);
    globalThis.postMessage({ id, ok: true, result });
  } catch (error) {
    globalThis.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : "Gemini request failed",
    });
  }
});
