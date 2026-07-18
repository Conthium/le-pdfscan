import { createIcons, icons } from "lucide";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerSource from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import {
  createGeminiImageParts,
  DEFAULT_EXHAUSTIVE_GEMINI_PROMPT,
  DEFAULT_GEMINI_PROMPT,
  reviewDocumentDifference,
} from "./gemini.js";
import { buildPdfTextEvidence, createPdfTextPage, findPdfTextMatches } from "./pdfTextDiff.js";

GlobalWorkerOptions.workerSrc = pdfWorkerSource;

const MAX_RENDER_EDGE = 1800;
const THUMBNAIL_RENDER_EDGE = 240;
const MIN_COMPONENT_PIXELS = 24;
const FULL_REGION = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });
const MIN_REGION_SIZE = 0.025;
const MAX_VISUAL_ALIGNMENT_MISMATCH = 0.065;
const MIN_KEYBOARD_VIEWPORT_CHANGE = 120;
const KEYBOARD_VIEWPORT_POLL_INTERVAL = 120;

function isKnownDefaultComparePrompt(value) {
  const text = String(value || "").trim();
  return !text
    || text === DEFAULT_GEMINI_PROMPT
    || text === DEFAULT_EXHAUSTIVE_GEMINI_PROMPT;
}

export function createDocumentCompare(root, options = {}) {
  const geminiButton = options.geminiButton || null;
  const geminiHeaderStatus = options.geminiHeaderStatus || null;
  const geminiDialog = options.geminiDialog || null;
  const geminiDialogKey = options.geminiDialogKey || null;
  const geminiDialogClose = options.geminiDialogClose || null;
  const geminiDialogCancel = options.geminiDialogCancel || null;
  const geminiDialogClear = options.geminiDialogClear || null;
  const geminiDialogSave = options.geminiDialogSave || null;
  const state = {
    leftSource: null,
    rightSource: null,
    leftFile: null,
    rightFile: null,
    loadingSides: { left: false, right: false },
    processing: false,
    downloading: false,
    compareToken: 0,
    loadTokens: { left: 0, right: 0 },
    results: [],
    selectedResultId: null,
    previewUrl: null,
    previewFullscreen: false,
    previewZoom: 1,
    pageSelection: { left: new Set(), right: new Set() },
    pageSelectionAnchors: { left: null, right: null },
    pagePickerToken: 0,
    thumbnailObserver: null,
    roiPages: { left: null, right: null },
    roiRenderToken: 0,
    roiSelections: new Map(),
    roiDrag: null,
    roiEditing: { left: false, right: false },
    promptExpanded: false,
    promptDockCollapsedHeight: 0,
    promptCollapseTimer: null,
    keyboardInset: 0,
    keyboardViewportFrame: 0,
    keyboardViewportTimer: null,
    keyboardViewportBaselineHeight: 0,
    keyboardViewportWidth: 0,
    scanMode: "focused",
    promptIsCustom: false,
    focusedPrompt: DEFAULT_GEMINI_PROMPT,
    exhaustiveContext: "",
    geminiKey: "",
  };
  let geminiWorker = null;
  let geminiWorkerRequestId = 0;
  const geminiWorkerRequests = new Map();

  root.innerHTML = `
    <section class="workspace compare-workspace">
      <section class="compare-setup">
        <div class="compare-setup-heading">
          <div>
            <p class="eyebrow">Document compare</p>
            <h2>เลือกเอกสาร</h2>
          </div>
          <div class="compare-header-actions">
            <div class="compare-mode-control compare-header-mode-control" role="group" aria-label="เลือกโหมดสแกน">
              <button class="mode-button active" id="compareModeFocused" type="button" data-mode="focused">สแกนเฉพาะสาระสำคัญ</button>
              <button class="mode-button" id="compareModeExhaustive" type="button" data-mode="exhaustive">สแกนทั้งหมด</button>
            </div>
            <button class="icon-button" id="compareResetButton" type="button" title="ล้างเอกสาร" aria-label="ล้างเอกสาร"><i data-lucide="rotate-ccw"></i></button>
          </div>
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
        </div>
        <div class="roi-editor-grid">
          <section class="roi-document">
            <div class="roi-document-header">
              <span>ต้นฉบับ</span>
              <div class="roi-document-actions">
                <div class="roi-page-picker">
                  <span>หน้า</span>
                  <button class="icon-button" id="compareRoiLeftPrevious" type="button" title="หน้าต้นฉบับก่อนหน้า" aria-label="หน้าต้นฉบับก่อนหน้า"><i data-lucide="chevron-left"></i></button>
                  <select id="compareRoiLeftPage" aria-label="เลือกหน้าต้นฉบับสำหรับกำหนดพื้นที่"></select>
                  <button class="icon-button" id="compareRoiLeftNext" type="button" title="หน้าต้นฉบับถัดไป" aria-label="หน้าต้นฉบับถัดไป"><i data-lucide="chevron-right"></i></button>
                </div>
                <button class="icon-button roi-edit" id="compareRoiEditLeft" type="button" title="แก้ไขพื้นที่ครอปต้นฉบับ" aria-label="แก้ไขพื้นที่ครอปต้นฉบับ" aria-pressed="false"><i data-lucide="crop"></i></button>
                <button class="icon-button" id="compareRoiResetLeft" type="button" title="ใช้ทั้งหน้าต้นฉบับ" aria-label="ใช้ทั้งหน้าต้นฉบับ"><i data-lucide="rotate-ccw"></i></button>
                <button class="icon-button" id="compareRoiApplyLeft" type="button" title="คัดลอกพื้นที่นี้ไปยังหน้าต้นฉบับที่เลือก" aria-label="คัดลอกพื้นที่นี้ไปยังหน้าต้นฉบับที่เลือก"><i data-lucide="copy"></i></button>
              </div>
            </div>
            <div class="roi-stage" id="compareRoiLeftStage">
              <canvas id="compareRoiLeftCanvas"></canvas>
              <div class="roi-selection default" id="compareRoiLeftSelection" data-side="left">
                <span class="roi-handle nw" data-handle="nw"></span><span class="roi-handle n" data-handle="n"></span><span class="roi-handle ne" data-handle="ne"></span>
                <span class="roi-handle e" data-handle="e"></span><span class="roi-handle se" data-handle="se"></span><span class="roi-handle s" data-handle="s"></span>
                <span class="roi-handle sw" data-handle="sw"></span><span class="roi-handle w" data-handle="w"></span>
              </div>
            </div>
          </section>
          <section class="roi-document">
            <div class="roi-document-header">
              <span>ฉบับเปรียบเทียบ</span>
              <div class="roi-document-actions">
                <div class="roi-page-picker">
                  <span>หน้า</span>
                  <button class="icon-button" id="compareRoiRightPrevious" type="button" title="หน้าฉบับเปรียบเทียบก่อนหน้า" aria-label="หน้าฉบับเปรียบเทียบก่อนหน้า"><i data-lucide="chevron-left"></i></button>
                  <select id="compareRoiRightPage" aria-label="เลือกหน้าฉบับเปรียบเทียบสำหรับกำหนดพื้นที่"></select>
                  <button class="icon-button" id="compareRoiRightNext" type="button" title="หน้าฉบับเปรียบเทียบถัดไป" aria-label="หน้าฉบับเปรียบเทียบถัดไป"><i data-lucide="chevron-right"></i></button>
                </div>
                <button class="icon-button roi-edit" id="compareRoiEditRight" type="button" title="แก้ไขพื้นที่ครอปฉบับเปรียบเทียบ" aria-label="แก้ไขพื้นที่ครอปฉบับเปรียบเทียบ" aria-pressed="false"><i data-lucide="crop"></i></button>
                <button class="icon-button" id="compareRoiResetRight" type="button" title="ใช้ทั้งหน้าฉบับเปรียบเทียบ" aria-label="ใช้ทั้งหน้าฉบับเปรียบเทียบ"><i data-lucide="rotate-ccw"></i></button>
                <button class="icon-button" id="compareRoiApplyRight" type="button" title="คัดลอกพื้นที่นี้ไปยังหน้าฉบับเปรียบเทียบที่เลือก" aria-label="คัดลอกพื้นที่นี้ไปยังหน้าฉบับเปรียบเทียบที่เลือก"><i data-lucide="copy"></i></button>
              </div>
            </div>
            <div class="roi-stage" id="compareRoiRightStage">
              <canvas id="compareRoiRightCanvas"></canvas>
              <div class="roi-selection default" id="compareRoiRightSelection" data-side="right">
                <span class="roi-handle nw" data-handle="nw"></span><span class="roi-handle n" data-handle="n"></span><span class="roi-handle ne" data-handle="ne"></span>
                <span class="roi-handle e" data-handle="e"></span><span class="roi-handle se" data-handle="se"></span><span class="roi-handle s" data-handle="s"></span>
                <span class="roi-handle sw" data-handle="sw"></span><span class="roi-handle w" data-handle="w"></span>
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
              <div class="preview-heading-actions">
                <div class="preview-zoom-controls" id="comparePreviewZoomControls" aria-label="ควบคุมการซูมภาพ">
                  <button class="icon-button" id="comparePreviewZoomOut" type="button" title="ย่อภาพ" aria-label="ย่อภาพ" disabled><i data-lucide="zoom-out"></i></button>
                  <button class="preview-zoom-reset" id="comparePreviewZoomReset" type="button" title="รีเซ็ตการซูม" aria-label="รีเซ็ตการซูม"><span id="comparePreviewZoomLabel">100%</span></button>
                  <button class="icon-button" id="comparePreviewZoomIn" type="button" title="ขยายภาพ" aria-label="ขยายภาพ" disabled><i data-lucide="zoom-in"></i></button>
                </div>
                <button class="icon-button" id="compareTogglePreviewFullscreen" type="button" title="ดูภาพเต็มจอ" aria-label="ดูภาพเต็มจอ" disabled><i data-lucide="maximize-2"></i></button>
                <button class="icon-button" id="compareDownloadCurrent" type="button" title="ดาวน์โหลด PDF หน้านี้" disabled><i data-lucide="download"></i></button>
              </div>
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

      <section class="compare-command-dock" id="compareCommandDock" aria-label="คำสั่งเปรียบเทียบเอกสาร">
        <div class="compare-command-dock-inner">
          <div class="compare-dock-command-row">
            <div class="compare-prompt-field">
              <div class="compare-prompt-header">
                <button class="icon-button compare-prompt-expand" id="compareExpandPrompt" type="button" title="ขยาย Prompt" aria-label="ขยาย Prompt"><i data-lucide="chevron-up"></i></button>
                <div class="compare-prompt-heading">
                  <span class="compare-dock-label" id="comparePromptLabel">Prompt</span>
                  <span class="compare-prompt-helper" id="comparePromptHelper">กำหนดสิ่งที่ต้องตรวจ ละเว้น หรือถือว่าสำคัญ</span>
                </div>
                <div class="progress-wrap idle" id="compareProgressWrap" aria-live="polite">
                  <div class="progress-label"><span id="compareProgressText"></span><span id="compareProgressCount" class="progress-count"></span></div>
                  <div class="progress-track"><div id="compareProgressBar"></div></div>
                </div>
                <button class="icon-button compare-prompt-reset" id="compareResetPrompt" type="button" title="คืนค่า prompt เริ่มต้น" aria-label="คืนค่า prompt เริ่มต้น"><i data-lucide="rotate-ccw"></i></button>
              </div>
              <textarea id="comparePrompt" rows="3" aria-label="Prompt" aria-describedby="comparePromptHelper"></textarea>
            </div>
            <div class="compare-primary-actions">
              <button class="primary" id="compareRunButton" disabled><i data-lucide="scan-search"></i><span>เปรียบเทียบ</span></button>
              <div class="download-panel" id="compareDownloadPanel">
                <div class="download-status" id="compareDownloadStatus" role="status" aria-live="polite" aria-hidden="true">
                  <div class="download-status-row"><span id="compareDownloadStatusText">กำลังสร้าง PDF</span><span id="compareDownloadStatusCount"></span></div>
                  <div class="download-progress-track"><div id="compareDownloadProgressBar"></div></div>
                </div>
                <button class="download-link" id="compareDownloadPdf" disabled><i data-lucide="file-down"></i><span>ดาวน์โหลด</span></button>
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
    prompt: root.querySelector("#comparePrompt"),
    promptLabel: root.querySelector("#comparePromptLabel"),
    promptHelper: root.querySelector("#comparePromptHelper"),
    expandPrompt: root.querySelector("#compareExpandPrompt"),
    resetPrompt: root.querySelector("#compareResetPrompt"),
    modeFocused: root.querySelector("#compareModeFocused"),
    modeExhaustive: root.querySelector("#compareModeExhaustive"),
    commandDock: root.querySelector("#compareCommandDock"),
    runButton: root.querySelector("#compareRunButton"),
    resetButton: root.querySelector("#compareResetButton"),
    progressWrap: root.querySelector("#compareProgressWrap"),
    progressText: root.querySelector("#compareProgressText"),
    progressCount: root.querySelector("#compareProgressCount"),
    progressBar: root.querySelector("#compareProgressBar"),
    downloadPanel: root.querySelector("#compareDownloadPanel"),
    downloadStatus: root.querySelector("#compareDownloadStatus"),
    downloadStatusText: root.querySelector("#compareDownloadStatusText"),
    downloadStatusCount: root.querySelector("#compareDownloadStatusCount"),
    downloadProgressBar: root.querySelector("#compareDownloadProgressBar"),
    downloadPdf: root.querySelector("#compareDownloadPdf"),
    resultsPanel: root.querySelector("#compareResults"),
    resultBody: root.querySelector("#compareResultBody"),
    pageCount: root.querySelector("#comparePageCount"),
    changedPageCount: root.querySelector("#compareChangedPageCount"),
    differenceCount: root.querySelector("#compareDifferenceCount"),
    previewPanel: root.querySelector(".compare-preview-panel"),
    previewTitle: root.querySelector("#comparePreviewTitle"),
    previewImage: root.querySelector("#comparePreviewImage"),
    previewEmpty: root.querySelector("#comparePreviewEmpty"),
    togglePreviewFullscreen: root.querySelector("#compareTogglePreviewFullscreen"),
    previewZoomOut: root.querySelector("#comparePreviewZoomOut"),
    previewZoomReset: root.querySelector("#comparePreviewZoomReset"),
    previewZoomIn: root.querySelector("#comparePreviewZoomIn"),
    previewZoomLabel: root.querySelector("#comparePreviewZoomLabel"),
    downloadCurrent: root.querySelector("#compareDownloadCurrent"),
    textDifferencePanel: root.querySelector("#compareTextDifferencePanel"),
    textDifferenceList: root.querySelector("#compareTextDifferenceList"),
    roiPanel: root.querySelector("#compareRoiPanel"),
    roiLeftPage: root.querySelector("#compareRoiLeftPage"),
    roiRightPage: root.querySelector("#compareRoiRightPage"),
    roiLeftPrevious: root.querySelector("#compareRoiLeftPrevious"),
    roiLeftNext: root.querySelector("#compareRoiLeftNext"),
    roiRightPrevious: root.querySelector("#compareRoiRightPrevious"),
    roiRightNext: root.querySelector("#compareRoiRightNext"),
    roiEditLeft: root.querySelector("#compareRoiEditLeft"),
    roiEditRight: root.querySelector("#compareRoiEditRight"),
    roiApplyLeft: root.querySelector("#compareRoiApplyLeft"),
    roiApplyRight: root.querySelector("#compareRoiApplyRight"),
    roiResetLeft: root.querySelector("#compareRoiResetLeft"),
    roiResetRight: root.querySelector("#compareRoiResetRight"),
    roiLeftStage: root.querySelector("#compareRoiLeftStage"),
    roiRightStage: root.querySelector("#compareRoiRightStage"),
    roiLeftCanvas: root.querySelector("#compareRoiLeftCanvas"),
    roiRightCanvas: root.querySelector("#compareRoiRightCanvas"),
    roiLeftSelection: root.querySelector("#compareRoiLeftSelection"),
    roiRightSelection: root.querySelector("#compareRoiRightSelection"),
  };

  restoreGeminiSettings();
  bindFileZone("left");
  bindFileZone("right");
  bindPagePicker("left");
  bindPagePicker("right");
  els.runButton.addEventListener("click", runComparison);
  els.resetButton.addEventListener("click", resetComparison);
  els.downloadPdf.addEventListener("click", downloadComparedPdf);
  els.downloadCurrent.addEventListener("click", downloadCurrentComparisonPdf);
  els.togglePreviewFullscreen.addEventListener("click", togglePreviewFullscreen);
  els.previewZoomOut.addEventListener("click", () => setPreviewZoom(state.previewZoom - 0.25));
  els.previewZoomReset.addEventListener("click", () => setPreviewZoom(1));
  els.previewZoomIn.addEventListener("click", () => setPreviewZoom(state.previewZoom + 0.25));
  els.modeFocused.addEventListener("click", () => setScanMode("focused"));
  els.modeExhaustive.addEventListener("click", () => setScanMode("exhaustive"));
  els.expandPrompt.addEventListener("click", togglePromptExpanded);
  els.resetPrompt.addEventListener("click", handlePromptAction);
  els.prompt.addEventListener("input", handlePromptInput);
  geminiButton?.addEventListener("click", openGeminiDialog);
  geminiDialogClose?.addEventListener("click", closeGeminiDialog);
  geminiDialogCancel?.addEventListener("click", closeGeminiDialog);
  geminiDialogClear?.addEventListener("click", clearGeminiKey);
  geminiDialogSave?.addEventListener("click", saveGeminiKey);
  geminiDialog?.addEventListener("click", (event) => {
    if (event.target === geminiDialog) closeGeminiDialog();
  });
  els.roiLeftPage.addEventListener("change", () => selectRoiPage("left"));
  els.roiRightPage.addEventListener("change", () => selectRoiPage("right"));
  els.roiLeftPrevious.addEventListener("click", () => changeRoiPage("left", -1));
  els.roiLeftNext.addEventListener("click", () => changeRoiPage("left", 1));
  els.roiRightPrevious.addEventListener("click", () => changeRoiPage("right", -1));
  els.roiRightNext.addEventListener("click", () => changeRoiPage("right", 1));
  els.roiEditLeft.addEventListener("click", () => toggleRoiEditing("left"));
  els.roiEditRight.addEventListener("click", () => toggleRoiEditing("right"));
  els.roiApplyLeft.addEventListener("click", () => applyRoiToSelectedPages("left"));
  els.roiApplyRight.addEventListener("click", () => applyRoiToSelectedPages("right"));
  els.roiResetLeft.addEventListener("click", () => resetRoi("left"));
  els.roiResetRight.addEventListener("click", () => resetRoi("right"));
  bindRoiStage("left");
  bindRoiStage("right");
  document.addEventListener("visibilitychange", handleDocumentVisibility);
  window.addEventListener("focus", handleWindowFocus);
  document.addEventListener("focusin", scheduleKeyboardViewportSync);
  document.addEventListener("focusout", scheduleKeyboardViewportSync);
  window.addEventListener("resize", scheduleKeyboardViewportSync);
  window.addEventListener("orientationchange", scheduleKeyboardViewportSync);
  window.addEventListener("pageshow", scheduleKeyboardViewportSync);
  window.visualViewport?.addEventListener("resize", scheduleKeyboardViewportSync);
  window.visualViewport?.addEventListener("scroll", scheduleKeyboardViewportSync);
  document.addEventListener("keydown", handlePreviewKeydown);
  els.resultBody.addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-result-id]");
    if (row) selectResult(row.dataset.resultId);
  });
  setScanMode(state.scanMode);
  updatePromptExpandUi();
  scheduleKeyboardViewportSync();
  createIcons({ icons });

  function handleDocumentVisibility() {
    if (state.processing) updateProcessingUi();
    updateDocumentTitle();
    scheduleKeyboardViewportSync();
  }

  function handleWindowFocus() {
    if (state.processing) updateProcessingUi();
    updateDocumentTitle();
    scheduleKeyboardViewportSync();
  }

  function handlePreviewKeydown(event) {
    if (event.key !== "Escape" || !state.previewFullscreen) return;
    event.preventDefault();
    setPreviewFullscreen(false);
  }

  function scheduleKeyboardViewportSync() {
    if (state.keyboardViewportFrame) return;
    state.keyboardViewportFrame = window.requestAnimationFrame(() => {
      state.keyboardViewportFrame = 0;
      syncKeyboardViewport();
    });
  }

  function syncKeyboardViewport() {
    const dock = els.commandDock;
    const viewport = window.visualViewport;
    if (!dock) return;
    if (!viewport) {
      resetKeyboardViewport(dock);
      return;
    }

    const viewportTop = Math.max(0, viewport.offsetTop);
    const viewportBottom = viewport.height + viewportTop;
    const layoutHeight = Math.max(
      window.innerHeight || 0,
      document.documentElement.clientHeight || 0,
      viewportBottom,
    );
    const viewportWidth = Math.max(1, Math.round(viewport.width));
    const widthChanged = state.keyboardViewportWidth
      && Math.abs(viewportWidth - state.keyboardViewportWidth) > 48;
    if (!state.keyboardViewportBaselineHeight || widthChanged) {
      state.keyboardViewportBaselineHeight = layoutHeight;
    }
    state.keyboardViewportWidth = viewportWidth;

    const rawInset = state.keyboardViewportBaselineHeight - viewportBottom;
    const keyboardOpen = isKeyboardInputActive() && rawInset > MIN_KEYBOARD_VIEWPORT_CHANGE;
    if (!keyboardOpen) {
      state.keyboardViewportBaselineHeight = Math.max(
        state.keyboardViewportBaselineHeight,
        layoutHeight,
        viewportBottom,
      );
      resetKeyboardViewport(dock);
      return;
    }

    const keyboardInset = Math.round(Math.min(
      state.keyboardViewportBaselineHeight,
      Math.max(0, rawInset),
    ));
    state.keyboardInset = keyboardInset;
    dock.style.setProperty("--compare-viewport-top", `${Math.round(viewportTop)}px`);
    dock.style.setProperty("--compare-keyboard-inset", `${keyboardInset}px`);
    dock.classList.add("keyboard-open");
    scheduleKeyboardViewportMonitor();
  }

  function isKeyboardInputActive() {
    const active = document.activeElement;
    return Boolean(active?.isContentEditable || active?.matches?.(
      'input:not([type="file"]):not([type="checkbox"]):not([type="radio"]), textarea, select',
    ));
  }

  function scheduleKeyboardViewportMonitor() {
    if (state.keyboardViewportTimer) return;
    state.keyboardViewportTimer = window.setTimeout(() => {
      state.keyboardViewportTimer = null;
      if (state.keyboardInset > 0) syncKeyboardViewport();
    }, KEYBOARD_VIEWPORT_POLL_INTERVAL);
  }

  function resetKeyboardViewport(dock = els.commandDock) {
    if (state.keyboardViewportTimer) {
      window.clearTimeout(state.keyboardViewportTimer);
      state.keyboardViewportTimer = null;
    }
    state.keyboardInset = 0;
    dock?.classList.remove("keyboard-open");
    dock?.style.removeProperty("--compare-keyboard-inset");
    dock?.style.removeProperty("--compare-viewport-top");
    dock?.style.removeProperty("--compare-viewport-height");
    dock?.style.removeProperty("--compare-layout-height");
  }

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
    state.roiPages.left = null;
    state.roiPages.right = null;
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
    normalizeRoiPages();
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

  function normalizeRoiPages() {
    ["left", "right"].forEach((side) => {
      const pages = getSelectedPages(side);
      if (!pages.includes(state.roiPages[side])) state.roiPages[side] = pages[0] || null;
    });
  }

  function getActiveRoiPage(side) {
    return state.roiPages[side];
  }

  function pagePairKey(pair) {
    return pair ? pair.leftPage + ":" + pair.rightPage : "";
  }

  function describePagePair(pair) {
    return "ต้นฉบับ " + pair.leftPage + " / ฉบับเทียบ " + pair.rightPage;
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
    state.roiPages.left = 1;
    state.roiPages.right = 1;
    rebuildPagePicker();
    setProgressIdle("พร้อมเทียบ " + getPagePairs().length + " คู่หน้า");
    void renderRoiPreviews();
  }

  function resetComparison() {
    state.compareToken += 1;
    stopGeminiWorker();
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
    state.downloading = false;
    setDownloadProgress(0, 0);
    setPromptExpanded(false);
    clearPagePicker();
    clearRoiState();
    els.leftInput.value = "";
    els.rightInput.value = "";
    els.leftMeta.textContent = "PDF หรือภาพ";
    els.rightMeta.textContent = "PDF หรือภาพ";
    clearResults();
    setProgressIdle("เลือกเอกสารสองไฟล์");
    updateProcessingUi();
    updateButtons();
  }

  async function runComparison() {
    if (state.processing || !state.leftSource || !state.rightSource) return;
    const pagePairs = getPagePairs();
    if (!pagePairs.length) {
      setProgressIdle("เลือกหน้าอย่างน้อยหนึ่งคู่ก่อนเริ่มเปรียบเทียบ");
      return;
    }

    const apiKey = state.geminiKey.trim();
    if (!apiKey) {
      setProgressIdle("ตั้งค่า Gemini API key ก่อนเริ่มเปรียบเทียบ");
      updateButtons();
      return;
    }
    const scanMode = state.scanMode;
    const userPrompt = scanMode === "focused" ? els.prompt.value.trim() : "";
    const documentContext = scanMode === "exhaustive" ? els.prompt.value.trim() : "";
    const userPromptIsCustom = scanMode === "focused" && state.promptIsCustom;
    if (state.promptExpanded) setPromptExpanded(false);
    setRoiEditing("left", false);
    setRoiEditing("right", false);
    const comparisonToken = state.compareToken + 1;
    state.compareToken = comparisonToken;
    state.processing = true;
    clearResults();
    updateProcessingUi();
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
        const leftArea = cropCanvas(leftCanvas, leftRegion);
        const rightArea = cropCanvas(rightCanvas, rightRegion);
        const comparison = comparePageCanvases(leftArea, rightArea, { detectVisual: false });
        const textEvidence = buildPdfTextEvidence(leftTextPage, rightTextPage, leftRegion, rightRegion);
        const textCandidates = parseTextEvidenceCandidates(textEvidence);
        let geminiPageBoxes = [];
        let gemini = null;
        setProgressValue("Gemini วิเคราะห์ " + pairLabel, completed, total);
        try {
          gemini = normalizeGeminiReview(await reviewGeminiInBackground({
            leftCanvas: comparison.referenceCanvas,
            rightCanvas: comparison.comparisonCanvas,
            page: pairLabel,
            apiKey,
            scanMode,
            userPrompt,
            documentContext,
            userPromptIsCustom,
            textEvidence,
            cropRegion: { left: leftRegion, right: rightRegion },
          }), scanMode, textCandidates, userPromptIsCustom);
          const rawGeminiBoxes = geminiReviewBoxes(gemini, comparison.comparisonCanvas.width, comparison.comparisonCanvas.height);
          const rawGeminiPageBoxes = mapCropBoxesToPage(rawGeminiBoxes, rightRegion, rightCanvas, comparison.comparisonCanvas);
          geminiPageBoxes = clipBoxesToRoi(groundGeminiBoxesToPdfText(
            gemini,
            rightTextPage,
            rightRegion,
            rightCanvas,
            rawGeminiPageBoxes,
            textCandidates,
          ), rightRegion, rightCanvas);
        } catch (error) {
          gemini = { error: cleanGeminiText(error.message) || "Gemini review failed." };
        }
        if (comparisonToken !== state.compareToken) return;
        const detectorBoxes = geminiPageBoxes;
        const boxes = numberMarkerBoxes(detectorBoxes);
        const annotationBoxes = groupMarkerBoxesForDisplay(boxes, rightCanvas);
        const markerDrawing = annotationBoxes.length ? drawDifferenceMarkers(rightCanvas, annotationBoxes) : null;
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
          comparisonSource: "gemini",
          textFindings: [],
          markerFindings: buildGeminiMarkerFindings(boxes, gemini),
        });
        state.results = rows;
        renderResults();
        if (!state.selectedResultId && imageBlob) selectResult(pagePairKey(pair));
        setProgressValue("เทียบ " + pairLabel + " แล้ว", index + 1, total);
      }
      if (comparisonToken === state.compareToken) {
        const changedPages = rows.filter((row) => row.boxes.length).length;
        const failedPages = rows.filter((row) => row.gemini?.error).length;
        setProgressDone(failedPages
          ? `เทียบเสร็จ ${rows.length}/${total} คู่ แต่ Gemini ผิดพลาด ${failedPages} คู่`
          : changedPages
            ? "พบจุดต่าง " + changedPages + " คู่"
            : "ไม่พบจุดต่าง");
      }
    } catch (error) {
      if (comparisonToken === state.compareToken) setProgressIdle(error.message || "เปรียบเทียบไม่สำเร็จ");
    } finally {
      if (comparisonToken === state.compareToken) {
        state.processing = false;
        updateProcessingUi();
        updateButtons();
      }
    }
  }

  function reviewGeminiInBackground(options) {
    const worker = getGeminiWorker();
    if (!worker) return reviewDocumentDifference(options);
    const { leftCanvas, rightCanvas, ...request } = options;
    return createGeminiImageParts(leftCanvas, rightCanvas).then(([leftImage, rightImage]) => (
      new Promise((resolve, reject) => {
        const id = ++geminiWorkerRequestId;
        geminiWorkerRequests.set(id, { resolve, reject });
        try {
          worker.postMessage({
            id,
            args: { ...request, leftImage, rightImage },
          });
        } catch (error) {
          geminiWorkerRequests.delete(id);
          reject(error instanceof Error ? error : new Error("เริ่ม Gemini worker ไม่สำเร็จ"));
        }
      })
    ));
  }

  function getGeminiWorker() {
    if (geminiWorker) return geminiWorker;
    if (typeof Worker === "undefined") return null;
    const worker = new Worker(new URL("./geminiWorker.js", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event) => {
      const { id, ok, result, error } = event.data || {};
      const pending = geminiWorkerRequests.get(id);
      if (!pending) return;
      geminiWorkerRequests.delete(id);
      if (ok) pending.resolve(result);
      else pending.reject(new Error(error || "Gemini review failed."));
    });
    worker.addEventListener("error", (event) => {
      const error = new Error(event.message || "Gemini worker หยุดทำงาน");
      geminiWorkerRequests.forEach(({ reject }) => reject(error));
      geminiWorkerRequests.clear();
      worker.terminate();
      if (geminiWorker === worker) geminiWorker = null;
    });
    geminiWorker = worker;
    return worker;
  }

  function stopGeminiWorker() {
    if (!geminiWorker) return;
    geminiWorker.terminate();
    geminiWorker = null;
    const error = new Error("ยกเลิกการสแกน");
    geminiWorkerRequests.forEach(({ reject }) => reject(error));
    geminiWorkerRequests.clear();
  }

  function clearResults() {
    state.results = [];
    state.selectedResultId = null;
    setPreviewFullscreen(false);
    setPreviewZoom(1);
    revokePreviewUrl();
    els.resultsPanel.hidden = true;
    els.downloadPdf.disabled = true;
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
    if (!state.results.length) return;
    els.resultBody.innerHTML = state.results.map((row) => {
      const detailText = row.gemini?.error
        ? `Gemini error: ${row.gemini.error}`
        : row.gemini?.summary
          || row.textFindings?.[0]?.description
          || (row.comparisonSource === "text" ? "ไม่พบข้อมูลต่างจาก text layer" : (!row.visualComparable ? "โครงสร้างต่างกัน" : "-"));
      return `
        <tr data-result-id="${row.id}" class="${state.selectedResultId === row.id ? "selected" : ""}">
          <td>${describePagePair(row)}</td>
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
    setPreviewZoom(1);
    renderResults();
    renderTextFindings(row.markerFindings);
    revokePreviewUrl();
    els.previewTitle.textContent = describePagePair(row);
    if (!row.imageBlob) {
      setPreviewFullscreen(false);
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
    updatePreviewFullscreenUi();
  }

  function togglePreviewFullscreen() {
    setPreviewFullscreen(!state.previewFullscreen);
  }

  function setPreviewFullscreen(fullscreen) {
    const row = state.results.find((result) => result.id === state.selectedResultId);
    const next = Boolean(fullscreen) && Boolean(row?.imageBlob);
    state.previewFullscreen = next;
    els.previewPanel.classList.toggle("is-fullscreen", next);
    document.body.classList.toggle("compare-preview-fullscreen", next);
    if (!next) setPreviewZoom(1);
    updatePreviewFullscreenUi();
  }

  function updatePreviewFullscreenUi() {
    const row = state.results.find((result) => result.id === state.selectedResultId);
    const canView = Boolean(row?.imageBlob) && !els.previewImage.hidden;
    els.togglePreviewFullscreen.disabled = !canView;
    els.togglePreviewFullscreen.title = state.previewFullscreen ? "ออกจากโหมดเต็มจอ" : "ดูภาพเต็มจอ";
    els.togglePreviewFullscreen.setAttribute("aria-label", state.previewFullscreen ? "ออกจากโหมดเต็มจอ" : "ดูภาพเต็มจอ");
    setPreviewFullscreenIcon(state.previewFullscreen ? "minimize-2" : "maximize-2");
    setPreviewZoom(state.previewZoom);
  }

  function setPreviewFullscreenIcon(iconName) {
    const currentIcon = els.togglePreviewFullscreen.querySelector("svg");
    if (currentIcon?.getAttribute("data-lucide") === iconName) return;
    els.togglePreviewFullscreen.innerHTML = `<i data-lucide="${iconName}"></i>`;
    createIcons({ icons });
  }

  function setPreviewZoom(value) {
    const zoom = clamp(Number(value) || 1, 0.75, 3);
    state.previewZoom = zoom;
    els.previewZoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    els.previewZoomOut.disabled = !state.previewFullscreen || zoom <= 0.75;
    els.previewZoomIn.disabled = !state.previewFullscreen || zoom >= 3;
    if (state.previewFullscreen && !els.previewImage.hidden) {
      els.previewImage.style.width = `${Math.round(zoom * 100)}%`;
    } else {
      els.previewImage.style.removeProperty("width");
    }
  }

  async function downloadComparedPdf() {
    const rows = state.results;
    if (!rows.length || state.downloading) return;
    state.downloading = true;
    setDownloadProgress(0, rows.length);
    updateButtons();
    els.downloadPdf.disabled = true;
    try {
      const pdfBytes = await buildComparisonPdf(rows, (completed, total) => setDownloadProgress(completed, total));
      triggerDownload(new Blob([pdfBytes], { type: "application/pdf" }), "document-comparison.pdf");
    } catch (error) {
      setProgressIdle(error.message || "สร้าง PDF ที่เปรียบเทียบแล้วไม่สำเร็จ");
    } finally {
      state.downloading = false;
      setDownloadProgress(0, 0);
      updateButtons();
    }
  }

  async function downloadCurrentComparisonPdf() {
    const row = state.results.find((result) => result.id === state.selectedResultId);
    if (!row || state.downloading) return;
    state.downloading = true;
    setDownloadProgress(0, 1);
    updateButtons();
    els.downloadCurrent.disabled = true;
    try {
      const pdfBytes = await buildComparisonPdf([row], (completed, total) => setDownloadProgress(completed, total));
      triggerDownload(new Blob([pdfBytes], { type: "application/pdf" }), comparisonPdfFilename(row));
    } catch (error) {
      setProgressIdle(error.message || "สร้าง PDF หน้านี้ไม่สำเร็จ");
    } finally {
      state.downloading = false;
      setDownloadProgress(0, 0);
      els.downloadCurrent.disabled = false;
    }
  }

  async function buildComparisonPdf(rows, onProgress = null) {
    if (!state.rightFile) throw new Error("ไม่พบไฟล์ฉบับเปรียบเทียบ");
    const { PDFDocument } = await import("pdf-lib");
    const outputPdf = await PDFDocument.create();
    if (isPdf(state.rightFile)) {
      const sourcePdf = await PDFDocument.load(await state.rightFile.arrayBuffer(), { ignoreEncryption: true });
      for (const [index, row] of rows.entries()) {
        if (row.rightPage < 1 || row.rightPage > sourcePdf.getPageCount()) {
          onProgress?.(index + 1, rows.length);
          continue;
        }
        const [copiedPage] = await outputPdf.copyPages(sourcePdf, [row.rightPage - 1]);
        const page = outputPdf.addPage(copiedPage);
        await drawPdfAnnotationOverlay(outputPdf, page, row.annotation);
        onProgress?.(index + 1, rows.length);
      }
    } else {
      const sourceCanvas = await renderImageFile(state.rightFile);
      const sourceBlob = await canvasToBlob(sourceCanvas);
      const sourceImage = await outputPdf.embedPng(await sourceBlob.arrayBuffer());
      for (const [index, row] of rows.entries()) {
        const page = outputPdf.addPage([sourceImage.width, sourceImage.height]);
        page.drawImage(sourceImage, { x: 0, y: 0, width: sourceImage.width, height: sourceImage.height });
        await drawPdfAnnotationOverlay(outputPdf, page, row.annotation);
        onProgress?.(index + 1, rows.length);
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
    els.runButton.disabled = state.processing
      || state.loadingSides.left
      || state.loadingSides.right
      || !state.leftSource
      || !state.rightSource
      || !getPagePairs().length
      || !state.geminiKey.trim()
      || state.downloading;
    els.downloadPdf.disabled = state.processing || state.downloading || !state.results.length;
    els.downloadCurrent.disabled = state.downloading || !state.selectedResultId;
  }

  function setDownloadProgress(completed, total) {
    const active = total > 0 || state.downloading;
    els.downloadPanel.classList.toggle("is-downloading", active);
    els.downloadStatus.setAttribute("aria-hidden", String(!active));
    if (!active) {
      els.downloadStatusText.textContent = "กำลังสร้าง PDF";
      els.downloadStatusCount.textContent = "";
      els.downloadProgressBar.style.width = "0%";
      return;
    }
    const percent = total ? Math.max(0, Math.min(100, (completed / total) * 100)) : 0;
    els.downloadStatusText.textContent = "กำลังสร้าง PDF";
    els.downloadStatusCount.textContent = total ? `${completed}/${total}` : "";
    els.downloadProgressBar.style.width = `${percent}%`;
  }

  function updateProcessingUi() {
    els.commandDock?.classList.toggle("is-processing", state.processing);
    updatePromptActionUi();
    updatePromptExpandUi();
    updateDocumentTitle();
  }

  function updateDocumentTitle() {
    document.title = state.processing
      ? (document.hidden ? "กำลังทำงานเบื้องหลัง · LE PDF Scan" : "กำลังประมวลผล · LE PDF Scan")
      : "LE PDF Scan";
  }

  function togglePromptExpanded() {
    setPromptExpanded(!state.promptExpanded);
  }

  function setPromptExpanded(expanded) {
    const next = Boolean(expanded) && !state.processing;
    const previous = state.promptExpanded;
    const dock = els.commandDock;
    if (!dock || next === previous) return;
    if (state.promptCollapseTimer) {
      window.clearTimeout(state.promptCollapseTimer);
      state.promptCollapseTimer = null;
    }
    if (next) {
      state.promptDockCollapsedHeight = dock.getBoundingClientRect().height;
      state.promptExpanded = true;
      dock.classList.remove("prompt-collapsing");
      dock.style.setProperty("--prompt-dock-collapsed-height", `${Math.round(state.promptDockCollapsedHeight)}px`);
      dock.classList.add("prompt-expanded");
    } else {
      state.promptExpanded = false;
      const collapsedHeight = Math.max(1, Math.round(state.promptDockCollapsedHeight || dock.getBoundingClientRect().height));
      dock.style.setProperty("--prompt-dock-collapsed-height", `${collapsedHeight}px`);
      dock.classList.add("prompt-collapsing");
      void dock.offsetHeight;
      dock.classList.remove("prompt-expanded");
      state.promptCollapseTimer = window.setTimeout(() => {
        dock.classList.remove("prompt-collapsing");
        dock.style.removeProperty("--prompt-dock-collapsed-height");
        state.promptCollapseTimer = null;
      }, 280);
    }
    updatePromptExpandUi();
    if (state.promptExpanded) {
      window.requestAnimationFrame(() => els.prompt.focus());
    }
  }

  function updatePromptExpandUi() {
    if (!els.expandPrompt) return;
    const expanded = state.promptExpanded;
    els.expandPrompt.disabled = state.processing;
    els.expandPrompt.title = expanded ? "ย่อ Prompt" : "ขยาย Prompt";
    els.expandPrompt.setAttribute("aria-label", expanded ? "ย่อ Prompt" : "ขยาย Prompt");
    const iconName = expanded ? "chevron-down" : "chevron-up";
    const currentIcon = els.expandPrompt.querySelector("svg");
    if (currentIcon?.getAttribute("data-lucide") === iconName) return;
    els.expandPrompt.innerHTML = `<i data-lucide="${iconName}"></i>`;
    createIcons({ icons });
  }

  function updatePromptActionUi() {
    if (state.processing) {
      els.resetPrompt.disabled = false;
      els.resetPrompt.title = "ยกเลิกการสแกน";
      els.resetPrompt.setAttribute("aria-label", "ยกเลิกการสแกน");
      setPromptActionIcon("x");
      return;
    }
    const isExhaustive = state.scanMode === "exhaustive";
    els.resetPrompt.title = isExhaustive ? "ล้างบริบทเพิ่มเติม" : "คืนค่า prompt เริ่มต้น";
    els.resetPrompt.setAttribute("aria-label", isExhaustive ? "ล้างบริบทเพิ่มเติม" : "คืนค่า prompt เริ่มต้น");
    els.resetPrompt.disabled = isExhaustive
      ? !state.exhaustiveContext.trim()
      : els.prompt.value.trim() === DEFAULT_GEMINI_PROMPT.trim();
    setPromptActionIcon("rotate-ccw");
  }

  function setPromptActionIcon(iconName) {
    const currentIcon = els.resetPrompt.querySelector("svg");
    if (currentIcon?.getAttribute("data-lucide") === iconName) return;
    els.resetPrompt.innerHTML = `<i data-lucide="${iconName}"></i>`;
    createIcons({ icons });
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

  function restoreGeminiSettings() {
    try {
      state.geminiKey = localStorage.getItem("le-pdfscan-gemini-key")
        || sessionStorage.getItem("le-pdfscan-gemini-key")
        || "";
      if (geminiDialogKey) geminiDialogKey.value = state.geminiKey;
      const savedMode = localStorage.getItem("le-pdfscan-compare-mode");
      state.scanMode = savedMode === "exhaustive" ? "exhaustive" : "focused";
      const savedFocusedPrompt = localStorage.getItem("le-pdfscan-focused-prompt");
      const savedFocusedCustomFlag = localStorage.getItem("le-pdfscan-focused-prompt-custom");
      const legacyPrompt = localStorage.getItem("le-pdfscan-compare-prompt") || "";
      const legacyCustomFlag = localStorage.getItem("le-pdfscan-compare-prompt-custom");
      const legacyPromptIsCustom = Boolean(legacyPrompt) && (
        legacyCustomFlag === "1"
        || (legacyCustomFlag === null && !isKnownDefaultComparePrompt(legacyPrompt))
      );
      const focusedPrompt = savedFocusedPrompt ?? (legacyPromptIsCustom ? legacyPrompt : "");
      state.promptIsCustom = Boolean(focusedPrompt) && (
        savedFocusedCustomFlag === "1"
        || (savedFocusedCustomFlag === null && !isKnownDefaultComparePrompt(focusedPrompt))
      );
      state.focusedPrompt = state.promptIsCustom ? focusedPrompt : DEFAULT_GEMINI_PROMPT;
      state.exhaustiveContext = localStorage.getItem("le-pdfscan-exhaustive-context") || "";
      els.prompt.value = getPromptFieldValue();
    } catch {
      state.promptIsCustom = false;
      state.focusedPrompt = DEFAULT_GEMINI_PROMPT;
      state.exhaustiveContext = "";
      state.geminiKey = "";
      if (geminiDialogKey) geminiDialogKey.value = "";
      els.prompt.value = getPromptFieldValue();
    }
    updateGeminiHeader();
  }

  function persistGeminiKey() {
    try {
      if (state.geminiKey) {
        localStorage.setItem("le-pdfscan-gemini-key", state.geminiKey);
        sessionStorage.removeItem("le-pdfscan-gemini-key");
      } else {
        localStorage.removeItem("le-pdfscan-gemini-key");
        sessionStorage.removeItem("le-pdfscan-gemini-key");
      }
    } catch {
      // The current tab can still use the key when storage is unavailable.
    }
  }

  function openGeminiDialog() {
    if (!geminiDialog || !geminiDialogKey) return;
    geminiDialogKey.value = state.geminiKey;
    geminiDialog.hidden = false;
    document.body.classList.add("gemini-dialog-open");
    window.requestAnimationFrame(() => geminiDialogKey.focus());
  }

  function closeGeminiDialog() {
    if (!geminiDialog) return;
    geminiDialog.hidden = true;
    document.body.classList.remove("gemini-dialog-open");
  }

  function saveGeminiKey() {
    state.geminiKey = geminiDialogKey?.value.trim() || "";
    persistGeminiKey();
    updateGeminiHeader();
    updateButtons();
    closeGeminiDialog();
    if (!state.processing) {
      setProgressIdle(state.geminiKey ? "Gemini พร้อมใช้งาน" : "ตั้งค่า Gemini API key ก่อนเริ่มเปรียบเทียบ");
    }
  }

  function updateGeminiHeader() {
    if (!geminiButton || !geminiHeaderStatus) return;
    const configured = Boolean(state.geminiKey.trim());
    geminiHeaderStatus.textContent = configured ? "พร้อมใช้งาน" : "ตั้งค่า API key";
    geminiButton.classList.toggle("is-ready", configured);
    geminiButton.setAttribute("aria-label", configured ? "แก้ไข Gemini API key" : "ตั้งค่า Gemini API key");
    geminiButton.title = configured ? "แก้ไข Gemini API key" : "ตั้งค่า Gemini API key";
    if (geminiDialogClear) geminiDialogClear.disabled = !configured;
  }

  function clearGeminiKey() {
    state.geminiKey = "";
    if (geminiDialogKey) geminiDialogKey.value = "";
    try {
      localStorage.removeItem("le-pdfscan-gemini-key");
      sessionStorage.removeItem("le-pdfscan-gemini-key");
    } catch {
      // The visible field is still cleared when browser storage is unavailable.
    }
    updateGeminiHeader();
    updateButtons();
    if (!state.processing) setProgressIdle("ตั้งค่า Gemini API key ก่อนเริ่มเปรียบเทียบ");
    closeGeminiDialog();
  }

  function persistPrompt() {
    try {
      localStorage.setItem("le-pdfscan-focused-prompt", state.focusedPrompt);
      localStorage.setItem("le-pdfscan-focused-prompt-custom", state.promptIsCustom ? "1" : "0");
      localStorage.setItem("le-pdfscan-exhaustive-context", state.exhaustiveContext);
      localStorage.removeItem("le-pdfscan-compare-prompt");
      localStorage.removeItem("le-pdfscan-compare-prompt-custom");
    } catch {
      // The current tab can still use the prompt when storage is unavailable.
    }
  }

  function handlePromptInput() {
    if (state.scanMode === "exhaustive") {
      state.exhaustiveContext = els.prompt.value;
    } else {
      state.focusedPrompt = els.prompt.value;
      const prompt = state.focusedPrompt.trim();
      state.promptIsCustom = Boolean(prompt) && !isKnownDefaultComparePrompt(prompt);
    }
    updatePromptFieldUi();
    persistPrompt();
  }

  function handlePromptAction() {
    if (state.processing) {
      cancelComparison();
      return;
    }
    resetPrompt();
  }

  function cancelComparison() {
    if (!state.processing) return;
    state.compareToken += 1;
    stopGeminiWorker();
    state.processing = false;
    setProgressIdle("ยกเลิกการสแกน");
    updateProcessingUi();
    updateButtons();
  }

  function resetPrompt() {
    if (state.scanMode === "exhaustive") {
      state.exhaustiveContext = "";
    } else {
      state.promptIsCustom = false;
      state.focusedPrompt = DEFAULT_GEMINI_PROMPT;
    }
    els.prompt.value = getPromptFieldValue();
    updatePromptFieldUi();
    persistPrompt();
  }

  function setScanMode(mode) {
    state.scanMode = mode === "exhaustive" ? "exhaustive" : "focused";
    els.prompt.value = getPromptFieldValue();
    updatePromptFieldUi();
    persistPrompt();
    [els.modeFocused, els.modeExhaustive].forEach((button) => {
      const active = button.dataset.mode === state.scanMode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    try {
      localStorage.setItem("le-pdfscan-compare-mode", state.scanMode);
    } catch {
      // Mode remains active for the current page when storage is unavailable.
    }
    updateButtons();
  }

  function getPromptFieldValue() {
    if (state.scanMode === "exhaustive") return state.exhaustiveContext;
    return state.promptIsCustom ? state.focusedPrompt : DEFAULT_GEMINI_PROMPT;
  }

  function updatePromptFieldUi() {
    const isExhaustive = state.scanMode === "exhaustive";
    if (isExhaustive) {
      els.promptLabel.textContent = "บริบทเอกสารเพิ่มเติม";
      els.promptHelper.textContent = "ไม่บังคับ · ใช้ช่วยจับคู่คำศัพท์และฟิลด์ โดยไม่ลดขอบเขตการตรวจ";
      els.prompt.placeholder = "เช่น ไฟล์ซ้ายเป็นใบเสนอราคา ส่วนไฟล์ขวาเป็นใบสั่งซื้อ หรือ SET และ ชุด หมายถึงหน่วยเดียวกัน";
      els.prompt.setAttribute("aria-label", "บริบทเอกสารเพิ่มเติมสำหรับ Gemini");
    } else {
      els.promptLabel.textContent = "Prompt";
      els.promptHelper.textContent = "กำหนดสิ่งที่ต้องตรวจ ละเว้น หรือถือว่าสำคัญ";
      els.prompt.placeholder = "ระบุเกณฑ์สาระสำคัญที่ต้องการให้ Gemini ตรวจ";
      els.prompt.setAttribute("aria-label", "Prompt");
    }
    updatePromptActionUi();
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
    state.roiPages.left = null;
    state.roiPages.right = null;
    state.roiDrag = null;
    setRoiEditing("left", false);
    setRoiEditing("right", false);
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
    const page = getActiveRoiPage(side);
    if (!page) return;
    state.roiSelections.delete(roiSelectionKey(side, page));
    setRoiEditing(side, false);
    renderRoiSelection(side);
  }

  function selectRoiPage(side) {
    const select = side === "left" ? els.roiLeftPage : els.roiRightPage;
    const page = Number(select.value);
    if (!getSelectedPages(side).includes(page)) return;
    setRoiEditing(side, false);
    state.roiPages[side] = page;
    void renderRoiPreviews();
  }

  function changeRoiPage(side, offset) {
    const pages = getSelectedPages(side);
    const currentIndex = pages.indexOf(getActiveRoiPage(side));
    if (!pages.length || currentIndex < 0) return;
    const nextIndex = clamp(currentIndex + offset, 0, pages.length - 1);
    if (nextIndex === currentIndex) return;
    setRoiEditing(side, false);
    state.roiPages[side] = pages[nextIndex];
    void renderRoiPreviews();
  }

  function applyRoiToSelectedPages(side) {
    const activePage = getActiveRoiPage(side);
    if (!activePage) return;
    const selection = state.roiSelections.get(roiSelectionKey(side, activePage));
    const pages = getSelectedPages(side);
    pages.forEach((page) => {
      const key = roiSelectionKey(side, page);
      if (selection) state.roiSelections.set(key, { ...selection });
      else state.roiSelections.delete(key);
    });
    renderRoiSelection(side);
    const documentLabel = side === "left" ? "ต้นฉบับ" : "ฉบับเปรียบเทียบ";
    setProgressIdle("คัดลอกพื้นที่ของหน้า " + activePage + " ไปยัง " + pages.length + " หน้า" + documentLabel);
  }

  async function renderRoiPreviews() {
    if (!state.leftSource || !state.rightSource) return;
    normalizeRoiPages();
    const leftPage = getActiveRoiPage("left");
    const rightPage = getActiveRoiPage("right");
    if (!leftPage || !rightPage) {
      els.roiPanel.hidden = true;
      return;
    }
    const token = state.roiRenderToken + 1;
    state.roiRenderToken = token;
    els.roiPanel.hidden = false;
    updateRoiPageControls();
    try {
      const [leftCanvas, rightCanvas] = await Promise.all([
        state.leftSource.renderPage(leftPage),
        state.rightSource.renderPage(rightPage),
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

  function updateRoiPageControls() {
    ["left", "right"].forEach((side) => {
      const pages = getSelectedPages(side);
      const activePage = getActiveRoiPage(side);
      const select = side === "left" ? els.roiLeftPage : els.roiRightPage;
      const previous = side === "left" ? els.roiLeftPrevious : els.roiRightPrevious;
      const next = side === "left" ? els.roiLeftNext : els.roiRightNext;
      const edit = side === "left" ? els.roiEditLeft : els.roiEditRight;
      const apply = side === "left" ? els.roiApplyLeft : els.roiApplyRight;
      const reset = side === "left" ? els.roiResetLeft : els.roiResetRight;
      select.innerHTML = pages.map((page) => `<option value="${page}">หน้า ${page}</option>`).join("");
      select.value = String(activePage || "");
      select.disabled = !activePage;
      const activeIndex = pages.indexOf(activePage);
      previous.disabled = activeIndex <= 0;
      next.disabled = activeIndex < 0 || activeIndex >= pages.length - 1;
      edit.disabled = !activePage || state.processing;
      apply.disabled = !activePage;
      reset.disabled = !activePage || !hasCustomRoi(activePage, side) || state.processing;
    });
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
    const page = getActiveRoiPage(side);
    if (!page) return;
    const region = getRoi(page, side);
    const custom = hasCustomRoi(page, side);
    selection.classList.toggle("default", !custom);
    selection.style.left = `${region.x * 100}%`;
    selection.style.top = `${region.y * 100}%`;
    selection.style.width = `${region.width * 100}%`;
    selection.style.height = `${region.height * 100}%`;
    selection.setAttribute("aria-label", custom ? "พื้นที่เปรียบเทียบที่เลือก" : "ใช้ทั้งหน้า");
    stage.classList.toggle("has-custom-selection", custom);
    const reset = side === "left" ? els.roiResetLeft : els.roiResetRight;
    reset.disabled = !custom || state.processing;
  }

  function bindRoiStage(side) {
    const stage = side === "left" ? els.roiLeftStage : els.roiRightStage;
    const selection = side === "left" ? els.roiLeftSelection : els.roiRightSelection;
    stage.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !state.leftSource || !state.rightSource) return;
      if (!state.roiEditing[side]) return;
      const page = getActiveRoiPage(side);
      if (!page) return;
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

  function toggleRoiEditing(side) {
    setRoiEditing(side, !state.roiEditing[side]);
  }

  function setRoiEditing(side, editing) {
    const next = Boolean(editing);
    if (next) {
      const otherSide = side === "left" ? "right" : "left";
      state.roiEditing[otherSide] = false;
      updateRoiEditingUi(otherSide);
    }
    state.roiEditing[side] = next;
    updateRoiEditingUi(side);
  }

  function updateRoiEditingUi(side) {
    const active = state.roiEditing[side];
    const stage = side === "left" ? els.roiLeftStage : els.roiRightStage;
    const button = side === "left" ? els.roiEditLeft : els.roiEditRight;
    const documentLabel = side === "left" ? "ต้นฉบับ" : "ฉบับเปรียบเทียบ";
    stage.classList.toggle("touch-editing", active);
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    button.title = active ? `เสร็จสิ้นการแก้ไขพื้นที่ครอป${documentLabel}` : `แก้ไขพื้นที่ครอป${documentLabel}`;
    button.setAttribute("aria-label", button.title);
    const iconName = active ? "check" : "crop";
    const currentIcon = button.querySelector("svg");
    if (currentIcon?.getAttribute("data-lucide") === iconName) return;
    button.innerHTML = `<i data-lucide="${iconName}"></i>`;
    createIcons({ icons });
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

function clipBoxesToRoi(boxes, region, pageCanvas) {
  const rect = roiToPixelRect(region, pageCanvas);
  return boxes.map((box) => {
    const left = Math.max(rect.x, box.x);
    const top = Math.max(rect.y, box.y);
    const right = Math.min(rect.x + rect.width, box.x + box.width);
    const bottom = Math.min(rect.y + rect.height, box.y + box.height);
    if (right <= left || bottom <= top) return null;
    return { ...box, x: left, y: top, width: right - left, height: bottom - top };
  }).filter(Boolean);
}

function numberMarkerBoxes(boxes) {
  return boxes.map((box, index) => ({ ...box, markerNumber: index + 1 }));
}

function groupMarkerBoxesForDisplay(boxes, canvas) {
  const pending = boxes.map((box) => ({ ...box }));
  const groups = [];
  const topicMargin = Math.max(28, Math.round(Math.min(canvas.width, canvas.height) * 0.075));

  while (pending.length) {
    const group = [pending.shift()];
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        if (!group.some((member) => shouldGroupMarkerBoxes(member, pending[index], topicMargin))) continue;
        group.push(pending[index]);
        pending.splice(index, 1);
        expanded = true;
      }
    }
    groups.push(group);
  }

  return groups.map((group) => {
    const merged = group.reduce((current, box) => unionBox(current, box));
    const markerNumbers = [...new Set(group
      .map((box) => Number(box.markerNumber))
      .filter(Number.isInteger))]
      .sort((first, second) => first - second);
    const descriptions = [...new Set(group
      .map((box) => String(box.markerDescription || box.label || "").replace(/\s+/g, " ").trim())
      .filter(Boolean))];
    const locations = [...new Set(group
      .map((box) => String(box.markerLocation || "").replace(/\s+/g, " ").trim())
      .filter(Boolean))];
    const markerDescription = descriptions.length
      ? descriptions.join(" / ")
      : "Gemini พบจุดต่างในบริเวณนี้";
    return {
      ...merged,
      label: markerDescription,
      markerKind: "gemini",
      markerDescription,
      markerLocation: locations.length === 1 ? locations[0] : "",
      groupedMarkerCount: group.length,
      markerNumber: formatGroupedMarkerNumber(markerNumbers),
      groupedMarkerNumbers: markerNumbers,
      geminiChangeIndexes: group
        .flatMap((box) => Array.isArray(box.geminiChangeIndexes)
          ? box.geminiChangeIndexes
          : [box.geminiChangeIndex])
        .filter((index) => Number.isInteger(index)),
    };
  });
}

function formatGroupedMarkerNumber(numbers) {
  if (!numbers.length) return "?";
  if (numbers.length === 1) return numbers[0];
  const contiguous = numbers.every((number, index) => index === 0 || number === numbers[index - 1] + 1);
  return contiguous
    ? `${numbers[0]}-${numbers[numbers.length - 1]}`
    : numbers.join("/");
}

function shouldGroupMarkerBoxes(first, second, topicMargin) {
  if (boxesOverlap(first, second)) return true;
  const firstTopic = markerTopicKey(first);
  const secondTopic = markerTopicKey(second);
  if (!firstTopic || firstTopic !== secondTopic || !boxesTouch(first, second, topicMargin)) return false;
  const horizontalOverlap = Math.max(
    0,
    Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x),
  );
  const verticalOverlap = Math.max(
    0,
    Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y),
  );
  const horizontalAlignment = horizontalOverlap / Math.max(1, Math.min(first.width, second.width));
  const verticalAlignment = verticalOverlap / Math.max(1, Math.min(first.height, second.height));
  return horizontalAlignment >= 0.25 || verticalAlignment >= 0.25;
}

function markerTopicKey(box) {
  const text = `${box.markerLocation || ""} ${box.markerDescription || box.label || ""}`;
  const normalized = normalizeMarkerTopic(text);
  if (/(ราคา|ราคาต่อหน่วย|price|unitprice)/u.test(normalized)) return "price";
  if (/(ยอดรวม|subtotal|total|ยอดก่อนภาษี|grandtotal)/u.test(normalized)) return "total";
  if (/(หน่วย|unit)/u.test(normalized)) return "unit";
  if (/(รหัส|รหัสสินค้า|รหัสวัสดุ|material|code|เลขที่สินค้า)/u.test(normalized)) return "code";
  if (/(วันที่|กำหนดส่ง|deliverydate|date)/u.test(normalized)) return "date";
  if (/(รายละเอียด|description|spec|รุ่น|model|suffix|option)/u.test(normalized)) return "description";
  if (/(ส่วนลด|discount|ภาษี|vat)/u.test(normalized)) return "adjustment";
  return normalized;
}

function normalizeMarkerTopic(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}_]+/gu, "");
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

function normalizeGeminiReview(
  review,
  scanMode = "focused",
  textCandidates = [],
  preserveModelDescriptions = false,
) {
  const source = review && typeof review === "object" ? review : {};
  const normalizedChanges = Array.isArray(source.changes)
    ? source.changes.map((change) => {
      const textCandidate = resolveGeminiTextCandidate(change, textCandidates);
      return normalizeGeminiChange(change, textCandidate, preserveModelDescriptions);
    }).filter(Boolean)
    : [];
  const changes = scanMode === "focused"
    ? normalizedChanges.filter((change) => change.materiality === "material")
    : normalizedChanges;
  const summary = scanMode === "focused"
    ? (changes.length
      ? `พบความต่างสาระสำคัญ ${changes.length} จุด`
      : "ไม่พบความต่างสาระสำคัญที่ยืนยันได้")
    : cleanGeminiText(source.summary)
      || (changes.length ? `Gemini พบจุดต่าง ${changes.length} จุด` : "Gemini ไม่พบจุดต่างที่ยืนยันได้");
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

function normalizeGeminiChange(change, textCandidate = null, preserveModelDescription = false) {
  if (!change || typeof change !== "object") return null;
  const referenceText = cleanGeminiText(change.referenceText);
  const comparisonText = cleanGeminiText(change.comparisonText);
  const evidenceDescription = preserveModelDescription ? "" : describeTextCandidateDelta(textCandidate);
  const description = evidenceDescription
    || cleanGeminiText(change.description)
    || cleanGeminiText(change.summary)
    || describeGeminiChange(referenceText, comparisonText);
  const materiality = normalizeGeminiMateriality(change.materiality);
  return {
    ...change,
    location: cleanGeminiText(change.location),
    description,
    referenceText,
    comparisonText,
    materiality,
    candidateId: textCandidate?.id || cleanGeminiText(change.candidateId),
  };
}

function resolveGeminiTextCandidate(change, candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const candidateId = cleanGeminiText(change?.candidateId);
  if (candidateId) {
    const direct = candidates.find((candidate) => candidate?.id === candidateId);
    if (direct) return direct;
  }

  const referenceText = isPlaceholderGeminiText(change?.referenceText) ? "" : cleanGeminiText(change?.referenceText);
  const comparisonText = isPlaceholderGeminiText(change?.comparisonText) ? "" : cleanGeminiText(change?.comparisonText);
  let best = null;
  candidates.forEach((candidate) => {
    const referenceScore = scoreCandidateEvidence(
      referenceText,
      candidate?.referenceContext,
      candidate?.referenceFragment,
    );
    const comparisonScore = scoreCandidateEvidence(
      comparisonText,
      candidate?.comparisonContext,
      candidate?.comparisonFragment,
    );
    if (referenceText && referenceScore === 0) return;
    if (comparisonText && comparisonScore === 0) return;
    const score = referenceScore + comparisonScore;
    if (score >= 5 && (!best || score > best.score)) best = { candidate, score };
  });
  return best?.candidate || null;
}

function scoreCandidateEvidence(value, context, fragment) {
  const normalizedValue = normalizeCandidateEvidence(value);
  if (!normalizedValue) return 0;
  const normalizedContext = normalizeCandidateEvidence(context);
  const normalizedFragment = normalizeCandidateEvidence(fragment);
  if (normalizedContext && normalizedValue === normalizedContext) return 6;
  if (normalizedFragment && normalizedValue === normalizedFragment) return 5;
  if (normalizedContext && normalizedValue.length >= 8
    && (normalizedContext.includes(normalizedValue) || normalizedValue.includes(normalizedContext))) return 3;
  if (normalizedFragment && normalizedValue.includes(normalizedFragment)) return 2;
  return 0;
}

function normalizeCandidateEvidence(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}_]+/gu, "");
}

function describeTextCandidateDelta(candidate) {
  if (!candidate) return "";
  const reference = formatCandidateFragment(
    candidate.referenceFragment,
    candidate.referenceContext,
    candidate.comparisonContext,
  );
  const comparison = formatCandidateFragment(
    candidate.comparisonFragment,
    candidate.comparisonContext,
    candidate.referenceContext,
  );
  if (reference && comparison) return `เปลี่ยนจาก ${reference} เป็น ${comparison}`;
  if (reference) return `ต้นฉบับมี ${reference} แต่ฉบับเปรียบเทียบไม่มี`;
  if (comparison) return `ฉบับเปรียบเทียบมี ${comparison} แต่ต้นฉบับไม่มี`;
  return "";
}

function formatCandidateFragment(fragment, context, oppositeContext) {
  const value = String(fragment || "").replace(/\s+/g, "").trim();
  if (!value) return "";
  const compactContext = String(context || "").replace(/\s+/g, "");
  const index = compactContext.toLocaleLowerCase().indexOf(value.toLocaleLowerCase());
  let display = index >= 0
    ? compactContext.slice(index, index + value.length)
    : value;
  const previousCharacter = index > 0 ? compactContext[index - 1] : "";
  const compactOpposite = String(oppositeContext || "").replace(/\s+/g, "");
  if (previousCharacter === "-" && compactOpposite.endsWith("-") && !display.startsWith("-")) {
    display = `-${display}`;
  }
  return display;
}

function normalizeGeminiMateriality(value) {
  const normalized = String(value || "")
    .trim()
    .toLocaleLowerCase()
    .replace(/[_\s-]+/g, "");
  if (normalized === "material") return "material";
  if (normalized === "contextual") return "contextual";
  if (normalized === "workflow") return "workflow";
  if (normalized === "layout") return "layout";
  return "uncertain";
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
      markerLocation: cleanGeminiText(change.location),
      geminiChangeIndex: index,
    };
  }).filter(Boolean);
}

