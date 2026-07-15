import { createIcons, icons } from "lucide";
import JSZip from "jszip";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerSource from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { reviewDocumentDifference } from "./gemini.js";

GlobalWorkerOptions.workerSrc = pdfWorkerSource;

const MAX_RENDER_EDGE = 1800;
const MIN_COMPONENT_PIXELS = 24;

export function createDocumentCompare(root) {
  const state = {
    leftSource: null,
    rightSource: null,
    leftFile: null,
    rightFile: null,
    loadingSides: { left: false, right: false },
    processing: false,
    compareToken: 0,
    loadTokens: { left: 0, right: 0 },
    results: [],
    selectedPage: null,
    previewUrl: null,
  };

  root.innerHTML = `
    <section class="workspace compare-workspace">
      <aside class="control-panel compare-controls">
        <div class="compare-drop-grid">
          <label class="drop-zone compact" id="compareLeftDropZone">
            <input id="compareLeftInput" type="file" accept="application/pdf,image/png,image/jpeg,image/webp,.pdf,.png,.jpg,.jpeg,.webp" />
            <i data-lucide="file-input"></i>
            <span class="drop-title">ต้นฉบับ</span>
            <span class="drop-subtitle" id="compareLeftMeta">PDF หรือภาพ</span>
          </label>
          <label class="drop-zone compact" id="compareRightDropZone">
            <input id="compareRightInput" type="file" accept="application/pdf,image/png,image/jpeg,image/webp,.pdf,.png,.jpg,.jpeg,.webp" />
            <i data-lucide="file-output"></i>
            <span class="drop-title">ฉบับเปรียบเทียบ</span>
            <span class="drop-subtitle" id="compareRightMeta">PDF หรือภาพ</span>
          </label>
        </div>

        <div class="field-stack">
          <div class="compare-page-fields">
            <label><span>หน้าเริ่ม</span><input id="compareStartPage" type="number" min="1" value="1" /></label>
            <label><span>หน้าสิ้นสุด</span><input id="compareEndPage" type="number" min="1" value="" /></label>
          </div>
          <div class="gemini-settings">
            <label class="check-row">
              <input id="compareUseGemini" type="checkbox" />
              <span>Gemini scan</span>
            </label>
            <label class="gemini-key-field">
              <span>Gemini API key</span>
              <input id="compareGeminiKey" type="password" autocomplete="off" placeholder="Vercel environment เมื่อเว้นว่าง" />
            </label>
          </div>
        </div>

        <div class="actions">
          <button class="primary" id="compareRunButton" disabled><i data-lucide="scan-search"></i><span>เปรียบเทียบ</span></button>
          <button id="compareResetButton"><i data-lucide="rotate-ccw"></i><span>รีเซ็ต</span></button>
        </div>

        <div class="progress-wrap idle" id="compareProgressWrap">
          <div class="progress-label"><span id="compareProgressText">เลือกเอกสารสองไฟล์</span><span id="compareProgressCount" class="progress-count"></span></div>
          <div class="progress-track"><div id="compareProgressBar"></div></div>
        </div>

        <div class="download-panel" id="compareDownloadPanel" hidden>
          <button class="download-link" id="compareDownloadZip"><i data-lucide="archive"></i><span>ภาพจุดต่างทั้งหมด</span></button>
        </div>
      </aside>

      <section class="result-panel compare-results">
        <div class="result-header">
          <div>
            <p class="eyebrow">Document compare</p>
            <h2>จุดต่างระหว่างเอกสาร</h2>
          </div>
          <div class="metric-strip">
            <div><strong id="comparePageCount">0</strong><span>หน้าที่เทียบ</span></div>
            <div><strong id="compareChangedPageCount">0</strong><span>หน้าที่ต่าง</span></div>
            <div><strong id="compareDifferenceCount">0</strong><span>จุดต่าง</span></div>
          </div>
        </div>
        <div class="compare-result-body">
          <div class="table-frame compare-table-frame">
            <table>
              <thead><tr><th>Page</th><th>Difference</th><th>Gemini</th></tr></thead>
              <tbody id="compareResultBody"><tr><td colspan="3" class="empty-cell">ผลลัพธ์จะแสดงหลังเปรียบเทียบเอกสาร</td></tr></tbody>
            </table>
          </div>
          <div class="compare-preview-panel">
            <div class="preview-heading">
              <div><p class="eyebrow">Preview</p><h3 id="comparePreviewTitle">ภาพผลลัพธ์</h3></div>
              <button class="icon-button" id="compareDownloadCurrent" type="button" title="ดาวน์โหลดภาพหน้านี้" disabled><i data-lucide="download"></i></button>
            </div>
            <div class="preview-canvas-wrap">
              <img id="comparePreviewImage" alt="ภาพเอกสารที่วงจุดต่างสีแดง" hidden />
              <div id="comparePreviewEmpty" class="preview-empty">เลือกหน้าที่พบจุดต่างเพื่อดูภาพ</div>
            </div>
          </div>
        </div>
      </section>
    </section>
  `;

  const els = {
    leftInput: root.querySelector("#compareLeftInput"),
    rightInput: root.querySelector("#compareRightInput"),
    leftDropZone: root.querySelector("#compareLeftDropZone"),
    rightDropZone: root.querySelector("#compareRightDropZone"),
    leftMeta: root.querySelector("#compareLeftMeta"),
    rightMeta: root.querySelector("#compareRightMeta"),
    startPage: root.querySelector("#compareStartPage"),
    endPage: root.querySelector("#compareEndPage"),
    useGemini: root.querySelector("#compareUseGemini"),
    geminiKey: root.querySelector("#compareGeminiKey"),
    runButton: root.querySelector("#compareRunButton"),
    resetButton: root.querySelector("#compareResetButton"),
    progressWrap: root.querySelector("#compareProgressWrap"),
    progressText: root.querySelector("#compareProgressText"),
    progressCount: root.querySelector("#compareProgressCount"),
    progressBar: root.querySelector("#compareProgressBar"),
    downloadPanel: root.querySelector("#compareDownloadPanel"),
    downloadZip: root.querySelector("#compareDownloadZip"),
    resultBody: root.querySelector("#compareResultBody"),
    pageCount: root.querySelector("#comparePageCount"),
    changedPageCount: root.querySelector("#compareChangedPageCount"),
    differenceCount: root.querySelector("#compareDifferenceCount"),
    previewTitle: root.querySelector("#comparePreviewTitle"),
    previewImage: root.querySelector("#comparePreviewImage"),
    previewEmpty: root.querySelector("#comparePreviewEmpty"),
    downloadCurrent: root.querySelector("#compareDownloadCurrent"),
  };

  restoreGeminiKey();
  bindFileZone("left");
  bindFileZone("right");
  els.runButton.addEventListener("click", runComparison);
  els.resetButton.addEventListener("click", resetComparison);
  els.downloadZip.addEventListener("click", downloadAllDifferences);
  els.downloadCurrent.addEventListener("click", downloadCurrentDifference);
  els.resultBody.addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-page]");
    if (row) selectResult(Number(row.dataset.page));
  });
  els.geminiKey.addEventListener("input", persistGeminiKey);
  createIcons({ icons });

  function bindFileZone(side) {
    const input = side === "left" ? els.leftInput : els.rightInput;
    const dropZone = side === "left" ? els.leftDropZone : els.rightDropZone;
    input.addEventListener("change", async (event) => {
      const [file] = event.target.files;
      if (file) await loadFile(side, file);
    });
    dropZone.addEventListener("dragover", (event) => {
      event.preventDefault();
      dropZone.classList.add("dragging");
    });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragging"));
    dropZone.addEventListener("drop", async (event) => {
      event.preventDefault();
      dropZone.classList.remove("dragging");
      const [file] = event.dataTransfer.files;
      if (isSupportedDocument(file)) await loadFile(side, file);
    });
  }

  async function loadFile(side, file) {
    if (!isSupportedDocument(file)) {
      setProgressIdle("รองรับ PDF, PNG, JPG และ WEBP เท่านั้น");
      return;
    }
    const fileToken = state.loadTokens[side] + 1;
    state.loadTokens[side] = fileToken;
    state.loadingSides[side] = true;
    clearResults();
    setFileMeta(side, `${file.name} - ${formatBytes(file.size)} - กำลังอ่าน`);
    setProgressIdle("กำลังอ่านเอกสาร");
    updateButtons();

    try {
      const source = await openDocumentSource(file);
      if (fileToken !== state.loadTokens[side]) {
        source.close();
        return;
      }
      const key = `${side}Source`;
      state[key]?.close();
      state[key] = source;
      state[`${side}File`] = file;
      setFileMeta(side, `${file.name} - ${formatBytes(file.size)} - ${source.pageCount} หน้า`);
      updatePageRange();
    } catch (error) {
      setFileMeta(side, `${file.name} - อ่านไฟล์ไม่สำเร็จ`);
      setProgressIdle(error.message || "อ่านเอกสารไม่สำเร็จ");
    } finally {
      if (fileToken === state.loadTokens[side]) {
        state.loadingSides[side] = false;
        updateButtons();
      }
    }
  }

  function updatePageRange() {
    const sharedPages = getSharedPageCount();
    if (!sharedPages) return;
    els.startPage.value = "1";
    els.endPage.value = String(sharedPages);
    els.startPage.max = String(sharedPages);
    els.endPage.max = String(sharedPages);
    const leftPages = state.leftSource?.pageCount || 0;
    const rightPages = state.rightSource?.pageCount || 0;
    const suffix = leftPages === rightPages ? `${sharedPages} หน้าพร้อมเปรียบเทียบ` : `เทียบได้ ${sharedPages} หน้า`;
    setProgressIdle(suffix);
  }

  function resetComparison() {
    state.compareToken += 1;
    state.loadTokens.left += 1;
    state.loadTokens.right += 1;
    state.leftSource?.close();
    state.rightSource?.close();
    state.leftSource = null;
    state.rightSource = null;
    state.leftFile = null;
    state.rightFile = null;
    state.loadingSides.left = false;
    state.loadingSides.right = false;
    state.processing = false;
    els.leftInput.value = "";
    els.rightInput.value = "";
    els.leftMeta.textContent = "PDF หรือภาพ";
    els.rightMeta.textContent = "PDF หรือภาพ";
    els.startPage.value = "1";
    els.endPage.value = "";
    els.startPage.removeAttribute("max");
    els.endPage.removeAttribute("max");
    clearResults();
    setProgressIdle("เลือกเอกสารสองไฟล์");
    updateButtons();
  }

  async function runComparison() {
    if (state.processing || !state.leftSource || !state.rightSource) return;
    const startPage = Number.parseInt(els.startPage.value, 10);
    const endPage = Number.parseInt(els.endPage.value, 10);
    const sharedPages = getSharedPageCount();
    try {
      validateRange(startPage, endPage, sharedPages);
    } catch (error) {
      setProgressIdle(error.message);
      return;
    }

    const useGemini = els.useGemini.checked;
    const apiKey = els.geminiKey.value.trim();
    const comparisonToken = state.compareToken + 1;
    state.compareToken = comparisonToken;
    state.processing = true;
    clearResults();
    updateButtons();
    const total = endPage - startPage + 1;
    const rows = [];

    try {
      for (let page = startPage; page <= endPage; page += 1) {
        if (comparisonToken !== state.compareToken) return;
        const completed = page - startPage;
        setProgressValue(`กำลังเทียบหน้า ${page}`, completed, total);
        const [leftCanvas, rightCanvas] = await Promise.all([
          state.leftSource.renderPage(page),
          state.rightSource.renderPage(page),
        ]);
        const comparison = comparePageCanvases(leftCanvas, rightCanvas);
        let boxes = comparison.boxes;
        let gemini = null;
        if (useGemini) {
          setProgressValue(`Gemini ตรวจทานหน้า ${page}`, completed, total);
          try {
            gemini = await reviewDocumentDifference({
              leftCanvas: comparison.referenceCanvas,
              rightCanvas: comparison.comparisonCanvas,
              page,
              apiKey,
            });
            boxes = mergeBoxes(
              [...boxes, ...geminiReviewBoxes(gemini, comparison.comparisonCanvas.width, comparison.comparisonCanvas.height)],
              Math.max(16, Math.round(comparison.comparisonCanvas.width * 0.013)),
            );
          } catch (error) {
            gemini = { error: error.message || "Gemini review failed." };
          }
        }
        const imageBlob = boxes.length
          ? await canvasToBlob(drawDifferenceMarkers(comparison.comparisonCanvas, boxes))
          : null;
        rows.push({
          page,
          boxes,
          imageBlob,
          gemini,
        });
        state.results = rows;
        renderResults();
        if (!state.selectedPage && imageBlob) selectResult(page);
        setProgressValue(`เทียบหน้า ${page} แล้ว`, page - startPage + 1, total);
      }
      if (comparisonToken === state.compareToken) {
        const changedPages = rows.filter((row) => row.boxes.length).length;
        setProgressDone(changedPages ? `พบจุดต่าง ${changedPages} หน้า` : "ไม่พบจุดต่าง");
      }
    } catch (error) {
      if (comparisonToken === state.compareToken) setProgressIdle(error.message || "เปรียบเทียบไม่สำเร็จ");
    } finally {
      if (comparisonToken === state.compareToken) {
        state.processing = false;
        updateButtons();
      }
    }
  }

  function clearResults() {
    state.results = [];
    state.selectedPage = null;
    revokePreviewUrl();
    els.downloadPanel.hidden = true;
    els.pageCount.textContent = "0";
    els.changedPageCount.textContent = "0";
    els.differenceCount.textContent = "0";
    els.resultBody.innerHTML = '<tr><td colspan="3" class="empty-cell">ผลลัพธ์จะแสดงหลังเปรียบเทียบเอกสาร</td></tr>';
    els.previewTitle.textContent = "ภาพผลลัพธ์";
    els.previewImage.hidden = true;
    els.previewImage.removeAttribute("src");
    els.previewEmpty.hidden = false;
    els.previewEmpty.textContent = "เลือกหน้าที่พบจุดต่างเพื่อดูภาพ";
    els.downloadCurrent.disabled = true;
  }

  function renderResults() {
    const changedRows = state.results.filter((row) => row.boxes.length);
    els.pageCount.textContent = state.results.length;
    els.changedPageCount.textContent = changedRows.length;
    els.differenceCount.textContent = state.results.reduce((sum, row) => sum + row.boxes.length, 0);
    els.downloadPanel.hidden = !changedRows.length;
    if (!state.results.length) return;
    els.resultBody.innerHTML = state.results.map((row) => {
      const geminiText = row.gemini?.error
        ? "ตรวจไม่สำเร็จ"
        : row.gemini?.summary || (els.useGemini.checked && row.boxes.length ? "กำลังตรวจ" : "-");
      return `
        <tr data-page="${row.page}" class="${state.selectedPage === row.page ? "selected" : ""}">
          <td>${row.page}</td>
          <td><span class="difference-status ${row.boxes.length ? "has-difference" : "no-difference"}">${row.boxes.length ? `พบ ${row.boxes.length} จุด` : "ไม่พบ"}</span></td>
          <td class="gemini-summary">${escapeHtml(geminiText)}</td>
        </tr>
      `;
    }).join("");
  }

  function selectResult(page) {
    const row = state.results.find((result) => result.page === page);
    if (!row) return;
    state.selectedPage = page;
    renderResults();
    revokePreviewUrl();
    els.previewTitle.textContent = `หน้า ${page}`;
    if (!row.imageBlob) {
      els.previewImage.hidden = true;
      els.previewEmpty.hidden = false;
      els.previewEmpty.textContent = "ไม่พบจุดต่างในหน้านี้";
      els.downloadCurrent.disabled = true;
      return;
    }
    state.previewUrl = URL.createObjectURL(row.imageBlob);
    els.previewImage.src = state.previewUrl;
    els.previewImage.hidden = false;
    els.previewEmpty.hidden = true;
    els.downloadCurrent.disabled = false;
  }

  async function downloadAllDifferences() {
    const rows = state.results.filter((row) => row.imageBlob);
    if (!rows.length) return;
    els.downloadZip.disabled = true;
    try {
      const zip = new JSZip();
      rows.forEach((row) => {
        zip.file(`difference_page_${String(row.page).padStart(3, "0")}.png`, row.imageBlob);
      });
      zip.file("comparison-summary.csv", buildSummaryCsv(state.results));
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
      triggerDownload(blob, "document-differences.zip");
    } finally {
      els.downloadZip.disabled = false;
    }
  }

  function downloadCurrentDifference() {
    const row = state.results.find((result) => result.page === state.selectedPage);
    if (row?.imageBlob) triggerDownload(row.imageBlob, `difference_page_${String(row.page).padStart(3, "0")}.png`);
  }

  function updateButtons() {
    els.runButton.disabled = state.processing || state.loadingSides.left || state.loadingSides.right || !state.leftSource || !state.rightSource;
  }

  function getSharedPageCount() {
    return Math.min(state.leftSource?.pageCount || 0, state.rightSource?.pageCount || 0);
  }

  function setFileMeta(side, text) {
    (side === "left" ? els.leftMeta : els.rightMeta).textContent = text;
  }

  function setProgressIdle(text) {
    els.progressWrap.className = "progress-wrap idle";
    els.progressText.textContent = text;
    els.progressCount.textContent = "";
    els.progressBar.style.width = "0%";
  }

  function setProgressValue(text, completed, total) {
    const percent = total ? Math.max(0, Math.min(100, (completed / total) * 100)) : 0;
    els.progressWrap.className = "progress-wrap loading";
    els.progressText.textContent = text;
    els.progressCount.textContent = total ? `${completed}/${total} หน้า (${Math.round(percent)}%)` : "";
    els.progressBar.style.width = `${percent}%`;
  }

  function setProgressDone(text) {
    els.progressWrap.className = "progress-wrap done";
    els.progressText.textContent = text;
    els.progressCount.textContent = "100%";
    els.progressBar.style.width = "100%";
  }

  function restoreGeminiKey() {
    try {
      els.geminiKey.value = sessionStorage.getItem("le-pdfscan-gemini-key") || "";
    } catch {
      // Storage may be unavailable in private browser contexts.
    }
  }

  function persistGeminiKey() {
    try {
      sessionStorage.setItem("le-pdfscan-gemini-key", els.geminiKey.value);
    } catch {
      // The current tab can still use the key when session storage is unavailable.
    }
  }

  function revokePreviewUrl() {
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = null;
  }
}

