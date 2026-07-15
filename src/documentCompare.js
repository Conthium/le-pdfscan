import { createIcons, icons } from "lucide";
import JSZip from "jszip";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerSource from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { reviewDocumentDifference } from "./gemini.js";
import { buildPdfTextEvidence, createPdfTextPage, findPdfTextDifferences } from "./pdfTextDiff.js";

GlobalWorkerOptions.workerSrc = pdfWorkerSource;

const MAX_RENDER_EDGE = 1800;
const MIN_COMPONENT_PIXELS = 24;
const FULL_REGION = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });
const MIN_REGION_SIZE = 0.025;
const MAX_VISUAL_ALIGNMENT_MISMATCH = 0.065;

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
    roiPage: 1,
    roiRenderToken: 0,
    roiSelections: new Map(),
    roiDrag: null,
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

      <section class="roi-panel" id="compareRoiPanel" hidden>
        <div class="roi-toolbar">
          <div>
            <p class="eyebrow">Compare area</p>
            <h2>พื้นที่เปรียบเทียบ</h2>
          </div>
          <div class="roi-toolbar-actions">
            <button class="icon-button" id="compareRoiPrevious" type="button" title="หน้าก่อนหน้า"><i data-lucide="chevron-left"></i></button>
            <span class="roi-page-label" id="compareRoiPageLabel">หน้า -</span>
            <button class="icon-button" id="compareRoiNext" type="button" title="หน้าถัดไป"><i data-lucide="chevron-right"></i></button>
            <button class="icon-button" id="compareRoiApplyRange" type="button" title="ใช้กรอบนี้กับทุกหน้าในช่วงที่เลือก"><i data-lucide="copy"></i></button>
          </div>
        </div>
        <div class="roi-editor-grid">
          <section class="roi-document">
            <div class="roi-document-header">
              <span>ต้นฉบับ</span>
              <button class="icon-button" id="compareRoiResetLeft" type="button" title="ใช้ทั้งหน้าต้นฉบับ"><i data-lucide="maximize"></i></button>
            </div>
            <div class="roi-stage" id="compareRoiLeftStage">
              <canvas id="compareRoiLeftCanvas"></canvas>
              <div class="roi-selection default" id="compareRoiLeftSelection" data-side="left">
                <span class="roi-handle nw" data-handle="nw"></span><span class="roi-handle ne" data-handle="ne"></span>
                <span class="roi-handle sw" data-handle="sw"></span><span class="roi-handle se" data-handle="se"></span>
              </div>
            </div>
          </section>
          <section class="roi-document">
            <div class="roi-document-header">
              <span>ฉบับเปรียบเทียบ</span>
              <button class="icon-button" id="compareRoiResetRight" type="button" title="ใช้ทั้งหน้าฉบับเปรียบเทียบ"><i data-lucide="maximize"></i></button>
            </div>
            <div class="roi-stage" id="compareRoiRightStage">
              <canvas id="compareRoiRightCanvas"></canvas>
              <div class="roi-selection default" id="compareRoiRightSelection" data-side="right">
                <span class="roi-handle nw" data-handle="nw"></span><span class="roi-handle ne" data-handle="ne"></span>
                <span class="roi-handle sw" data-handle="sw"></span><span class="roi-handle se" data-handle="se"></span>
              </div>
            </div>
          </section>
        </div>
      </section>

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
              <thead><tr><th>Page</th><th>Difference</th><th>Detail</th></tr></thead>
              <tbody id="compareResultBody"><tr><td colspan="3" class="empty-cell">ผลลัพธ์จะแสดงหลังเปรียบเทียบเอกสาร</td></tr></tbody>
            </table>
          </div>
          <div class="compare-preview-panel">
            <div class="preview-heading">
              <div><p class="eyebrow">Preview</p><h3 id="comparePreviewTitle">ภาพผลลัพธ์</h3></div>
              <button class="icon-button" id="compareDownloadCurrent" type="button" title="ดาวน์โหลดภาพหน้านี้" disabled><i data-lucide="download"></i></button>
            </div>
            <div class="text-difference-panel" id="compareTextDifferencePanel" hidden>
              <p class="eyebrow">Text differences</p>
              <ul id="compareTextDifferenceList"></ul>
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
    textDifferencePanel: root.querySelector("#compareTextDifferencePanel"),
    textDifferenceList: root.querySelector("#compareTextDifferenceList"),
    roiPanel: root.querySelector("#compareRoiPanel"),
    roiPageLabel: root.querySelector("#compareRoiPageLabel"),
    roiPrevious: root.querySelector("#compareRoiPrevious"),
    roiNext: root.querySelector("#compareRoiNext"),
    roiApplyRange: root.querySelector("#compareRoiApplyRange"),
    roiResetLeft: root.querySelector("#compareRoiResetLeft"),
    roiResetRight: root.querySelector("#compareRoiResetRight"),
    roiLeftStage: root.querySelector("#compareRoiLeftStage"),
    roiRightStage: root.querySelector("#compareRoiRightStage"),
    roiLeftCanvas: root.querySelector("#compareRoiLeftCanvas"),
    roiRightCanvas: root.querySelector("#compareRoiRightCanvas"),
    roiLeftSelection: root.querySelector("#compareRoiLeftSelection"),
    roiRightSelection: root.querySelector("#compareRoiRightSelection"),
  };

  restoreGeminiKey();
  bindFileZone("left");
  bindFileZone("right");
  els.runButton.addEventListener("click", runComparison);
  els.resetButton.addEventListener("click", resetComparison);
  els.downloadZip.addEventListener("click", downloadAllDifferences);
  els.downloadCurrent.addEventListener("click", downloadCurrentDifference);
  els.roiPrevious.addEventListener("click", () => changeRoiPage(-1));
  els.roiNext.addEventListener("click", () => changeRoiPage(1));
  els.roiApplyRange.addEventListener("click", applyRoiToRange);
  els.roiResetLeft.addEventListener("click", () => resetRoi("left"));
  els.roiResetRight.addEventListener("click", () => resetRoi("right"));
  bindRoiStage("left");
  bindRoiStage("right");
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
    clearRoiState();
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
    state.roiPage = 1;
    els.startPage.value = "1";
    els.endPage.value = String(sharedPages);
    els.startPage.max = String(sharedPages);
    els.endPage.max = String(sharedPages);
    const leftPages = state.leftSource?.pageCount || 0;
    const rightPages = state.rightSource?.pageCount || 0;
    const suffix = leftPages === rightPages ? `${sharedPages} หน้าพร้อมเปรียบเทียบ` : `เทียบได้ ${sharedPages} หน้า`;
    setProgressIdle(suffix);
    void renderRoiPreviews();
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
    clearRoiState();
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
        const [leftCanvas, rightCanvas, leftTextPage, rightTextPage] = await Promise.all([
          state.leftSource.renderPage(page),
          state.rightSource.renderPage(page),
          state.leftSource.extractTextPage(page),
          state.rightSource.extractTextPage(page),
        ]);
        const leftRegion = getRoi(page, "left");
        const rightRegion = getRoi(page, "right");
        const textFindings = findPdfTextDifferences(leftTextPage, rightTextPage, leftRegion, rightRegion);
        const textBoxes = textFindings.map((finding) => normalizedBoxToCanvas(finding.comparisonBox, rightCanvas, { label: finding.label }));
        const leftArea = cropCanvas(leftCanvas, leftRegion);
        const rightArea = cropCanvas(rightCanvas, rightRegion);
        const comparison = comparePageCanvases(leftArea, rightArea);
        let cropBoxes = comparison.visualComparable ? comparison.boxes : [];
        let gemini = null;
        if (useGemini) {
          setProgressValue(`Gemini ตรวจทานหน้า ${page}`, completed, total);
          try {
            gemini = await reviewDocumentDifference({
              leftCanvas: comparison.referenceCanvas,
              rightCanvas: comparison.comparisonCanvas,
              page,
              apiKey,
              textEvidence: buildPdfTextEvidence(textFindings),
            });
            const geminiBoxes = geminiReviewBoxes(gemini, comparison.comparisonCanvas.width, comparison.comparisonCanvas.height);
            // Gemini boxes are semantic, so they take precedence for documents whose layouts differ.
            if (geminiBoxes.length) {
              cropBoxes = mergeBoxes(
                geminiBoxes,
                Math.max(6, Math.round(comparison.comparisonCanvas.width * 0.005)),
                localBoxLimits(comparison.comparisonCanvas.width, comparison.comparisonCanvas.height),
              );
            }
          } catch (error) {
            gemini = { error: error.message || "Gemini review failed." };
          }
        }
        const visualBoxes = mapCropBoxesToPage(cropBoxes, rightRegion, rightCanvas, comparison.comparisonCanvas);
        const boxes = combineMarkerBoxes(textBoxes, visualBoxes);
        const imageBlob = boxes.length
          ? await canvasToBlob(drawDifferenceMarkers(rightCanvas, boxes))
          : null;
        rows.push({
          page,
          boxes,
          imageBlob,
          gemini,
          visualComparable: comparison.visualComparable,
          textFindings,
        });
        state.results = rows;
        renderResults();
        if (!state.selectedPage && imageBlob) selectResult(page);
        setProgressValue(`เทียบหน้า ${page} แล้ว`, page - startPage + 1, total);
      }
      if (comparisonToken === state.compareToken) {
        const changedPages = rows.filter((row) => row.boxes.length).length;
        const needsSemanticReview = !useGemini && rows.some((row) => !row.visualComparable);
        setProgressDone(
          changedPages
            ? `พบจุดต่าง ${changedPages} หน้า`
            : needsSemanticReview
              ? "โครงสร้างต่างกัน - เปิด Gemini scan"
              : "ไม่พบจุดต่าง",
        );
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
    els.textDifferencePanel.hidden = true;
    els.textDifferenceList.innerHTML = "";
  }

  function renderResults() {
    const changedRows = state.results.filter((row) => row.boxes.length);
    els.pageCount.textContent = state.results.length;
    els.changedPageCount.textContent = changedRows.length;
    els.differenceCount.textContent = state.results.reduce((sum, row) => sum + row.boxes.length, 0);
    els.downloadPanel.hidden = !changedRows.length;
    if (!state.results.length) return;
    els.resultBody.innerHTML = state.results.map((row) => {
      const detailText = row.gemini?.error
        ? "ตรวจไม่สำเร็จ"
        : row.gemini?.summary || row.textFindings?.[0]?.description || (!row.visualComparable ? "โครงสร้างต่างกัน" : (els.useGemini.checked && row.boxes.length ? "กำลังตรวจ" : "-"));
      return `
        <tr data-page="${row.page}" class="${state.selectedPage === row.page ? "selected" : ""}">
          <td>${row.page}</td>
          <td><span class="difference-status ${row.boxes.length ? "has-difference" : "no-difference"}">${row.boxes.length ? `พบ ${row.boxes.length} จุด` : "ไม่พบ"}</span></td>
          <td class="gemini-summary">${escapeHtml(detailText)}</td>
        </tr>
      `;
    }).join("");
  }

  function selectResult(page) {
    const row = state.results.find((result) => result.page === page);
    if (!row) return;
    state.selectedPage = page;
    renderResults();
    renderTextFindings(row.textFindings);
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

  function renderTextFindings(findings) {
    if (!findings?.length) {
      els.textDifferencePanel.hidden = true;
      els.textDifferenceList.innerHTML = "";
      return;
    }
    els.textDifferencePanel.hidden = false;
    els.textDifferenceList.innerHTML = findings.slice(0, 8).map((finding) => `
      <li><span class="text-difference-kind">${escapeHtml(textFindingKind(finding.kind))}</span><span>${escapeHtml(finding.description)}</span></li>
    `).join("");
  }

  function clearRoiState() {
    state.roiRenderToken += 1;
    state.roiSelections.clear();
    state.roiPage = 1;
    state.roiDrag = null;
    els.roiPanel.hidden = true;
    clearPreviewCanvas(els.roiLeftCanvas);
    clearPreviewCanvas(els.roiRightCanvas);
  }

  function getRoi(page, side) {
    const selection = state.roiSelections.get(page)?.[side];
    return selection || FULL_REGION;
  }

  function hasCustomRoi(page, side) {
    return Boolean(state.roiSelections.get(page)?.[side]);
  }

  function setRoi(page, side, region) {
    const current = state.roiSelections.get(page) || {};
    state.roiSelections.set(page, { ...current, [side]: normalizeRoi(region) });
    renderRoiSelection(side);
  }

  function resetRoi(side) {
    const current = state.roiSelections.get(state.roiPage);
    if (!current?.[side]) return;
    delete current[side];
    if (Object.keys(current).length) state.roiSelections.set(state.roiPage, current);
    else state.roiSelections.delete(state.roiPage);
    renderRoiSelection(side);
  }

  function changeRoiPage(offset) {
    const pageCount = getSharedPageCount();
    const next = clamp(state.roiPage + offset, 1, pageCount);
    if (next === state.roiPage) return;
    state.roiPage = next;
    void renderRoiPreviews();
  }

  function applyRoiToRange() {
    const startPage = Number.parseInt(els.startPage.value, 10);
    const endPage = Number.parseInt(els.endPage.value, 10);
    const pageCount = getSharedPageCount();
    try {
      validateRange(startPage, endPage, pageCount);
    } catch (error) {
      setProgressIdle(error.message);
      return;
    }
    const source = state.roiSelections.get(state.roiPage) || {};
    for (let page = startPage; page <= endPage; page += 1) {
      const next = { ...state.roiSelections.get(page) };
      if (source.left) next.left = { ...source.left };
      else delete next.left;
      if (source.right) next.right = { ...source.right };
      else delete next.right;
      if (Object.keys(next).length) state.roiSelections.set(page, next);
      else state.roiSelections.delete(page);
    }
    setProgressIdle(`ใช้พื้นที่หน้า ${state.roiPage} กับหน้า ${startPage}-${endPage}`);
  }

  async function renderRoiPreviews() {
    if (!state.leftSource || !state.rightSource) return;
    const pageCount = getSharedPageCount();
    if (!pageCount) return;
    state.roiPage = clamp(state.roiPage, 1, pageCount);
    const token = state.roiRenderToken + 1;
    state.roiRenderToken = token;
    els.roiPanel.hidden = false;
    updateRoiToolbar();
    try {
      const [leftCanvas, rightCanvas] = await Promise.all([
        state.leftSource.renderPage(state.roiPage),
        state.rightSource.renderPage(state.roiPage),
      ]);
      if (token !== state.roiRenderToken) return;
      drawPreviewCanvas(els.roiLeftCanvas, leftCanvas);
      drawPreviewCanvas(els.roiRightCanvas, rightCanvas);
      renderRoiSelection("left");
      renderRoiSelection("right");
    } catch (error) {
      if (token === state.roiRenderToken) setProgressIdle(error.message || "แสดงตัวอย่างเอกสารไม่สำเร็จ");
    }
  }

  function updateRoiToolbar() {
    const pageCount = getSharedPageCount();
    els.roiPageLabel.textContent = `หน้า ${state.roiPage} / ${pageCount}`;
    els.roiPrevious.disabled = state.roiPage <= 1;
    els.roiNext.disabled = state.roiPage >= pageCount;
    els.roiApplyRange.disabled = !pageCount;
  }

  function drawPreviewCanvas(target, source) {
    const scale = Math.min(1, 960 / Math.max(source.width, source.height));
    target.width = Math.max(1, Math.round(source.width * scale));
    target.height = Math.max(1, Math.round(source.height * scale));
    const context = target.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, target.width, target.height);
    context.drawImage(source, 0, 0, target.width, target.height);
  }

  function clearPreviewCanvas(canvas) {
    canvas.width = 1;
    canvas.height = 1;
  }

  function renderRoiSelection(side) {
    const stage = side === "left" ? els.roiLeftStage : els.roiRightStage;
    const selection = side === "left" ? els.roiLeftSelection : els.roiRightSelection;
    const region = getRoi(state.roiPage, side);
    const custom = hasCustomRoi(state.roiPage, side);
    selection.classList.toggle("default", !custom);
    selection.style.left = `${region.x * 100}%`;
    selection.style.top = `${region.y * 100}%`;
    selection.style.width = `${region.width * 100}%`;
    selection.style.height = `${region.height * 100}%`;
    selection.setAttribute("aria-label", custom ? "พื้นที่เปรียบเทียบที่เลือก" : "ใช้ทั้งหน้า");
    stage.classList.toggle("has-custom-selection", custom);
  }

  function bindRoiStage(side) {
    const stage = side === "left" ? els.roiLeftStage : els.roiRightStage;
    const selection = side === "left" ? els.roiLeftSelection : els.roiRightSelection;
    stage.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !state.leftSource || !state.rightSource) return;
      const point = getStagePoint(stage, event);
      const handle = event.target.closest(".roi-handle")?.dataset.handle;
      const startedOnSelection = event.target.closest(".roi-selection") === selection && hasCustomRoi(state.roiPage, side);
      state.roiDrag = {
        side,
        mode: handle ? "resize" : startedOnSelection ? "move" : "create",
        handle,
        start: point,
        initial: { ...getRoi(state.roiPage, side) },
        pointerId: event.pointerId,
      };
      stage.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    stage.addEventListener("pointermove", (event) => updateRoiDrag(side, stage, event));
    stage.addEventListener("pointerup", (event) => finishRoiDrag(side, stage, event));
    stage.addEventListener("pointercancel", (event) => finishRoiDrag(side, stage, event));
  }

  function updateRoiDrag(side, stage, event) {
    const drag = state.roiDrag;
    if (!drag || drag.side !== side || drag.pointerId !== event.pointerId) return;
    const point = getStagePoint(stage, event);
    let region;
    if (drag.mode === "create") {
      region = regionFromPoints(drag.start, point);
    } else if (drag.mode === "move") {
      region = {
        ...drag.initial,
        x: clamp(drag.initial.x + point.x - drag.start.x, 0, 1 - drag.initial.width),
        y: clamp(drag.initial.y + point.y - drag.start.y, 0, 1 - drag.initial.height),
      };
    } else {
      region = resizeRegion(drag.initial, drag.handle, point);
    }
    setRoi(state.roiPage, side, region);
    event.preventDefault();
  }

  function finishRoiDrag(side, stage, event) {
    const drag = state.roiDrag;
    if (!drag || drag.side !== side || drag.pointerId !== event.pointerId) return;
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    state.roiDrag = null;
  }
}

