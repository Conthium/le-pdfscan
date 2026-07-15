import { createIcons, icons } from "lucide";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerSource from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { reviewDocumentDifference } from "./gemini.js";
import { buildPdfTextEvidence, createPdfTextPage, findPdfTextDifferences, hasUsablePdfText } from "./pdfTextDiff.js";

GlobalWorkerOptions.workerSrc = pdfWorkerSource;

const MAX_RENDER_EDGE = 1800;
const THUMBNAIL_RENDER_EDGE = 240;
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
    selectedResultId: null,
    previewUrl: null,
    pageSelection: { left: new Set(), right: new Set() },
    pageSelectionAnchors: { left: null, right: null },
    pagePickerToken: 0,
    thumbnailObserver: null,
    roiPairIndex: 0,
    roiRenderToken: 0,
    roiSelections: new Map(),
    roiDrag: null,
  };

  root.innerHTML = `
    <section class="workspace compare-workspace">
      <section class="compare-setup">
        <div class="compare-setup-heading">
          <div>
            <p class="eyebrow">Document compare</p>
            <h2>เลือกเอกสาร</h2>
          </div>
          <button class="icon-button" id="compareResetButton" type="button" title="ล้างเอกสาร" aria-label="ล้างเอกสาร"><i data-lucide="rotate-ccw"></i></button>
        </div>
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
        <div class="compare-action-bar">
          <div class="compare-gemini-settings">
            <label class="check-row">
              <input id="compareUseGemini" type="checkbox" />
              <span>Gemini scan</span>
            </label>
            <label class="gemini-key-field">
              <input id="compareGeminiKey" type="password" autocomplete="off" aria-label="Gemini API key" placeholder="Gemini API key (Vercel เมื่อเว้นว่าง)" />
            </label>
          </div>
          <div class="compare-primary-actions">
            <button class="primary" id="compareRunButton" disabled><i data-lucide="scan-search"></i><span>เปรียบเทียบ</span></button>
            <div class="download-panel" id="compareDownloadPanel" hidden>
              <button class="download-link" id="compareDownloadPdf"><i data-lucide="file-down"></i><span>PDF ที่เปรียบเทียบแล้ว</span></button>
            </div>
          </div>
        </div>
        <div class="progress-wrap idle" id="compareProgressWrap">
          <div class="progress-label"><span id="compareProgressText">เลือกเอกสารสองไฟล์</span><span id="compareProgressCount" class="progress-count"></span></div>
          <div class="progress-track"><div id="compareProgressBar"></div></div>
        </div>
      </section>

      <section class="page-picker-panel" id="comparePagePicker" hidden>
        <div class="page-picker-heading">
          <div>
            <p class="eyebrow">Page selection</p>
            <h2>เลือกหน้าที่จะเปรียบเทียบ</h2>
          </div>
          <span class="page-pair-summary" id="comparePairSummary">0 คู่</span>
        </div>
        <div class="page-picker-grid">
          <section class="page-picker-document">
            <div class="page-picker-document-header">
              <div><span class="page-picker-title">ต้นฉบับ</span><span class="page-selection-count" id="compareLeftPageCount">0 / 0 หน้า</span></div>
              <div class="page-picker-tools">
                <label class="page-range-field"><span>ช่วงหน้า</span><input id="compareLeftPageExpression" type="text" inputmode="text" autocomplete="off" placeholder="1,5-8" /></label>
                <button class="icon-button" id="compareLeftApplyPages" type="button" title="ใช้ช่วงหน้าที่ระบุ" aria-label="ใช้ช่วงหน้าที่ระบุ"><i data-lucide="check"></i></button>
                <button class="icon-button" id="compareLeftSelectAll" type="button" title="เลือกทุกหน้า" aria-label="เลือกทุกหน้า"><i data-lucide="layers-3"></i></button>
                <button class="icon-button" id="compareLeftClearPages" type="button" title="ยกเลิกเลือกทุกหน้า" aria-label="ยกเลิกเลือกทุกหน้า"><i data-lucide="x"></i></button>
              </div>
            </div>
            <div class="page-thumbnail-grid" id="compareLeftPageThumbnails" aria-label="หน้าของต้นฉบับ"></div>
          </section>
          <section class="page-picker-document">
            <div class="page-picker-document-header">
              <div><span class="page-picker-title">ฉบับเปรียบเทียบ</span><span class="page-selection-count" id="compareRightPageCount">0 / 0 หน้า</span></div>
              <div class="page-picker-tools">
                <label class="page-range-field"><span>ช่วงหน้า</span><input id="compareRightPageExpression" type="text" inputmode="text" autocomplete="off" placeholder="1,5-8" /></label>
                <button class="icon-button" id="compareRightApplyPages" type="button" title="ใช้ช่วงหน้าที่ระบุ" aria-label="ใช้ช่วงหน้าที่ระบุ"><i data-lucide="check"></i></button>
                <button class="icon-button" id="compareRightSelectAll" type="button" title="เลือกทุกหน้า" aria-label="เลือกทุกหน้า"><i data-lucide="layers-3"></i></button>
                <button class="icon-button" id="compareRightClearPages" type="button" title="ยกเลิกเลือกทุกหน้า" aria-label="ยกเลิกเลือกทุกหน้า"><i data-lucide="x"></i></button>
              </div>
            </div>
            <div class="page-thumbnail-grid" id="compareRightPageThumbnails" aria-label="หน้าของฉบับเปรียบเทียบ"></div>
          </section>
        </div>
      </section>

      <section class="roi-panel" id="compareRoiPanel" hidden>
        <div class="roi-toolbar">
          <div>
            <p class="eyebrow">Compare area</p>
            <h2>พื้นที่เปรียบเทียบ</h2>
          </div>
          <div class="roi-toolbar-actions">
            <button class="icon-button" id="compareRoiPrevious" type="button" title="คู่หน้าก่อนหน้า" aria-label="คู่หน้าก่อนหน้า"><i data-lucide="chevron-left"></i></button>
            <span class="roi-page-label" id="compareRoiPageLabel">คู่หน้า -</span>
            <button class="icon-button" id="compareRoiNext" type="button" title="คู่หน้าถัดไป" aria-label="คู่หน้าถัดไป"><i data-lucide="chevron-right"></i></button>
            <button class="icon-button" id="compareRoiApplyRange" type="button" title="ใช้พื้นที่นี้กับทุกคู่หน้าที่เลือก" aria-label="ใช้พื้นที่นี้กับทุกคู่หน้าที่เลือก"><i data-lucide="copy"></i></button>
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

      <section class="result-panel compare-results" id="compareResults" hidden>
        <div class="result-header">
          <div>
            <p class="eyebrow">Document compare</p>
            <h2>จุดต่างระหว่างเอกสาร</h2>
          </div>
          <div class="metric-strip">
            <div><strong id="comparePageCount">0</strong><span>คู่ที่เทียบ</span></div>
            <div><strong id="compareChangedPageCount">0</strong><span>คู่ที่ต่าง</span></div>
            <div><strong id="compareDifferenceCount">0</strong><span>จุดต่าง</span></div>
          </div>
        </div>
        <div class="compare-result-body">
          <div class="table-frame compare-table-frame">
            <table>
              <thead><tr><th>คู่หน้า</th><th>จุดต่าง</th><th>รายละเอียด</th></tr></thead>
              <tbody id="compareResultBody"><tr><td colspan="3" class="empty-cell">ผลลัพธ์จะแสดงหลังเปรียบเทียบเอกสาร</td></tr></tbody>
            </table>
          </div>
          <div class="compare-preview-panel">
            <div class="preview-heading">
              <div><p class="eyebrow">Preview</p><h3 id="comparePreviewTitle">ภาพผลลัพธ์</h3></div>
              <button class="icon-button" id="compareDownloadCurrent" type="button" title="ดาวน์โหลด PDF หน้านี้" disabled><i data-lucide="download"></i></button>
            </div>
            <div class="compare-preview-content">
              <div class="text-difference-panel" id="compareTextDifferencePanel" hidden>
                <p class="eyebrow">จุดต่างที่ตรวจพบ</p>
                <ul id="compareTextDifferenceList"></ul>
              </div>
              <div class="preview-canvas-wrap">
                <img id="comparePreviewImage" alt="ภาพเอกสารที่วงจุดต่างสีแดง" hidden />
                <div id="comparePreviewEmpty" class="preview-empty">เลือกหน้าที่พบจุดต่างเพื่อดูภาพ</div>
              </div>
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
    pagePicker: root.querySelector("#comparePagePicker"),
    pairSummary: root.querySelector("#comparePairSummary"),
    leftPageCount: root.querySelector("#compareLeftPageCount"),
    rightPageCount: root.querySelector("#compareRightPageCount"),
    leftPageExpression: root.querySelector("#compareLeftPageExpression"),
    rightPageExpression: root.querySelector("#compareRightPageExpression"),
    leftApplyPages: root.querySelector("#compareLeftApplyPages"),
    rightApplyPages: root.querySelector("#compareRightApplyPages"),
    leftSelectAll: root.querySelector("#compareLeftSelectAll"),
    rightSelectAll: root.querySelector("#compareRightSelectAll"),
    leftClearPages: root.querySelector("#compareLeftClearPages"),
    rightClearPages: root.querySelector("#compareRightClearPages"),
    leftPageThumbnails: root.querySelector("#compareLeftPageThumbnails"),
    rightPageThumbnails: root.querySelector("#compareRightPageThumbnails"),
    useGemini: root.querySelector("#compareUseGemini"),
    geminiKey: root.querySelector("#compareGeminiKey"),
    runButton: root.querySelector("#compareRunButton"),
    resetButton: root.querySelector("#compareResetButton"),
    progressWrap: root.querySelector("#compareProgressWrap"),
    progressText: root.querySelector("#compareProgressText"),
    progressCount: root.querySelector("#compareProgressCount"),
    progressBar: root.querySelector("#compareProgressBar"),
    downloadPanel: root.querySelector("#compareDownloadPanel"),
    downloadPdf: root.querySelector("#compareDownloadPdf"),
    resultsPanel: root.querySelector("#compareResults"),
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
  bindPagePicker("left");
  bindPagePicker("right");
  els.runButton.addEventListener("click", runComparison);
  els.resetButton.addEventListener("click", resetComparison);
  els.downloadPdf.addEventListener("click", downloadComparedPdf);
  els.downloadCurrent.addEventListener("click", downloadCurrentComparisonPdf);
  els.roiPrevious.addEventListener("click", () => changeRoiPair(-1));
  els.roiNext.addEventListener("click", () => changeRoiPair(1));
  els.roiApplyRange.addEventListener("click", applyRoiToSelectedPairs);
  els.roiResetLeft.addEventListener("click", () => resetRoi("left"));
  els.roiResetRight.addEventListener("click", () => resetRoi("right"));
  bindRoiStage("left");
  bindRoiStage("right");
  els.resultBody.addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-result-id]");
    if (row) selectResult(row.dataset.resultId);
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

  function bindPagePicker(side) {
    const expression = side === "left" ? els.leftPageExpression : els.rightPageExpression;
    const applyButton = side === "left" ? els.leftApplyPages : els.rightApplyPages;
    const selectAllButton = side === "left" ? els.leftSelectAll : els.rightSelectAll;
    const clearButton = side === "left" ? els.leftClearPages : els.rightClearPages;
    const grid = side === "left" ? els.leftPageThumbnails : els.rightPageThumbnails;
    const applyExpression = () => {
      const source = side === "left" ? state.leftSource : state.rightSource;
      if (!source) return;
      try {
        state.pageSelection[side] = parsePageExpression(expression.value, source.pageCount);
        state.pageSelectionAnchors[side] = null;
        updatePagePickerSelection();
      } catch (error) {
        setProgressIdle(error.message || "ช่วงหน้าไม่ถูกต้อง");
      }
    };
    applyButton.addEventListener("click", applyExpression);
    expression.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      applyExpression();
    });
    selectAllButton.addEventListener("click", () => {
      const source = side === "left" ? state.leftSource : state.rightSource;
      if (!source) return;
      state.pageSelection[side] = new Set(pageNumbers(source.pageCount));
      state.pageSelectionAnchors[side] = null;
      updatePagePickerSelection();
    });
    clearButton.addEventListener("click", () => {
      state.pageSelection[side].clear();
      state.pageSelectionAnchors[side] = null;
      updatePagePickerSelection();
    });
    grid.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-page]");
      if (!button || !grid.contains(button)) return;
      togglePageSelection(side, Number(button.dataset.page), event.shiftKey);
    });
  }

  function clearPagePicker() {
    state.pagePickerToken += 1;
    state.thumbnailObserver?.disconnect();
    state.thumbnailObserver = null;
    state.pageSelection.left = new Set();
    state.pageSelection.right = new Set();
    state.pageSelectionAnchors.left = null;
    state.pageSelectionAnchors.right = null;
    state.roiPairIndex = 0;
    els.pagePicker.hidden = true;
    els.leftPageThumbnails.innerHTML = "";
    els.rightPageThumbnails.innerHTML = "";
    els.leftPageExpression.value = "";
    els.rightPageExpression.value = "";
    els.leftPageCount.textContent = "0 / 0 หน้า";
    els.rightPageCount.textContent = "0 / 0 หน้า";
    els.pairSummary.textContent = "0 คู่";
  }

  function rebuildPagePicker() {
    if (!state.leftSource || !state.rightSource) return;
    state.pagePickerToken += 1;
    state.thumbnailObserver?.disconnect();
    state.thumbnailObserver = null;
    els.pagePicker.hidden = false;
    renderPageThumbnailGrid("left");
    renderPageThumbnailGrid("right");
    updatePagePickerSelection();
    observePageThumbnails();
    createIcons({ icons });
  }

  function renderPageThumbnailGrid(side) {
    const source = side === "left" ? state.leftSource : state.rightSource;
    const grid = side === "left" ? els.leftPageThumbnails : els.rightPageThumbnails;
    if (!source) {
      grid.innerHTML = "";
      return;
    }
    grid.innerHTML = pageNumbers(source.pageCount).map((page) => `
      <button class="page-thumbnail" type="button" data-page="${page}" aria-pressed="false" title="หน้า ${page}">
        <span class="page-thumb-preview" data-side="${side}" data-page="${page}"><span class="page-thumb-loading"></span></span>
        <span class="page-number">${page}</span>
        <span class="page-selection-check"><i data-lucide="check"></i></span>
      </button>
    `).join("");
  }

  function observePageThumbnails() {
    const previews = [...root.querySelectorAll(".page-thumb-preview")];
    if (!previews.length) return;
    const render = (preview) => { void renderPageThumbnail(preview); };
    if (!("IntersectionObserver" in window)) {
      previews.slice(0, 16).forEach(render);
      return;
    }
    state.thumbnailObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        state.thumbnailObserver?.unobserve(entry.target);
        render(entry.target);
      });
    }, { rootMargin: "280px 0px" });
    previews.forEach((preview) => state.thumbnailObserver.observe(preview));
  }

  async function renderPageThumbnail(preview) {
    if (preview.dataset.loading || preview.dataset.ready) return;
    const side = preview.dataset.side;
    const page = Number(preview.dataset.page);
    const source = side === "left" ? state.leftSource : state.rightSource;
    if (!source || !Number.isInteger(page)) return;
    const token = state.pagePickerToken;
    preview.dataset.loading = "true";
    try {
      const canvas = await source.renderThumbnail(page);
      if (token !== state.pagePickerToken || !preview.isConnected) return;
      canvas.className = "page-thumb-canvas";
      preview.replaceChildren(canvas);
      preview.dataset.ready = "true";
    } catch {
      if (token !== state.pagePickerToken || !preview.isConnected) return;
      preview.classList.add("thumbnail-error");
    } finally {
      delete preview.dataset.loading;
    }
  }

  function togglePageSelection(side, page, selectRange) {
    const source = side === "left" ? state.leftSource : state.rightSource;
    if (!source || page < 1 || page > source.pageCount) return;
    const selected = state.pageSelection[side];
    const anchor = state.pageSelectionAnchors[side];
    if (selectRange && Number.isInteger(anchor)) {
      const start = Math.min(anchor, page);
      const end = Math.max(anchor, page);
      const select = !selected.has(page);
      for (let current = start; current <= end; current += 1) {
        if (select) selected.add(current);
        else selected.delete(current);
      }
    } else if (selected.has(page)) {
      selected.delete(page);
    } else {
      selected.add(page);
    }
    state.pageSelectionAnchors[side] = page;
    updatePagePickerSelection();
  }

  function updatePagePickerSelection() {
    if (!state.leftSource || !state.rightSource) return;
    const leftPages = getSelectedPages("left");
    const rightPages = getSelectedPages("right");
    const pairs = getPagePairs();
    state.roiPairIndex = pairs.length ? clamp(state.roiPairIndex, 0, pairs.length - 1) : 0;
    els.leftPageCount.textContent = leftPages.length + " / " + state.leftSource.pageCount + " หน้า";
    els.rightPageCount.textContent = rightPages.length + " / " + state.rightSource.pageCount + " หน้า";
    els.leftPageExpression.value = formatPageExpression(leftPages);
    els.rightPageExpression.value = formatPageExpression(rightPages);
    els.pairSummary.textContent = pairs.length ? pairs.length + " คู่" : "เลือกหน้า";
    updateThumbnailSelection("left", state.pageSelection.left);
    updateThumbnailSelection("right", state.pageSelection.right);
    updateButtons();
    if (!state.processing) setProgressIdle(pairs.length ? "พร้อมเทียบ " + pairs.length + " คู่หน้า" : "เลือกหน้าทั้งสองฝั่งเพื่อจับคู่");
    if (!els.roiPanel.hidden) void renderRoiPreviews();
  }

  function updateThumbnailSelection(side, selected) {
    const grid = side === "left" ? els.leftPageThumbnails : els.rightPageThumbnails;
    grid.querySelectorAll("button[data-page]").forEach((button) => {
      const active = selected.has(Number(button.dataset.page));
      button.classList.toggle("selected", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  function getSelectedPages(side) {
    return [...state.pageSelection[side]].sort((first, second) => first - second);
  }

  function getPagePairs() {
    const leftPages = getSelectedPages("left");
    const rightPages = getSelectedPages("right");
    const count = Math.max(leftPages.length, rightPages.length);
    if (!count || !leftPages.length || !rightPages.length) return [];
    return Array.from({ length: count }, (_, index) => ({
      leftPage: pageForPair(leftPages, index, count),
      rightPage: pageForPair(rightPages, index, count),
    }));
  }

  function pageForPair(pages, index, pairCount) {
    if (pages.length === 1 || pairCount === 1) return pages[0];
    const position = index / (pairCount - 1);
    return pages[Math.round(position * (pages.length - 1))];
  }

  function getActivePair() {
    return getPagePairs()[state.roiPairIndex] || null;
  }

  function pagePairKey(pair) {
    return pair ? pair.leftPage + ":" + pair.rightPage : "";
  }

  function describePagePair(pair) {
    return "ต้นฉบับ " + pair.leftPage + " / ฉบับ " + pair.rightPage;
  }

  function pageNumbers(count) {
    return Array.from({ length: count }, (_, index) => index + 1);
  }

  function parsePageExpression(value, maximum) {
    const raw = String(value || "").trim();
    if (!raw) return new Set();
    const pages = new Set();
    raw.split(",").map((part) => part.trim()).filter(Boolean).forEach((part) => {
      const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
      if (!match) throw new Error("ระบุหน้าเป็น 1,5-8");
      const first = Number(match[1]);
      const last = Number(match[2] || match[1]);
      if (first < 1 || last < first || last > maximum) throw new Error("หน้าต้องอยู่ระหว่าง 1 ถึง " + maximum);
      for (let page = first; page <= last; page += 1) pages.add(page);
    });
    return pages;
  }

  function formatPageExpression(pages) {
    if (!pages.length) return "";
    const parts = [];
    let start = pages[0];
    let end = pages[0];
    pages.slice(1).forEach((page) => {
      if (page === end + 1) {
        end = page;
        return;
      }
      parts.push(start === end ? String(start) : start + "-" + end);
      start = page;
      end = page;
    });
    parts.push(start === end ? String(start) : start + "-" + end);
    return parts.join(",");
  }

  async function loadFile(side, file) {
    if (!isSupportedDocument(file)) {
      setProgressIdle("รองรับ PDF, PNG, JPG และ WEBP เท่านั้น");
      return;
    }
    const fileToken = state.loadTokens[side] + 1;
    state.loadTokens[side] = fileToken;
    state.loadingSides[side] = true;
    clearPagePicker();
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
    state.pageSelection.left = new Set(pageNumbers(state.leftSource.pageCount));
    state.pageSelection.right = new Set(pageNumbers(state.rightSource.pageCount));
    state.pageSelectionAnchors.left = null;
    state.pageSelectionAnchors.right = null;
    state.roiPairIndex = 0;
    rebuildPagePicker();
    setProgressIdle("พร้อมเทียบ " + getPagePairs().length + " คู่หน้า");
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
    clearPagePicker();
    clearRoiState();
    els.leftInput.value = "";
    els.rightInput.value = "";
    els.leftMeta.textContent = "PDF หรือภาพ";
    els.rightMeta.textContent = "PDF หรือภาพ";
    clearResults();
    setProgressIdle("เลือกเอกสารสองไฟล์");
    updateButtons();
  }

  async function runComparison() {
    if (state.processing || !state.leftSource || !state.rightSource) return;
    const pagePairs = getPagePairs();
    if (!pagePairs.length) {
      setProgressIdle("เลือกหน้าอย่างน้อยหนึ่งคู่ก่อนเริ่มเปรียบเทียบ");
      return;
    }

    const useGemini = els.useGemini.checked;
    const apiKey = els.geminiKey.value.trim();
    const comparisonToken = state.compareToken + 1;
    state.compareToken = comparisonToken;
    state.processing = true;
    clearResults();
    updateButtons();
    const total = pagePairs.length;
    const rows = [];

    try {
      for (const [index, pair] of pagePairs.entries()) {
        if (comparisonToken !== state.compareToken) return;
        const completed = index;
        const pairLabel = describePagePair(pair);
        setProgressValue("กำลังเทียบ " + pairLabel, completed, total);
        const [leftCanvas, rightCanvas, leftTextPage, rightTextPage] = await Promise.all([
          state.leftSource.renderPage(pair.leftPage),
          state.rightSource.renderPage(pair.rightPage),
          state.leftSource.extractTextPage(pair.leftPage),
          state.rightSource.extractTextPage(pair.rightPage),
        ]);
        const leftRegion = getRoi(pair.leftPage, "left");
        const rightRegion = getRoi(pair.rightPage, "right");
        const textAvailable = hasUsablePdfText(leftTextPage, rightTextPage, leftRegion, rightRegion);
        const textFindings = textAvailable
          ? findPdfTextDifferences(leftTextPage, rightTextPage, leftRegion, rightRegion)
          : [];
        const textBoxes = textFindings.map((finding) => normalizedBoxToCanvas(finding.comparisonBox, rightCanvas, {
          label: finding.label,
          markerKind: finding.kind,
          markerDescription: finding.description,
        }));
        const leftArea = cropCanvas(leftCanvas, leftRegion);
        const rightArea = cropCanvas(rightCanvas, rightRegion);
        const visualFallback = !textAvailable && !useGemini;
        const comparison = comparePageCanvases(leftArea, rightArea, { detectVisual: visualFallback });
        let geminiPageBoxes = [];
        let gemini = null;
        if (useGemini) {
          setProgressValue("Gemini ตรวจทาน " + pairLabel, completed, total);
          try {
            gemini = normalizeGeminiReview(await reviewDocumentDifference({
              leftCanvas: comparison.referenceCanvas,
              rightCanvas: comparison.comparisonCanvas,
              page: pairLabel,
              apiKey,
              textEvidence: buildPdfTextEvidence(textFindings),
            }));
            const geminiBoxes = geminiReviewBoxes(gemini, comparison.comparisonCanvas.width, comparison.comparisonCanvas.height);
            geminiPageBoxes = mapCropBoxesToPage(geminiBoxes, rightRegion, rightCanvas, comparison.comparisonCanvas);
          } catch (error) {
            gemini = { error: cleanGeminiText(error.message) || "Gemini review failed." };
          }
        }
        const visualBoxes = visualFallback
          ? mapCropBoxesToPage(comparison.boxes, rightRegion, rightCanvas, comparison.comparisonCanvas)
          : [];
        const detectorBoxes = useGemini
          ? geminiPageBoxes
          : textAvailable
            ? textBoxes
            : visualBoxes;
        const boxes = numberMarkerBoxes(detectorBoxes);
        const markerDrawing = boxes.length ? drawDifferenceMarkers(rightCanvas, boxes) : null;
        const [imageBlob, annotationBlob] = markerDrawing
          ? await Promise.all([
            canvasToBlob(markerDrawing.previewCanvas),
            canvasToBlob(markerDrawing.overlayCanvas),
          ])
          : [null, null];
        rows.push({
          id: pagePairKey(pair),
          leftPage: pair.leftPage,
          rightPage: pair.rightPage,
          boxes,
          imageBlob,
          annotation: markerDrawing ? {
            overlayBlob: annotationBlob,
          } : null,
          gemini,
          visualComparable: comparison.visualComparable,
          comparisonSource: useGemini ? "gemini" : textAvailable ? "text" : "visual",
          textFindings,
          markerFindings: useGemini
            ? buildGeminiMarkerFindings(boxes, gemini)
            : boxes.map((box) => ({
              number: box.markerNumber,
              kind: box.markerKind || "visual",
              description: box.markerDescription || box.label || "พบความต่างจากภาพเอกสาร",
            })),
        });
        state.results = rows;
        renderResults();
        if (!state.selectedResultId && imageBlob) selectResult(pagePairKey(pair));
        setProgressValue("เทียบ " + pairLabel + " แล้ว", index + 1, total);
      }
      if (comparisonToken === state.compareToken) {
        const changedPages = rows.filter((row) => row.boxes.length).length;
        const needsSemanticReview = !useGemini && rows.some((row) => row.comparisonSource === "visual" && row.visualComparable === false);
        setProgressDone(
          changedPages
            ? "พบจุดต่าง " + changedPages + " คู่"
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
    state.selectedResultId = null;
    revokePreviewUrl();
    els.resultsPanel.hidden = true;
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
    els.resultsPanel.hidden = !state.results.length;
    els.pageCount.textContent = state.results.length;
    els.changedPageCount.textContent = changedRows.length;
    els.differenceCount.textContent = state.results.reduce((sum, row) => sum + row.boxes.length, 0);
    els.downloadPanel.hidden = !state.results.length;
    if (!state.results.length) return;
    els.resultBody.innerHTML = state.results.map((row) => {
      const detailText = row.gemini?.error
        ? "ตรวจไม่สำเร็จ"
        : row.gemini?.summary
          || row.textFindings?.[0]?.description
          || (row.comparisonSource === "text" ? "ไม่พบข้อมูลต่างจาก text layer" : (!row.visualComparable ? "โครงสร้างต่างกัน" : "-"));
      return `
        <tr data-result-id="${row.id}" class="${state.selectedResultId === row.id ? "selected" : ""}">
          <td>ต้นฉบับ ${row.leftPage} / ฉบับ ${row.rightPage}</td>
          <td><span class="difference-status ${row.boxes.length ? "has-difference" : "no-difference"}">${row.boxes.length ? `พบ ${row.boxes.length} จุด` : "ไม่พบ"}</span></td>
          <td class="gemini-summary">${escapeHtml(detailText)}</td>
        </tr>
      `;
    }).join("");
  }

  function selectResult(resultId) {
    const row = state.results.find((result) => result.id === resultId);
    if (!row) return;
    state.selectedResultId = resultId;
    renderResults();
    renderTextFindings(row.markerFindings);
    revokePreviewUrl();
    els.previewTitle.textContent = "ต้นฉบับ " + row.leftPage + " / ฉบับ " + row.rightPage;
    if (!row.imageBlob) {
      els.previewImage.hidden = true;
      els.previewEmpty.hidden = false;
      els.previewEmpty.textContent = "ไม่พบจุดต่างในคู่หน้านี้";
      els.downloadCurrent.disabled = false;
      return;
    }
    state.previewUrl = URL.createObjectURL(row.imageBlob);
    els.previewImage.src = state.previewUrl;
    els.previewImage.hidden = false;
    els.previewEmpty.hidden = true;
    els.downloadCurrent.disabled = false;
  }

  async function downloadComparedPdf() {
    const rows = state.results;
    if (!rows.length) return;
    els.downloadPdf.disabled = true;
    try {
      const pdfBytes = await buildComparisonPdf(rows);
      triggerDownload(new Blob([pdfBytes], { type: "application/pdf" }), "document-comparison.pdf");
    } catch (error) {
      setProgressIdle(error.message || "สร้าง PDF ที่เปรียบเทียบแล้วไม่สำเร็จ");
    } finally {
      els.downloadPdf.disabled = false;
    }
  }

  async function downloadCurrentComparisonPdf() {
    const row = state.results.find((result) => result.id === state.selectedResultId);
    if (!row) return;
    els.downloadCurrent.disabled = true;
    try {
      const pdfBytes = await buildComparisonPdf([row]);
      triggerDownload(new Blob([pdfBytes], { type: "application/pdf" }), comparisonPdfFilename(row));
    } catch (error) {
      setProgressIdle(error.message || "สร้าง PDF หน้านี้ไม่สำเร็จ");
    } finally {
      els.downloadCurrent.disabled = false;
    }
  }

  async function buildComparisonPdf(rows) {
    if (!state.rightFile) throw new Error("ไม่พบไฟล์ฉบับเปรียบเทียบ");
    const { PDFDocument } = await import("pdf-lib");
    const outputPdf = await PDFDocument.create();
    if (isPdf(state.rightFile)) {
      const sourcePdf = await PDFDocument.load(await state.rightFile.arrayBuffer(), { ignoreEncryption: true });
      for (const row of rows) {
        if (row.rightPage < 1 || row.rightPage > sourcePdf.getPageCount()) continue;
        const [copiedPage] = await outputPdf.copyPages(sourcePdf, [row.rightPage - 1]);
        const page = outputPdf.addPage(copiedPage);
        await drawPdfAnnotationOverlay(outputPdf, page, row.annotation);
      }
    } else {
      const sourceCanvas = await renderImageFile(state.rightFile);
      const sourceBlob = await canvasToBlob(sourceCanvas);
      const sourceImage = await outputPdf.embedPng(await sourceBlob.arrayBuffer());
      for (const row of rows) {
        const page = outputPdf.addPage([sourceImage.width, sourceImage.height]);
        page.drawImage(sourceImage, { x: 0, y: 0, width: sourceImage.width, height: sourceImage.height });
        await drawPdfAnnotationOverlay(outputPdf, page, row.annotation);
      }
    }
    outputPdf.setTitle("Document comparison");
    outputPdf.setSubject("Annotated document comparison");
    return outputPdf.save();
  }

  async function drawPdfAnnotationOverlay(pdf, page, annotation) {
    if (!annotation?.overlayBlob) return;
    const overlay = await pdf.embedPng(await annotation.overlayBlob.arrayBuffer());
    page.drawImage(overlay, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  }

  function updateButtons() {
    els.runButton.disabled = state.processing || state.loadingSides.left || state.loadingSides.right || !state.leftSource || !state.rightSource || !getPagePairs().length;
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
    els.progressCount.textContent = total ? `${completed}/${total} คู่ (${Math.round(percent)}%)` : "";
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
    els.textDifferenceList.innerHTML = findings.map((finding) => `
      <li>
        <span class="marker-number">${escapeHtml(finding.number)}</span>
        <span class="text-difference-kind">${escapeHtml(textFindingKind(finding.kind))}</span>
        <span class="text-difference-description">${escapeHtml(finding.description)}</span>
      </li>
    `).join("");
  }

  function clearRoiState() {
    state.roiRenderToken += 1;
    state.roiSelections.clear();
    state.roiPairIndex = 0;
    state.roiDrag = null;
    els.roiPanel.hidden = true;
    clearPreviewCanvas(els.roiLeftCanvas);
    clearPreviewCanvas(els.roiRightCanvas);
  }

  function roiSelectionKey(side, page) {
    return side + ":" + page;
  }

  function getRoi(page, side) {
    const selection = state.roiSelections.get(roiSelectionKey(side, page));
    return selection || FULL_REGION;
  }

  function hasCustomRoi(page, side) {
    return state.roiSelections.has(roiSelectionKey(side, page));
  }

  function setRoi(page, side, region) {
    state.roiSelections.set(roiSelectionKey(side, page), normalizeRoi(region));
    renderRoiSelection(side);
  }

  function resetRoi(side) {
    const pair = getActivePair();
    if (!pair) return;
    const page = side === "left" ? pair.leftPage : pair.rightPage;
    state.roiSelections.delete(roiSelectionKey(side, page));
    renderRoiSelection(side);
  }

  function changeRoiPair(offset) {
    const pairs = getPagePairs();
    const next = clamp(state.roiPairIndex + offset, 0, Math.max(0, pairs.length - 1));
    if (next === state.roiPairIndex) return;
    state.roiPairIndex = next;
    void renderRoiPreviews();
  }

  function applyRoiToSelectedPairs() {
    const active = getActivePair();
    const pairs = getPagePairs();
    if (!active || !pairs.length) return;
    const leftSelection = state.roiSelections.get(roiSelectionKey("left", active.leftPage));
    const rightSelection = state.roiSelections.get(roiSelectionKey("right", active.rightPage));
    pairs.forEach((pair) => {
      const leftKey = roiSelectionKey("left", pair.leftPage);
      const rightKey = roiSelectionKey("right", pair.rightPage);
      if (leftSelection) state.roiSelections.set(leftKey, { ...leftSelection });
      else state.roiSelections.delete(leftKey);
      if (rightSelection) state.roiSelections.set(rightKey, { ...rightSelection });
      else state.roiSelections.delete(rightKey);
    });
    setProgressIdle("ใช้พื้นที่ของ " + describePagePair(active) + " กับ " + pairs.length + " คู่หน้า");
  }

  async function renderRoiPreviews() {
    if (!state.leftSource || !state.rightSource) return;
    const pairs = getPagePairs();
    if (!pairs.length) {
      els.roiPanel.hidden = true;
      return;
    }
    state.roiPairIndex = clamp(state.roiPairIndex, 0, pairs.length - 1);
    const pair = pairs[state.roiPairIndex];
    const token = state.roiRenderToken + 1;
    state.roiRenderToken = token;
    els.roiPanel.hidden = false;
    updateRoiToolbar();
    try {
      const [leftCanvas, rightCanvas] = await Promise.all([
        state.leftSource.renderPage(pair.leftPage),
        state.rightSource.renderPage(pair.rightPage),
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
    const pairs = getPagePairs();
    const pair = getActivePair();
    els.roiPageLabel.textContent = pair
      ? "คู่ " + (state.roiPairIndex + 1) + "/" + pairs.length + " · " + describePagePair(pair)
      : "คู่หน้า -";
    els.roiPrevious.disabled = state.roiPairIndex <= 0;
    els.roiNext.disabled = state.roiPairIndex >= pairs.length - 1;
    els.roiApplyRange.disabled = !pair;
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
    const pair = getActivePair();
    if (!pair) return;
    const page = side === "left" ? pair.leftPage : pair.rightPage;
    const region = getRoi(page, side);
    const custom = hasCustomRoi(page, side);
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
      const pair = getActivePair();
      if (!pair) return;
      const page = side === "left" ? pair.leftPage : pair.rightPage;
      const point = getStagePoint(stage, event);
      const handle = event.target.closest(".roi-handle")?.dataset.handle;
      const startedOnSelection = event.target.closest(".roi-selection") === selection && hasCustomRoi(page, side);
      state.roiDrag = {
        side,
        page,
        mode: handle ? "resize" : startedOnSelection ? "move" : "create",
        handle,
        start: point,
        initial: { ...getRoi(page, side) },
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
    setRoi(drag.page, side, region);
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
    return { ...box, x: left, y: top, width: right - left, height: bottom - top };
  });
}

function numberMarkerBoxes(boxes) {
  return boxes.map((box, index) => ({ ...box, markerNumber: index + 1 }));
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
      renderThumbnail: async (pageNumber) => renderPdfPage(pdf, pageNumber, THUMBNAIL_RENDER_EDGE, true),
      extractTextPage: async (pageNumber) => extractPdfTextPage(pdf, pageNumber),
      close: () => pdf.destroy(),
    };
  }
  return {
    pageCount: 1,
    renderPage: async () => renderImageFile(file),
    renderThumbnail: async () => renderImageFile(file, THUMBNAIL_RENDER_EDGE),
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

async function renderPdfPage(pdf, pageNumber, maxRenderEdge = MAX_RENDER_EDGE, allowDownscale = false) {
  const page = await pdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const targetScale = maxRenderEdge / Math.max(baseViewport.width, baseViewport.height);
  const scale = Math.min(2.5, allowDownscale ? targetScale : Math.max(1, targetScale));
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

async function renderImageFile(file, maxRenderEdge = MAX_RENDER_EDGE) {
  const bitmap = await createImageBitmap(file);
  const targetScale = maxRenderEdge / Math.max(bitmap.width, bitmap.height);
  const scale = Math.min(1, targetScale);
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

function comparePageCanvases(leftCanvas, rightCanvas, { detectVisual = true } = {}) {
  const { referenceCanvas, comparisonCanvas } = normalizePair(leftCanvas, rightCanvas);
  if (!detectVisual) {
    return { referenceCanvas, comparisonCanvas, boxes: [], visualComparable: null };
  }
  const offset = findBestTranslation(comparisonCanvas, referenceCanvas);
  const alignedReference = translateCanvas(referenceCanvas, offset.x, offset.y);
  const visualComparable = offset.score <= MAX_VISUAL_ALIGNMENT_MISMATCH;
  const boxes = visualComparable ? findDifferenceBoxes(alignedReference, comparisonCanvas) : [];
  return { referenceCanvas: alignedReference, comparisonCanvas, boxes, visualComparable };
}

function normalizeGeminiReview(review) {
  const source = review && typeof review === "object" ? review : {};
  const changes = Array.isArray(source.changes)
    ? source.changes.map((change) => normalizeGeminiChange(change)).filter(Boolean)
    : [];
  const summary = cleanGeminiText(source.summary) || (changes.length ? `Gemini พบจุดต่าง ${changes.length} จุด` : "Gemini ไม่พบจุดต่างที่ยืนยันได้");
  return { ...source, summary, changes };
}

function buildGeminiMarkerFindings(boxes, review) {
  const markedChangeIndexes = new Set(boxes
    .map((box) => box.geminiChangeIndex)
    .filter((index) => Number.isInteger(index)));
  const marked = boxes.map((box) => ({
    number: box.markerNumber,
    kind: "gemini",
    description: box.markerDescription || box.label || "Gemini พบจุดต่างในบริเวณนี้",
  }));
  const unlocated = (review?.changes || [])
    .map((change, index) => ({ change, index }))
    .filter(({ index }) => !markedChangeIndexes.has(index))
    .map(({ change }) => ({
      number: "?",
      kind: "gemini",
      description: change.description || "Gemini พบจุดต่าง แต่ไม่ยืนยันตำแหน่งบนหน้าได้",
    }));
  return [...marked, ...unlocated];
}

function normalizeGeminiChange(change) {
  if (!change || typeof change !== "object") return null;
  const referenceText = cleanGeminiText(change.referenceText);
  const comparisonText = cleanGeminiText(change.comparisonText);
  const description = cleanGeminiText(change.description)
    || cleanGeminiText(change.summary)
    || describeGeminiChange(referenceText, comparisonText);
  return {
    ...change,
    location: cleanGeminiText(change.location),
    description,
    referenceText,
    comparisonText,
  };
}

function describeGeminiChange(referenceText, comparisonText) {
  if (referenceText && comparisonText) return `เปลี่ยนจาก ${referenceText} เป็น ${comparisonText}`;
  if (referenceText) return `ต้นฉบับมี ${referenceText} แต่ฉบับเปรียบเทียบไม่มี`;
  if (comparisonText) return `ฉบับเปรียบเทียบมี ${comparisonText} แต่ต้นฉบับไม่มี`;
  return "Gemini พบจุดต่างในบริเวณนี้";
}

function cleanGeminiText(value) {
  let text = String(value ?? "").trim();
  if (!text) return "";
  text = text.replace(/\\n/g, "\n").replace(/\\"/g, '"');
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (text.startsWith("{") && text.endsWith("}")) {
    try {
      const parsed = JSON.parse(text);
      return cleanGeminiText(parsed.summary || parsed.description || "");
    } catch {
      return "";
    }
  }
  return text
    .replace(/^\s*["']?(?:summary|description|location|referenceText|comparisonText)["']?\s*:\s*/i, "")
    .replace(/^\s*["']|["']\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function geminiReviewBoxes(review, width, height) {
  if (!Array.isArray(review?.changes)) return [];
  return review.changes.map((change, index) => {
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
    const description = String(change.description || "").trim();
    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      label: description || "Gemini พบจุดต่าง",
      markerKind: "gemini",
      markerDescription: description || "Gemini พบจุดต่างในบริเวณนี้",
      geminiChangeIndex: index,
    };
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
  const overlayCanvas = document.createElement("canvas");
  overlayCanvas.width = canvas.width;
  overlayCanvas.height = canvas.height;
  const context = overlayCanvas.getContext("2d");
  const lineWidth = Math.max(2, Math.round(Math.min(canvas.width, canvas.height) * 0.0026));
  const padding = Math.max(10, Math.round(Math.min(canvas.width, canvas.height) * 0.012));
  const badgeSize = clamp(Math.round(Math.min(canvas.width, canvas.height) * 0.026), 20, 32);
  const occupiedBadgeRects = [];
  const markers = boxes.map((box, index) => ({
    box,
    number: box.markerNumber || index + 1,
    radiusX: Math.max(16, (box.width / 2) + padding),
    radiusY: Math.max(16, (box.height / 2) + padding),
  }));

  context.strokeStyle = "#dc2626";
  context.lineWidth = lineWidth;
  context.lineJoin = "round";
  markers.forEach((marker) => {
    const { box, radiusX, radiusY } = marker;
    context.beginPath();
    context.ellipse(box.x + (box.width / 2), box.y + (box.height / 2), radiusX, radiusY, 0, 0, Math.PI * 2);
    context.stroke();
    drawMarkerBadge(context, canvas, box, radiusX, radiusY, marker.number, badgeSize, occupiedBadgeRects);
  });
  drawMarkerCallouts(context, canvas, markers);

  const previewCanvas = document.createElement("canvas");
  previewCanvas.width = canvas.width;
  previewCanvas.height = overlayCanvas.height;
  const previewContext = previewCanvas.getContext("2d", { alpha: false });
  previewContext.fillStyle = "#ffffff";
  previewContext.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
  previewContext.drawImage(canvas, 0, 0);
  previewContext.drawImage(overlayCanvas, 0, 0);
  return { previewCanvas, overlayCanvas };
}

function drawMarkerCallouts(context, documentCanvas, markers) {
  const baseFontSize = clamp(Math.round(Math.min(documentCanvas.width, documentCanvas.height) * 0.014), 15, 20);
  const fontSizes = [baseFontSize, Math.max(13, baseFontSize - 2), 12];
  let cards = [];
  for (const fontSize of fontSizes) {
    const candidates = createMarkerCalloutCards(context, documentCanvas, markers, fontSize);
    if (placeMarkerCallouts(documentCanvas, candidates, markers)) {
      cards = candidates;
      break;
    }
  }
  if (!cards.length) return;

  cards.forEach((card) => drawMarkerCalloutLeader(context, card));
  cards.forEach((card) => drawMarkerCallout(context, card));
}

function createMarkerCalloutCards(context, documentCanvas, markers, fontSize) {
  const cardPadding = Math.max(7, Math.round(fontSize * 0.46));
  const badgeSize = Math.max(18, Math.round(fontSize * 1.16));
  const lineHeight = Math.round(fontSize * 1.3);
  const maximumWidth = clamp(Math.round(documentCanvas.width * 0.3), 220, 390);
  const minimumWidth = Math.min(maximumWidth, Math.max(172, Math.round(documentCanvas.width * 0.16)));
  context.save();
  context.font = `600 ${fontSize}px Inter, Arial, sans-serif`;
  const cards = markers.map((marker) => {
    const text = String(marker.box.markerDescription || marker.box.label || "พบความต่างจากเอกสาร").replace(/\s+/g, " ").trim();
    const maximumTextWidth = maximumWidth - badgeSize - (cardPadding * 3);
    const lines = wrapCanvasText(context, text, maximumTextWidth, 4);
    const longestLine = Math.max(...lines.map((line) => context.measureText(line).width));
    const width = clamp(Math.ceil(longestLine + badgeSize + (cardPadding * 3)), minimumWidth, maximumWidth);
    return {
      ...marker,
      lines,
      fontSize,
      lineHeight,
      padding: cardPadding,
      badgeSize,
      width,
      height: Math.max(badgeSize + (cardPadding * 2), (lines.length * lineHeight) + (cardPadding * 2)),
    };
  });
  context.restore();
  return cards;
}

function placeMarkerCallouts(documentCanvas, cards, markers) {
  const sampler = createInkDensitySampler(documentCanvas);
  const protectedRects = markers.map((marker) => ({
    x: marker.box.x - marker.radiusX - 6,
    y: marker.box.y - marker.radiusY - 6,
    width: (marker.radiusX * 2) + 12,
    height: (marker.radiusY * 2) + 12,
  }));
  const occupied = [];
  const ordered = [...cards].sort((first, second) => second.height - first.height || first.box.y - second.box.y || first.number - second.number);
  for (const card of ordered) {
    const placement = findMarkerCalloutPlacement(documentCanvas, card, occupied, protectedRects, sampler);
    if (!placement) return false;
    card.x = placement.x;
    card.y = placement.y;
    occupied.push({ x: card.x, y: card.y, width: card.width, height: card.height });
  }
  return true;
}

function findMarkerCalloutPlacement(canvas, card, occupied, protectedRects, sampler) {
  const margin = Math.max(8, Math.round(card.fontSize * 0.5));
  const candidates = buildMarkerCalloutCandidates(canvas, card, margin);
  let best = null;
  for (const candidate of candidates) {
    const rect = { x: candidate.x, y: candidate.y, width: card.width, height: card.height };
    if (!rectFitsCanvas(rect, canvas, margin)) continue;
    if (occupied.some((occupiedRect) => rectanglesOverlap(rect, occupiedRect, margin))) continue;
    const protectedArea = protectedRects.reduce((total, protectedRect) => total + rectangleIntersectionArea(rect, protectedRect), 0);
    const distance = Math.hypot(
      (rect.x + (rect.width / 2)) - (card.box.x + (card.box.width / 2)),
      (rect.y + (rect.height / 2)) - (card.box.y + (card.box.height / 2)),
    );
    const score = (sampler(rect) * 3200) + (protectedArea * 0.08) + (distance * 0.15);
    if (!best || score < best.score) best = { ...rect, score };
  }
  return best;
}

function buildMarkerCalloutCandidates(canvas, card, margin) {
  const box = card.box;
  const left = box.x - card.radiusX;
  const right = box.x + box.width + card.radiusX;
  const top = box.y - card.radiusY;
  const bottom = box.y + box.height + card.radiusY;
  const candidates = [];
  const offsets = [8, 20, 44, 76, 118, 172, 240, 320];
  offsets.forEach((offset) => {
    candidates.push(
      { x: right + offset, y: top - card.height - offset },
      { x: right + offset, y: bottom + offset },
      { x: left - card.width - offset, y: top - card.height - offset },
      { x: left - card.width - offset, y: bottom + offset },
      { x: right + offset, y: (top + bottom - card.height) / 2 },
      { x: left - card.width - offset, y: (top + bottom - card.height) / 2 },
    );
  });

  const columnGap = Math.max(20, Math.round(card.fontSize * 1.2));
  const rowGap = Math.max(14, Math.round(card.fontSize * 0.9));
  for (let y = margin; y + card.height <= canvas.height - margin; y += card.height + rowGap) {
    for (let x = margin; x + card.width <= canvas.width - margin; x += card.width + columnGap) {
      candidates.push({ x, y });
    }
  }
  return candidates;
}

function drawMarkerCallout(context, card) {
  const radius = Math.max(6, Math.round(card.fontSize * 0.3));
  const x = card.x;
  const y = card.y;
  context.fillStyle = "rgba(255, 255, 255, 0.96)";
  context.strokeStyle = "#fecaca";
  context.lineWidth = 1;
  context.beginPath();
  context.roundRect(x, y, card.width, card.height, radius);
  context.fill();
  context.stroke();

  const badgeX = x + card.padding + (card.badgeSize / 2);
  const badgeY = y + card.padding + (card.badgeSize / 2);
  context.fillStyle = "#dc2626";
  context.beginPath();
  context.arc(badgeX, badgeY, card.badgeSize / 2, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#ffffff";
  context.font = `700 ${Math.max(11, Math.round(card.fontSize * 0.56))}px Inter, Arial, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(String(card.number), badgeX, badgeY + 0.5);

  context.fillStyle = "#991b1b";
  context.font = `600 ${card.fontSize}px Inter, Arial, sans-serif`;
  context.textAlign = "left";
  context.textBaseline = "top";
  const textX = x + card.padding + card.badgeSize + card.padding;
  const textY = y + card.padding;
  card.lines.forEach((line, index) => context.fillText(line, textX, textY + (index * card.lineHeight)));
}