function groundGeminiBoxesToPdfText(review, textPage, textRegion, pageCanvas, fallbackBoxes, textCandidates = []) {
  if (!Array.isArray(review?.changes) || !textPage?.items?.length) return fallbackBoxes;
  const fallbackByChangeIndex = new Map(fallbackBoxes.map((box) => [box.geminiChangeIndex, box]));
  const candidateById = new Map(textCandidates.map((candidate) => [candidate.id, candidate]));
  const usedTextBoxes = [];
  const boxes = [];

  review.changes.forEach((change, changeIndex) => {
    const candidate = candidateById.get(change?.candidateId);
    if (candidate?.comparisonBox) {
      const candidateBox = normalizedBoxToCanvas(candidate.comparisonBox, pageCanvas, {
        label: change.description || "Gemini พบจุดต่าง",
        markerKind: "gemini",
        markerDescription: change.description || "Gemini พบจุดต่างในบริเวณนี้",
        markerLocation: cleanGeminiText(change.location),
        geminiChangeIndex: changeIndex,
        markerSource: "pdf-text-candidate",
      });
      if (!usedTextBoxes.some((used) => boxesOverlap(candidateBox, used))) {
        usedTextBoxes.push(candidateBox);
        boxes.push(candidateBox);
        return;
      }
    }
    const comparisonText = isPlaceholderGeminiText(change?.comparisonText)
      ? ""
      : change?.comparisonText;
    const match = comparisonText
      ? findPdfTextMatches(textPage, textRegion, comparisonText)
        .find((candidate) => !usedTextBoxes.some((used) => boxesOverlap(candidate.box, used)))
      : null;
    if (match?.box) {
      usedTextBoxes.push(match.box);
      boxes.push(normalizedBoxToCanvas(match.box, pageCanvas, {
        label: change.description || "Gemini พบจุดต่าง",
        markerKind: "gemini",
        markerDescription: change.description || "Gemini พบจุดต่างในบริเวณนี้",
        markerLocation: cleanGeminiText(change.location),
        geminiChangeIndex: changeIndex,
        markerSource: "pdf-text",
      }));
      return;
    }

    const fallback = fallbackByChangeIndex.get(changeIndex);
    // A text-backed page must not fall back to an unverified Gemini coordinate
    // when the claimed comparison text cannot be found there.
    if (fallback && isPlaceholderGeminiText(change?.comparisonText)) boxes.push(fallback);
  });

  return boxes;
}