function normalizeRoi(region) {
  const width = clamp(Number(region?.width) || 0, MIN_REGION_SIZE, 1);
  const height = clamp(Number(region?.height) || 0, MIN_REGION_SIZE, 1);
  return {
    x: clamp(Number(region?.x) || 0, 0, 1 - width),
    y: clamp(Number(region?.y) || 0, 0, 1 - height),
    width,
    height,
  };
}

function getStagePoint(stage, event) {
  const bounds = stage.getBoundingClientRect();
  return {
    x: clamp((event.clientX - bounds.left) / Math.max(1, bounds.width), 0, 1),
    y: clamp((event.clientY - bounds.top) / Math.max(1, bounds.height), 0, 1),
  };
}

function regionFromPoints(start, end) {
  let left = Math.min(start.x, end.x);
  let right = Math.max(start.x, end.x);
  let top = Math.min(start.y, end.y);
  let bottom = Math.max(start.y, end.y);
  if (right - left < MIN_REGION_SIZE) {
    if (end.x >= start.x) right = Math.min(1, left + MIN_REGION_SIZE);
    else left = Math.max(0, right - MIN_REGION_SIZE);
  }
  if (bottom - top < MIN_REGION_SIZE) {
    if (end.y >= start.y) bottom = Math.min(1, top + MIN_REGION_SIZE);
    else top = Math.max(0, bottom - MIN_REGION_SIZE);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function resizeRegion(region, handle, point) {
  let left = region.x;
  let right = region.x + region.width;
  let top = region.y;
  let bottom = region.y + region.height;
  if (handle?.includes("w")) left = clamp(point.x, 0, right - MIN_REGION_SIZE);
  if (handle?.includes("e")) right = clamp(point.x, left + MIN_REGION_SIZE, 1);
  if (handle?.includes("n")) top = clamp(point.y, 0, bottom - MIN_REGION_SIZE);
  if (handle?.includes("s")) bottom = clamp(point.y, top + MIN_REGION_SIZE, 1);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function roiToPixelRect(region, canvas) {
  const normalized = normalizeRoi(region);
  const x = clamp(Math.floor(normalized.x * canvas.width), 0, Math.max(0, canvas.width - 1));
  const y = clamp(Math.floor(normalized.y * canvas.height), 0, Math.max(0, canvas.height - 1));
  const right = clamp(Math.ceil((normalized.x + normalized.width) * canvas.width), x + 1, canvas.width);
  const bottom = clamp(Math.ceil((normalized.y + normalized.height) * canvas.height), y + 1, canvas.height);
  return { x, y, width: right - x, height: bottom - y };
}

function cropCanvas(source, region) {
  const rect = roiToPixelRect(region, source);
  const canvas = document.createElement("canvas");
  canvas.width = rect.width;
  canvas.height = rect.height;
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  return canvas;
}

function mapCropBoxesToPage(boxes, region, pageCanvas, cropCanvas) {
  const rect = roiToPixelRect(region, pageCanvas);
  const scaleX = rect.width / Math.max(1, cropCanvas.width);
  const scaleY = rect.height / Math.max(1, cropCanvas.height);
  return boxes.map((box) => {
    const left = clamp(Math.round(rect.x + (box.x * scaleX)), rect.x, rect.x + rect.width - 1);
    const top = clamp(Math.round(rect.y + (box.y * scaleY)), rect.y, rect.y + rect.height - 1);
    const right = clamp(Math.round(rect.x + ((box.x + box.width) * scaleX)), left + 1, rect.x + rect.width);
    const bottom = clamp(Math.round(rect.y + ((box.y + box.height) * scaleY)), top + 1, rect.y + rect.height);
    return { x: left, y: top, width: right - left, height: bottom - top };
  });
}

function combineMarkerBoxes(textBoxes, visualBoxes) {
  const combined = [];
  [...textBoxes, ...visualBoxes].forEach((box) => {
    const duplicateIndex = combined.findIndex((existing) => markerBoxesDescribeSameArea(existing, box));
    if (duplicateIndex < 0) {
      combined.push(box);
      return;
    }
    if (box.label && !combined[duplicateIndex].label) combined[duplicateIndex] = box;
  });
  return combined;
}

function markerBoxesDescribeSameArea(first, second) {
  const intersectionLeft = Math.max(first.x, second.x);
  const intersectionTop = Math.max(first.y, second.y);
  const intersectionRight = Math.min(first.x + first.width, second.x + second.width);
  const intersectionBottom = Math.min(first.y + first.height, second.y + second.height);
  const intersection = Math.max(0, intersectionRight - intersectionLeft) * Math.max(0, intersectionBottom - intersectionTop);
  const firstArea = first.width * first.height;
  const secondArea = second.width * second.height;
  if (intersection / Math.max(1, Math.min(firstArea, secondArea)) >= 0.45) return true;
  const firstCenterX = first.x + (first.width / 2);
  const firstCenterY = first.y + (first.height / 2);
  const secondCenterX = second.x + (second.width / 2);
  const secondCenterY = second.y + (second.height / 2);
  return Math.abs(firstCenterX - secondCenterX) <= Math.max(first.width, second.width) * 0.55
    && Math.abs(firstCenterY - secondCenterY) <= Math.max(first.height, second.height) * 0.75;
}

function normalizedBoxToCanvas(box, canvas, metadata = {}) {
  const x = clamp(Math.round((Number(box?.x) || 0) * canvas.width), 0, Math.max(0, canvas.width - 1));
  const y = clamp(Math.round((Number(box?.y) || 0) * canvas.height), 0, Math.max(0, canvas.height - 1));
  const right = clamp(Math.round(((Number(box?.x) || 0) + (Number(box?.width) || 0)) * canvas.width), x + 1, canvas.width);
  const bottom = clamp(Math.round(((Number(box?.y) || 0) + (Number(box?.height) || 0)) * canvas.height), y + 1, canvas.height);
  return { x, y, width: right - x, height: bottom - y, ...metadata };
}

async function openDocumentSource(file) {
  if (isPdf(file)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const loadingTask = getDocument({ data: bytes });
    const pdf = await loadingTask.promise;
    return {
      pageCount: pdf.numPages,
      renderPage: async (pageNumber) => renderPdfPage(pdf, pageNumber),
      extractTextPage: async (pageNumber) => extractPdfTextPage(pdf, pageNumber),
      close: () => pdf.destroy(),
    };
  }
  return {
    pageCount: 1,
    renderPage: async () => renderImageFile(file),
    extractTextPage: async () => null,
    close: () => {},
  };
}

async function extractPdfTextPage(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent();
  page.cleanup();
  return createPdfTextPage(textContent, viewport);
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
  const offset = findBestTranslation(comparisonCanvas, referenceCanvas);
  const alignedReference = translateCanvas(referenceCanvas, offset.x, offset.y);
  const visualComparable = offset.score <= MAX_VISUAL_ALIGNMENT_MISMATCH;
  const boxes = visualComparable ? findDifferenceBoxes(alignedReference, comparisonCanvas) : [];
  return { referenceCanvas: alignedReference, comparisonCanvas, boxes, visualComparable };
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
    if (
      (right - left) * (bottom - top) > width * height * 0.16
      || right - left > width * 0.82
      || bottom - top > height * 0.72
    ) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
  }).filter(Boolean);
}

function normalizePair(leftCanvas, rightCanvas) {
  const comparisonCanvas = cloneCanvas(rightCanvas);
  const referenceCanvas = document.createElement("canvas");
  referenceCanvas.width = comparisonCanvas.width;
  referenceCanvas.height = comparisonCanvas.height;
  const context = referenceCanvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, referenceCanvas.width, referenceCanvas.height);
  if (Math.abs(leftCanvas.width - rightCanvas.width) <= 3 && Math.abs(leftCanvas.height - rightCanvas.height) <= 3) {
    context.drawImage(leftCanvas, 0, 0, referenceCanvas.width, referenceCanvas.height);
    return { referenceCanvas, comparisonCanvas };
  }

  const leftBounds = findInkBounds(leftCanvas) || { x: 0, y: 0, width: leftCanvas.width, height: leftCanvas.height };
  const rightBounds = findInkBounds(rightCanvas) || { x: 0, y: 0, width: rightCanvas.width, height: rightCanvas.height };
  const scaleX = rightBounds.width / Math.max(1, leftBounds.width);
  const scaleY = rightBounds.height / Math.max(1, leftBounds.height);
  context.drawImage(
    leftCanvas,
    rightBounds.x - leftBounds.x * scaleX,
    rightBounds.y - leftBounds.y * scaleY,
    leftCanvas.width * scaleX,
    leftCanvas.height * scaleY,
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
    score: best.score,
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
  const limits = localBoxLimits(width, height);
  const candidates = findComponents(dilateMask(mask, width, height), width, height)
    .filter((box) => isFocusedDifferenceBox(box, width, height, limits));
  return mergeBoxes(candidates, Math.max(4, Math.round(width * 0.005)), limits)
    .map(({ pixels, ...box }) => box);
}

function localBoxLimits(width, height) {
  return {
    maxWidth: Math.round(width * 0.82),
    maxHeight: Math.round(height * 0.72),
    maxArea: width * height * 0.16,
    maxExpansion: 4,
  };
}

function isFocusedDifferenceBox(box, width, height, limits) {
  const widthRatio = box.width / width;
  const heightRatio = box.height / height;
  const area = box.width * box.height;
  const density = box.pixels / Math.max(1, area);
  if (area > limits.maxArea || box.width > limits.maxWidth || box.height > limits.maxHeight) return false;
  // Table borders and other structural scan differences are broad but sparse, not a local content change.
  if ((widthRatio > 0.72 && heightRatio < 0.055) || (heightRatio > 0.72 && widthRatio < 0.055)) return false;
  if (density < 0.035 && (widthRatio > 0.28 || heightRatio > 0.28)) return false;
  return true;
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
      boxes.push({ x: minX, y: minY, width: componentWidth, height: componentHeight, pixels: tail });
    }
  }
  return boxes;
}

