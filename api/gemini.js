const MODEL = "gemini-3.1-flash-lite";

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return response.status(503).json({
      error: "Gemini is not configured on this deployment.",
    });
  }

  try {
    const payload = typeof request.body === "string"
      ? JSON.parse(request.body)
      : request.body;

    if (!payload?.contents || !Array.isArray(payload.contents)) {
      return response.status(400).json({ error: "Invalid Gemini request." });
    }

    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(payload),
      },
    );
    const body = await upstream.json();
    return response.status(upstream.status).json(body);
  } catch (error) {
    return response.status(500).json({
      error: error instanceof Error ? error.message : "Gemini request failed.",
    });
  }
}
