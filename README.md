# LE PDF Scan

LE PDF Scan has two independent document workflows:

- **Priority scan**: sends a PDF to the existing Python/OpenCV service, then sorts pages by the selected marker colour.
- **Document compare**: compares a left reference file with a right revised file directly in the browser. It accepts PDF, PNG, JPG, and WEBP, lets users select page thumbnails independently for each file, and lets users select a separate comparison area on each pair. For PDFs with a reliable text layer, it compares extracted text and marks the exact changed fields; it falls back to image comparison only when text is unavailable or garbled. Red circles are linked to readable callouts in an annotation rail, and the result exports as one combined annotated PDF while retaining the source PDF page content.

The two workflows do not share files, jobs, or detector state. A problem with one cannot change the behaviour of the other.

For document compare page selection, click thumbnails to toggle pages, use Shift-click to select a contiguous range, or enter a range such as `1,5-8`. All pages are selected by default. When only one page is selected on one side, it is compared against every selected page on the other side. Otherwise, the shorter page selection is distributed in document order across the longer selection so every selected page is compared.

## Gemini scan

Document compare can optionally use `gemini-3.1-flash-lite`. When enabled, Gemini reviews the selected left/right areas as business content, even when they are in different document layouts, and writes a clean Thai summary. Gemini's `changes[].box` values are the sole source of red circles in this mode, so its confirmed semantic findings and markers always stay together. Extracted PDF text differences are passed to Gemini as evidence, so it can verify exact values such as a missing suffix rather than relying only on pixels. Pixel comparison remains available only when a reliable text layer is not available.

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