function mergeBoxes(input, margin, limits = {}) {
  const boxes = input.map((box) => ({ ...box }));
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let index = 0; index < boxes.length; index += 1) {
      for (let other = index + 1; other < boxes.length; other += 1) {
        if (!boxesTouch(boxes[index], boxes[other], margin)) continue;
        const merged = unionBox(boxes[index], boxes[other]);
        if (!canMergeBoxes(boxes[index], boxes[other], merged, limits)) continue;
        boxes[index] = merged;
        boxes.splice(other, 1);
        changed = true;
        break outer;
      }
    }
  }
  return boxes.sort((a, b) => a.y - b.y || a.x - b.x);
}

function canMergeBoxes(first, second, merged, limits) {
  if (limits.maxWidth && merged.width > limits.maxWidth) return false;
  if (limits.maxHeight && merged.height > limits.maxHeight) return false;
  const mergedArea = merged.width * merged.height;
  if (limits.maxArea && mergedArea > limits.maxArea) return false;
  if (limits.maxExpansion) {
    const sourceArea = (first.width * first.height) + (second.width * second.height);
    if (mergedArea > sourceArea * limits.maxExpansion) return false;
  }
  return true;
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
    if (box.label) drawMarkerLabel(context, result, box, radiusY, String(box.label));
  });
  return result;
}

