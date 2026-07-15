const GEMINI_MODEL = "gemini-3.1-flash-lite";
const BUILD_TIME_KEY = typeof __LE_PDFSCAN_GEMINI_KEY__ === "string"
  ? __LE_PDFSCAN_GEMINI_KEY__
  : "";

export async function reviewDocumentDifference({ leftCanvas, rightCanvas, page, apiKey }) {
  const [leftImage, rightImage] = await Promise.all([
    canvasToInlineData(leftCanvas),
    canvasToInlineData(rightCanvas),
  ]);
  const payload = {
    contents: [{
      role: "user",
      parts: [
        { text: `Reference document, page ${page}.` },
        leftImage,
        { text: `Revised document, page ${page}. Compare it with the reference. Ignore rendering noise, anti-aliasing, and small scan alignment shifts. Identify only meaningful changes such as inserted, deleted, altered, or moved text, numbers, clauses, signatures, stamps, or drawings. Return JSON only in this shape: {"summary":"short Thai summary","changes":[{"location":"where on the page","description":"what changed","confidence":0.0,"box":{"x":0,"y":0,"width":0,"height":0}}]}. box is optional. When supplied, x, y, width, and height are the changed region's top-left x/y and width/height normalized from 0 to 1000 against the REVISED document image. Include a box only when its location is clear enough to circle. When there is no meaningful change, return an empty changes array.` },
        rightImage,
      ],
    }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.1,
      maxOutputTokens: 1200,
    },
  };

  const directKey = String(apiKey || BUILD_TIME_KEY || "").trim();
  const result = directKey
    ? await callGeminiDirect(payload, directKey)
    : await callGeminiProxy(payload);
  const text = result?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();

  if (!text) {
    throw new Error("Gemini did not return a review.");
  }

  try {
    return JSON.parse(stripCodeFence(text));
  } catch {
    return { summary: text, changes: [] };
  }
}

async function callGeminiDirect(payload, apiKey) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(payload),
    },
  );
  return readGeminiResponse(response);
}

async function callGeminiProxy(payload) {
  const response = await fetch("/api/gemini", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readGeminiResponse(response);
}

async function readGeminiResponse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message || body?.error || `Gemini API error ${response.status}`;
    throw new Error(message);
  }
  return body;
}

async function canvasToInlineData(canvas) {
  const compact = scaleCanvas(canvas, 1400);
  const blob = await new Promise((resolve, reject) => {
    compact.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error("Could not prepare page image for Gemini."));
    }, "image/jpeg", 0.82);
  });
  const data = await blobToBase64(blob);
  return { inlineData: { mimeType: "image/jpeg", data } };
}

function scaleCanvas(source, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
  if (scale === 1) return source;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("Could not encode image for Gemini."));
    reader.readAsDataURL(blob);
  });
}

function stripCodeFence(value) {
  return value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}