async function openDocumentSource(file) {
  if (isPdf(file)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const loadingTask = getDocument({ data: bytes });
    const pdf = await loadingTask.promise;
    return {
      pageCount: pdf.numPages,
      renderPage: async (pageNumber) => renderPdfPage(pdf, pageNumber),
      close: () => pdf.destroy(),
    };
  }
  return {
    pageCount: 1,
    renderPage: async () => renderImageFile(file),
    close: () => {},
  };
}

async function renderPdfPage(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(2.5, Math.max(1, MAX_RENDER_EDGE / Math.max(baseViewport.width, baseViewport.height)));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  page.cleanup();
  return canvas;
}

async function renderImageFile(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_RENDER_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas;
}

function comparePageCanvases(leftCanvas, rightCanvas) {
  const { referenceCanvas, comparisonCanvas } = normalizePair(leftCanvas, rightCanvas);
  const offset = findBestTranslation(referenceCanvas, comparisonCanvas);
  const alignedComparison = translateCanvas(comparisonCanvas, offset.x, offset.y);
  const boxes = findDifferenceBoxes(referenceCanvas, alignedComparison);
  return { referenceCanvas, comparisonCanvas: alignedComparison, boxes };
}

function geminiReviewBoxes(review, width, height) {
  if (!Array.isArray(review?.changes)) return [];
  return review.changes.map((change) => {
    const box = change?.box || change?.bounds;
    if (!box) return null;
    const x = Number(box.x);
    const y = Number(box.y);
    const boxWidth = Number(box.width);
    const boxHeight = Number(box.height);
    if (![x, y, boxWidth, boxHeight].every(Number.isFinite) || boxWidth <= 0 || boxHeight <= 0) return null;
    const left = clamp(Math.round((x / 1000) * width), 0, width - 1);
    const top = clamp(Math.round((y / 1000) * height), 0, height - 1);
    const right = clamp(Math.round(((x + boxWidth) / 1000) * width), left + 1, width);
    const bottom = clamp(Math.round(((y + boxHeight) / 1000) * height), top + 1, height);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }).filter(Boolean);
}