function parseTextEvidenceCandidates(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed?.boundedTextCandidates) ? parsed.boundedTextCandidates : [];
  } catch {
    return [];
  }
}

function isPlaceholderGeminiText(value) {
  const normalized = normalizeGeminiMatchText(value);
  return !normalized || ["none", "null", "n/a", "ไม่มี", "ไม่พบ", "ไม่ได้ระบุ"].includes(normalized);
}

function boxesOverlap(first, second) {
  return first.x < second.x + second.width
    && first.x + first.width > second.x
    && first.y < second.y + second.height
    && first.y + first.height > second.y;
}

function normalizeGeminiMatchText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}_]+/gu, "");
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
    const lines = wrapCanvasText(context, text, maximumTextWidth, marker.box.groupedMarkerCount > 1 ? 6 : 4);
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
  const occupied = [];
  const ordered = [...cards].sort((first, second) => second.height - first.height || first.box.y - second.box.y || first.number - second.number);
  for (const card of ordered) {
    const placement = findMarkerCalloutPlacement(documentCanvas, card, occupied, markers);
    if (!placement) return false;
    card.x = placement.x;
    card.y = placement.y;
    occupied.push({ x: card.x, y: card.y, width: card.width, height: card.height });
  }
  return true;
}

function findMarkerCalloutPlacement(canvas, card, occupied, markers) {
  const margin = Math.max(8, Math.round(card.fontSize * 0.5));
  const candidates = buildMarkerCalloutCandidates(canvas, card, margin);
  let best = null;
  let bestClear = null;
  for (const candidate of candidates) {
    const rect = { x: candidate.x, y: candidate.y, width: card.width, height: card.height };
    if (!rectFitsCanvas(rect, canvas, margin)) continue;
    if (occupied.some((occupiedRect) => rectanglesOverlap(rect, occupiedRect, margin))) continue;
    if (markers.some((marker) => ellipseIntersectsRect(marker, rect, 5))) continue;
    const distance = Math.hypot(
      (rect.x + (rect.width / 2)) - (card.box.x + (card.box.width / 2)),
      (rect.y + (rect.height / 2)) - (card.box.y + (card.box.height / 2)),
    );
    const score = distance;
    if (!best || score < best.score) best = { ...rect, score };
    const leader = buildMarkerLeaderSegment(card, rect);
    const crossesMarker = markers.some((marker) => marker.box !== card.box
      && lineIntersectsEllipse(leader, marker, 3));
    const crossesCard = occupied.some((occupiedRect) => lineIntersectsRect(leader, occupiedRect, 2));
    if (!crossesMarker && !crossesCard && (!bestClear || score < bestClear.score)) {
      bestClear = { ...rect, score };
    }
  }
  return bestClear || best;
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
      { x: ((left + right) / 2) - (card.width / 2), y: top - card.height - offset },
      { x: ((left + right) / 2) - (card.width / 2), y: bottom + offset },
      { x: left - card.width - offset, y: ((top + bottom) / 2) - (card.height / 2) },
      { x: right + offset, y: ((top + bottom) / 2) - (card.height / 2) },
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

function ellipseIntersectsRect(marker, rect, padding = 0) {
  const centerX = marker.box.x + (marker.box.width / 2);
  const centerY = marker.box.y + (marker.box.height / 2);
  const radiusX = Math.max(1, marker.radiusX + padding);
  const radiusY = Math.max(1, marker.radiusY + padding);
  const nearestX = clamp(centerX, rect.x, rect.x + rect.width);
  const nearestY = clamp(centerY, rect.y, rect.y + rect.height);
  const normalizedX = (nearestX - centerX) / radiusX;
  const normalizedY = (nearestY - centerY) / radiusY;
  return (normalizedX * normalizedX) + (normalizedY * normalizedY) <= 1;
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
  const { sourceX, sourceY, targetX, targetY } = buildMarkerLeaderSegment(card, {
    x: card.x,
    y: card.y,
    width: card.width,
    height: card.height,
  });
  context.save();
  context.strokeStyle = "rgba(220, 38, 38, 0.78)";
  context.lineWidth = Math.max(1, Math.round(card.fontSize * 0.1));
  context.beginPath();
  context.moveTo(sourceX, sourceY);
  context.lineTo(targetX, targetY);
  context.stroke();
  context.restore();
}

function buildMarkerLeaderSegment(card, rect) {
  const centerX = card.box.x + (card.box.width / 2);
  const centerY = card.box.y + (card.box.height / 2);
  const targetX = clamp(centerX, rect.x, rect.x + rect.width);
  const targetY = clamp(centerY, rect.y, rect.y + rect.height);
  const dx = targetX - centerX;
  const dy = targetY - centerY;
  const scale = 1 / Math.max(1, Math.sqrt((dx * dx) / (card.radiusX * card.radiusX) + (dy * dy) / (card.radiusY * card.radiusY)));
  return {
    sourceX: centerX + (dx * scale),
    sourceY: centerY + (dy * scale),
    targetX,
    targetY,
  };
}

function lineIntersectsEllipse(line, marker, padding = 0) {
  const radiusX = Math.max(1, marker.radiusX + padding);
  const radiusY = Math.max(1, marker.radiusY + padding);
  const centerX = marker.box.x + (marker.box.width / 2);
  const centerY = marker.box.y + (marker.box.height / 2);
  for (let step = 1; step < 20; step += 1) {
    const progress = step / 20;
    const x = line.sourceX + ((line.targetX - line.sourceX) * progress);
    const y = line.sourceY + ((line.targetY - line.sourceY) * progress);
    const normalizedX = (x - centerX) / radiusX;
    const normalizedY = (y - centerY) / radiusY;
    if ((normalizedX * normalizedX) + (normalizedY * normalizedY) <= 1) return true;
  }
  return false;
}

function lineIntersectsRect(line, rect, padding = 0) {
  const left = rect.x - padding;
  const top = rect.y - padding;
  const right = rect.x + rect.width + padding;
  const bottom = rect.y + rect.height + padding;
  for (let step = 1; step < 20; step += 1) {
    const progress = step / 20;
    const x = line.sourceX + ((line.targetX - line.sourceX) * progress);
    const y = line.sourceY + ((line.targetY - line.sourceY) * progress);
    if (x >= left && x <= right && y >= top && y <= bottom) return true;
  }
  return false;
}

function rectFitsCanvas(rect, canvas, margin) {
  return rect.x >= margin
    && rect.y >= margin
    && rect.x + rect.width <= canvas.width - margin
    && rect.y + rect.height <= canvas.height - margin;
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