function drawMarkerCalloutLeader(context, card) {
  const centerX = card.box.x + (card.box.width / 2);
  const centerY = card.box.y + (card.box.height / 2);
  const targetX = clamp(centerX, card.x, card.x + card.width);
  const targetY = clamp(centerY, card.y, card.y + card.height);
  const dx = targetX - centerX;
  const dy = targetY - centerY;
  const scale = 1 / Math.max(1, Math.sqrt((dx * dx) / (card.radiusX * card.radiusX) + (dy * dy) / (card.radiusY * card.radiusY)));
  const sourceX = centerX + (dx * scale);
  const sourceY = centerY + (dy * scale);
  context.save();
  context.strokeStyle = "rgba(220, 38, 38, 0.78)";
  context.lineWidth = Math.max(1, Math.round(card.fontSize * 0.1));
  context.beginPath();
  context.moveTo(sourceX, sourceY);
  context.lineTo(targetX, targetY);
  context.stroke();
  context.restore();
}

function createInkDensitySampler(canvas) {
  const { data, width, height } = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  return (rect) => {
    const step = Math.max(5, Math.round(Math.min(rect.width, rect.height) / 14));
    let samples = 0;
    let ink = 0;
    for (let y = Math.max(0, Math.floor(rect.y)); y < Math.min(height, Math.ceil(rect.y + rect.height)); y += step) {
      for (let x = Math.max(0, Math.floor(rect.x)); x < Math.min(width, Math.ceil(rect.x + rect.width)); x += step) {
        const offset = ((y * width) + x) * 4;
        const brightness = data[offset] + data[offset + 1] + data[offset + 2];
        if (brightness < 690) ink += 1;
        samples += 1;
      }
    }
    return ink / Math.max(1, samples);
  };
}

