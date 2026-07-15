# LE PDF Scan

LE PDF Scan has two independent document workflows:

- **Priority scan**: sends a PDF to the existing Python/OpenCV service, then sorts pages by the selected marker colour.
- **Document compare**: compares a left reference file with a right revised file directly in the browser. It accepts PDF, PNG, JPG, and WEBP, lets users select page thumbnails independently for each file, lets users select a separate comparison area on each pair, detects character-level changes from a PDF text layer when available, circles the related field in red with a numbered marker linked to a readable finding list, and exports the changed-page images as a ZIP.

The two workflows do not share files, jobs, or detector state. A problem with one cannot change the behaviour of the other.

For document compare page selection, click thumbnails to toggle pages, use Shift-click to select a contiguous range, or enter a range such as `1,5-8`. All pages are selected by default. When only one page is selected on one side, it is compared against every selected page on the other side. Otherwise, the shorter page selection is distributed in document order across the longer selection so every selected page is compared.

## Gemini scan

Document compare can optionally use `gemini-3.1-flash-lite`. When enabled, Gemini reviews the selected left/right areas as business content, even when they are in different document layouts, writes a Thai summary, and can add a red circle for a change whose location it returns confidently. Extracted PDF text differences are passed to Gemini as evidence, so it can verify exact values such as a missing suffix rather than relying only on pixels. Pixel comparison remains available for closely aligned layouts; when the selected areas have different structures, the app suppresses broad false-positive circles and uses text/Gemini locations instead.

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