function normalizePair(leftCanvas, rightCanvas) {
  const referenceCanvas = cloneCanvas(leftCanvas);
  if (Math.abs(leftCanvas.width - rightCanvas.width) <= 3 && Math.abs(leftCanvas.height - rightCanvas.height) <= 3) {
    const comparisonCanvas = document.createElement("canvas");
    comparisonCanvas.width = referenceCanvas.width;
    comparisonCanvas.height = referenceCanvas.height;
    const context = comparisonCanvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, comparisonCanvas.width, comparisonCanvas.height);
    context.drawImage(rightCanvas, 0, 0, comparisonCanvas.width, comparisonCanvas.height);
    return { referenceCanvas, comparisonCanvas };
  }

  const leftBounds = findInkBounds(leftCanvas) || { x: 0, y: 0, width: leftCanvas.width, height: leftCanvas.height };
  const rightBounds = findInkBounds(rightCanvas) || { x: 0, y: 0, width: rightCanvas.width, height: rightCanvas.height };
  const scaleX = leftBounds.width / Math.max(1, rightBounds.width);
  const scaleY = leftBounds.height / Math.max(1, rightBounds.height);
  const comparisonCanvas = document.createElement("canvas");
  comparisonCanvas.width = referenceCanvas.width;
  comparisonCanvas.height = referenceCanvas.height;
  const context = comparisonCanvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, comparisonCanvas.width, comparisonCanvas.height);
  context.drawImage(
    rightCanvas,
    leftBounds.x - rightBounds.x * scaleX,
    leftBounds.y - rightBounds.y * scaleY,
    rightCanvas.width * scaleX,
    rightCanvas.height * scaleY,
  );
  return { referenceCanvas, comparisonCanvas };
}

