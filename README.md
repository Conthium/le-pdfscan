# LE PDF Scan

LE PDF Scan has two independent document workflows:

- **Priority scan**: sends a PDF to the existing Python/OpenCV service, then sorts pages by the selected marker colour.
- **Document compare**: compares a left reference file with a right revised file directly in the browser. It accepts PDF, PNG, JPG, and WEBP, circles visual changes in red, and exports the changed-page images as a ZIP.

The two workflows do not share files, jobs, or detector state. A problem with one cannot change the behaviour of the other.

## Gemini scan

Document compare can optionally use `gemini-3.1-flash-lite`. When enabled, Gemini reviews each selected page pair, writes a Thai summary, and can add a red circle for a change whose location it returns confidently. Pixel comparison remains active, so the output image is still usable even when Gemini is disabled or unavailable.

The web form accepts a key for the current browser tab only. For Vercel, set `GEMINI_API_KEY` in Project Environment Variables; the `/api/gemini` function keeps that key on the server. `VITE_GEMINI_API_KEY` is supported only for the same browser-side embedding pattern as LE Pre-drawing and is intentionally left blank in `.env.example` because it becomes public in the built JavaScript.

## Local run

Install frontend dependencies:

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

To use Priority scan locally, run the existing scanner service in another terminal:

```powershell
python -m pip install -r requirements.txt
uvicorn server_scanner:app --host 127.0.0.1 --port 8000
```

For a remote scanner, set this in `.env`:

```text
VITE_SCANNER_API_URL=https://your-render-service.onrender.com
```

## Vercel

Set these environment variables in Vercel:

```text
VITE_SCANNER_API_URL=https://your-render-service.onrender.com
GEMINI_API_KEY=your_gemini_api_key
```

`Document compare` and its Gemini proxy deploy on Vercel. `Priority scan` continues to call the Python service because OpenCV/PDFium is not part of a static Vite deployment.

Build locally before publishing:

```powershell
npm run build
```