function rectFitsCanvas(rect, canvas, margin) {
  return rect.x >= margin
    && rect.y >= margin
    && rect.x + rect.width <= canvas.width - margin
    && rect.y + rect.height <= canvas.height - margin;
}

function rectangleIntersectionArea(first, second) {
  const left = Math.max(first.x, second.x);
  const top = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function wrapCanvasText(context, value, maximumWidth, maximumLines) {
  const text = String(value || "").trim();
  if (!text) return ["พบความต่างจากเอกสาร"];
  const segments = typeof Intl?.Segmenter === "function"
    ? [...new Intl.Segmenter("th", { granularity: "word" }).segment(text)].map((part) => part.segment)
    : Array.from(text);
  const lines = [];
  let line = "";
  for (const segment of segments) {
    const candidate = line + segment;
    if (line && context.measureText(candidate).width > maximumWidth) {
      lines.push(line.trimEnd());
      line = segment.trimStart();
      if (lines.length >= maximumLines) break;
    } else {
      line = candidate;
    }
  }
  if (line && lines.length < maximumLines) lines.push(line.trimEnd());
  if (!lines.length) return [text];
  if (lines.length === maximumLines && context.measureText(lines.at(-1)).width > maximumWidth) {
    lines[lines.length - 1] = truncateCanvasText(context, lines.at(-1), maximumWidth);
  }
  return lines;
}

function truncateCanvasText(context, value, maximumWidth) {
  if (context.measureText(value).width <= maximumWidth) return value;
  const characters = Array.from(String(value || ""));
  while (characters.length > 1 && context.measureText(`${characters.join("")}...`).width > maximumWidth) characters.pop();
  return `${characters.join("")}...`;
}

function drawMarkerBadge(context, canvas, box, radiusX, radiusY, number, badgeSize, occupiedRects) {
  const placement = findMarkerBadgePlacement(canvas, box, radiusX, radiusY, badgeSize, occupiedRects);
  const fontSize = Math.max(11, Math.round(badgeSize * 0.52));
  context.save();
  context.fillStyle = "#dc2626";
  context.beginPath();
  context.arc(placement.x, placement.y, badgeSize / 2, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#ffffff";
  context.font = `700 ${fontSize}px Inter, Arial, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(String(number), placement.x, placement.y + 0.5);
  context.restore();
}

function findMarkerBadgePlacement(canvas, box, radiusX, radiusY, badgeSize, occupiedRects) {
  const centerX = box.x + (box.width / 2);
  const centerY = box.y + (box.height / 2);
  const halfBadge = badgeSize / 2;
  const inset = halfBadge + 4;
  const candidates = [];
  for (let ring = 0; ring < 9; ring += 1) {
    const offset = (ring * (badgeSize + 5)) + halfBadge + 4;
    candidates.push(
      { x: centerX + radiusX + offset, y: centerY - radiusY - offset },
      { x: centerX - radiusX - offset, y: centerY - radiusY - offset },
      { x: centerX + radiusX + offset, y: centerY + radiusY + offset },
      { x: centerX - radiusX - offset, y: centerY + radiusY + offset },
    );
  }
  for (const candidate of candidates) {
    const x = clamp(candidate.x, inset, canvas.width - inset);
    const y = clamp(candidate.y, inset, canvas.height - inset);
    const rect = { x: x - halfBadge, y: y - halfBadge, width: badgeSize, height: badgeSize };
    if (!occupiedRects.some((occupied) => rectanglesOverlap(rect, occupied, 4))) {
      occupiedRects.push(rect);
      return { x, y };
    }
  }
  const fallback = { x: clamp(centerX + radiusX + halfBadge, inset, canvas.width - inset), y: clamp(centerY - radiusY - halfBadge, inset, canvas.height - inset) };
  occupiedRects.push({ x: fallback.x - halfBadge, y: fallback.y - halfBadge, width: badgeSize, height: badgeSize });
  return fallback;
}

function rectanglesOverlap(first, second, padding = 0) {
  return first.x - padding < second.x + second.width
    && first.x + first.width + padding > second.x
    && first.y - padding < second.y + second.height
    && first.y + first.height + padding > second.y;
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

function comparisonPdfFilename(row) {
  const leftPage = String(row.leftPage).padStart(3, "0");
  const rightPage = String(row.rightPage).padStart(3, "0");
  return "comparison_reference_" + leftPage + "_comparison_" + rightPage + ".pdf";
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
  if (kind === "visual") return "ภาพ";
  if (kind === "gemini") return "Gemini";
  return "แก้ไข";
}