function findInkBounds(canvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 3) {
    for (let x = 0; x < width; x += 3) {
      const index = (y * width + x) * 4;
      const luminance = (data[index] * 0.2126) + (data[index + 1] * 0.7152) + (data[index + 2] * 0.0722);
      if (luminance < 236) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  const padding = Math.max(4, Math.round(Math.min(width, height) * 0.008));
  return {
    x: Math.max(0, minX - padding),
    y: Math.max(0, minY - padding),
    width: Math.min(width, maxX + padding + 1) - Math.max(0, minX - padding),
    height: Math.min(height, maxY + padding + 1) - Math.max(0, minY - padding),
  };
}

function findBestTranslation(referenceCanvas, comparisonCanvas) {
  const targetWidth = Math.min(360, referenceCanvas.width);
  const targetHeight = Math.max(1, Math.round(referenceCanvas.height * (targetWidth / referenceCanvas.width)));
  const reference = toInkMap(referenceCanvas, targetWidth, targetHeight);
  const comparison = toInkMap(comparisonCanvas, targetWidth, targetHeight);
  let best = { x: 0, y: 0, score: Number.POSITIVE_INFINITY };
  const radius = 7;
  for (let y = -radius; y <= radius; y += 1) {
    for (let x = -radius; x <= radius; x += 1) {
      const score = translationScore(reference, comparison, targetWidth, targetHeight, x, y);
      if (score < best.score) best = { x, y, score };
    }
  }
  return {
    x: Math.round(best.x * (referenceCanvas.width / targetWidth)),
    y: Math.round(best.y * (referenceCanvas.height / targetHeight)),
  };
}

function toInkMap(canvas, width, height) {
  const small = document.createElement("canvas");
  small.width = width;
  small.height = height;
  const context = small.getContext("2d", { willReadFrequently: true });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(canvas, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  const map = new Uint8Array(width * height);
  for (let index = 0, pixel = 0; index < map.length; index += 1, pixel += 4) {
    const luminance = (data[pixel] * 0.2126) + (data[pixel + 1] * 0.7152) + (data[pixel + 2] * 0.0722);
    map[index] = luminance < 218 ? 1 : 0;
  }
  return map;
}

function translationScore(reference, comparison, width, height, shiftX, shiftY) {
  let mismatch = 0;
  let samples = 0;
  const border = 10;
  for (let y = border; y < height - border; y += 2) {
    const comparedY = y - shiftY;
    if (comparedY < 0 || comparedY >= height) continue;
    for (let x = border; x < width - border; x += 2) {
      const comparedX = x - shiftX;
      if (comparedX < 0 || comparedX >= width) continue;
      const a = reference[y * width + x];
      const b = comparison[comparedY * width + comparedX];
      mismatch += a === b ? 0 : 1;
      samples += 1;
    }
  }
  return samples ? mismatch / samples : Number.POSITIVE_INFINITY;
}

function translateCanvas(source, x, y) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, x, y);
  return canvas;
}