function drawMarkerLabel(context, canvas, box, radiusY, label) {
  const fontSize = clamp(Math.round(Math.min(canvas.width, canvas.height) * 0.012), 12, 18);
  const horizontalPadding = Math.round(fontSize * 0.62);
  const verticalPadding = Math.round(fontSize * 0.42);
  context.save();
  context.font = `600 ${fontSize}px Inter, Arial, sans-serif`;
  const text = truncateCanvasText(context, label, canvas.width * 0.42);
  const textWidth = context.measureText(text).width;
  const labelWidth = Math.min(canvas.width - 8, textWidth + (horizontalPadding * 2));
  const labelHeight = fontSize + (verticalPadding * 2);
  const x = clamp(box.x + (box.width / 2) - (labelWidth / 2), 4, canvas.width - labelWidth - 4);
  let y = box.y - radiusY - labelHeight - 5;
  if (y < 4) y = Math.min(canvas.height - labelHeight - 4, box.y + radiusY + 5);
  context.fillStyle = "rgba(255, 255, 255, 0.96)";
  context.strokeStyle = "#dc2626";
  context.lineWidth = 1;
  context.beginPath();
  context.roundRect(x, y, labelWidth, labelHeight, Math.max(3, Math.round(fontSize * 0.3)));
  context.fill();
  context.stroke();
  context.fillStyle = "#b91c1c";
  context.textBaseline = "middle";
  context.fillText(text, x + horizontalPadding, y + (labelHeight / 2));
  context.restore();
}

function truncateCanvasText(context, value, maximumWidth) {
  if (context.measureText(value).width <= maximumWidth) return value;
  let text = value;
  while (text.length > 1 && context.measureText(`${text}...`).width > maximumWidth) text = text.slice(0, -1);
  return `${text}...`;
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
  const header = ["page", "difference_count", "text_differences", "gemini_summary"];
  const data = rows.map((row) => [
    row.page,
    row.boxes.length,
    (row.textFindings || []).map((finding) => finding.description).join(" | "),
    row.gemini?.summary || row.gemini?.error || "",
  ]);
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

function textFindingKind(kind) {
  if (kind === "missing_from_comparison") return "หาย";
  if (kind === "missing_from_reference") return "เพิ่ม";
  return "แก้ไข";
}