function findDifferenceBoxes(referenceCanvas, comparisonCanvas) {
  const width = referenceCanvas.width;
  const height = referenceCanvas.height;
  const reference = referenceCanvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height).data;
  const comparison = comparisonCanvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);
  const edge = Math.max(3, Math.round(Math.min(width, height) * 0.003));
  for (let y = edge; y < height - edge; y += 1) {
    for (let x = edge; x < width - edge; x += 1) {
      const position = y * width + x;
      const pixel = position * 4;
      const redDelta = Math.abs(reference[pixel] - comparison[pixel]);
      const greenDelta = Math.abs(reference[pixel + 1] - comparison[pixel + 1]);
      const blueDelta = Math.abs(reference[pixel + 2] - comparison[pixel + 2]);
      const largestDelta = Math.max(redDelta, greenDelta, blueDelta);
      const leftInk = luminance(reference, pixel) < 232;
      const rightInk = luminance(comparison, pixel) < 232;
      if (largestDelta > 38 && (leftInk || rightInk)) mask[position] = 1;
    }
  }
  return mergeBoxes(findComponents(dilateMask(mask, width, height), width, height), Math.max(16, Math.round(width * 0.013)));
}

function luminance(data, pixel) {
  return (data[pixel] * 0.2126) + (data[pixel + 1] * 0.7152) + (data[pixel + 2] * 0.0722);
}

function dilateMask(source, width, height) {
  const result = new Uint8Array(source.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if (!source[index]) continue;
      result[index] = 1;
      result[index - 1] = 1;
      result[index + 1] = 1;
      result[index - width] = 1;
      result[index + width] = 1;
      result[index - width - 1] = 1;
      result[index - width + 1] = 1;
      result[index + width - 1] = 1;
      result[index + width + 1] = 1;
    }
  }
  return result;
}

function findComponents(mask, width, height) {
  const boxes = [];
  const queue = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    mask[start] = 0;
    let minX = start % width;
    let maxX = minX;
    let minY = Math.floor(start / width);
    let maxY = minY;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (let vertical = -1; vertical <= 1; vertical += 1) {
        const nextY = y + vertical;
        if (nextY < 0 || nextY >= height) continue;
        for (let horizontal = -1; horizontal <= 1; horizontal += 1) {
          const nextX = x + horizontal;
          if (nextX < 0 || nextX >= width || (!horizontal && !vertical)) continue;
          const next = nextY * width + nextX;
          if (!mask[next]) continue;
          mask[next] = 0;
          queue[tail++] = next;
        }
      }
    }
    const componentWidth = maxX - minX + 1;
    const componentHeight = maxY - minY + 1;
    if (tail >= MIN_COMPONENT_PIXELS && componentWidth >= 3 && componentHeight >= 3) {
      boxes.push({ x: minX, y: minY, width: componentWidth, height: componentHeight });
    }
  }
  return boxes;
}

function mergeBoxes(input, margin) {
  const boxes = input.map((box) => ({ ...box }));
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let index = 0; index < boxes.length; index += 1) {
      for (let other = index + 1; other < boxes.length; other += 1) {
        if (!boxesTouch(boxes[index], boxes[other], margin)) continue;
        boxes[index] = unionBox(boxes[index], boxes[other]);
        boxes.splice(other, 1);
        changed = true;
        break outer;
      }
    }
  }
  return boxes.sort((a, b) => a.y - b.y || a.x - b.x);
}

function boxesTouch(first, second, margin) {
  return first.x - margin <= second.x + second.width
    && first.x + first.width + margin >= second.x
    && first.y - margin <= second.y + second.height
    && first.y + first.height + margin >= second.y;
}

function unionBox(first, second) {
  const x = Math.min(first.x, second.x);
  const y = Math.min(first.y, second.y);
  return {
    x,
    y,
    width: Math.max(first.x + first.width, second.x + second.width) - x,
    height: Math.max(first.y + first.height, second.y + second.height) - y,
  };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function drawDifferenceMarkers(canvas, boxes) {
  const result = cloneCanvas(canvas);
  const context = result.getContext("2d");
  const lineWidth = Math.max(2, Math.round(Math.min(result.width, result.height) * 0.0026));
  const padding = Math.max(10, Math.round(Math.min(result.width, result.height) * 0.012));
  context.strokeStyle = "#dc2626";
  context.lineWidth = lineWidth;
  context.lineJoin = "round";
  boxes.forEach((box) => {
    const radiusX = Math.max(16, (box.width / 2) + padding);
    const radiusY = Math.max(16, (box.height / 2) + padding);
    context.beginPath();
    context.ellipse(box.x + (box.width / 2), box.y + (box.height / 2), radiusX, radiusY, 0, 0, Math.PI * 2);
    context.stroke();
  });
  return result;
}

function cloneCanvas(source) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0);
  return canvas;
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("สร้างภาพผลลัพธ์ไม่สำเร็จ"));
    }, "image/png");
  });
}

function buildSummaryCsv(rows) {
  const header = ["page", "visual_difference_count", "gemini_summary"];
  const data = rows.map((row) => [row.page, row.boxes.length, row.gemini?.summary || row.gemini?.error || ""]);
  return [header, ...data].map((line) => line.map(csvCell).join(",")).join("\n");
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function validateRange(startPage, endPage, pageCount) {
  if (!Number.isInteger(startPage) || startPage < 1) throw new Error("หน้าเริ่มต้องเป็นเลขจำนวนเต็มตั้งแต่ 1 ขึ้นไป");
  if (!Number.isInteger(endPage) || endPage < startPage) throw new Error("หน้าสิ้นสุดต้องมากกว่าหรือเท่ากับหน้าเริ่ม");
  if (endPage > pageCount) throw new Error(`ไฟล์ทั้งสองเทียบกันได้ ${pageCount} หน้า`);
}

function isSupportedDocument(file) {
  if (!file) return false;
  return isPdf(file) || /^image\/(png|jpeg|webp)$/i.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name || "");
}

function isPdf(file) {
  return file?.type === "application/pdf" || /\.pdf$/i.test(file?.name || "");
}

function formatBytes(bytes) {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
