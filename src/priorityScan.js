import { createIcons, icons } from "lucide";

const DEFAULT_API_URL = import.meta.env.VITE_SCANNER_API_URL
  || (isLocalHost() ? "http://127.0.0.1:8000" : "");

export function createPriorityScanner(root) {
  const state = {
    file: null,
    pageCount: null,
    readingInfo: false,
    rows: [],
    downloads: null,
    processing: false,
    scanToken: 0,
  };

  root.innerHTML = `
    <section class="workspace priority-workspace">
      <aside class="control-panel">
        <label class="drop-zone" id="priorityDropZone">
          <input id="priorityFileInput" type="file" accept="application/pdf,.pdf" />
          <i data-lucide="upload-cloud"></i>
          <span class="drop-title">เลือกหรือวางไฟล์ PDF</span>
          <span class="drop-subtitle" id="priorityFileMeta">ยังไม่ได้เลือกไฟล์</span>
        </label>

        <div class="field-stack">
          <div class="scan-fields">
            <label>
              <span>Priority color</span>
              <div class="color-select">
                <span class="color-swatch red" id="priorityColorSwatch"></span>
                <select id="priorityColor">
                  <option value="red">Red</option>
                  <option value="green">Green</option>
                  <option value="blue">Blue</option>
                  <option value="pink">Pink</option>
                  <option value="orange_marker">Orange</option>
                </select>
              </div>
            </label>
            <label>
              <span>หน้าเริ่ม</span>
              <input id="priorityStartPage" type="number" min="1" value="1" />
            </label>
            <label>
              <span>หน้าสิ้นสุด</span>
              <input id="priorityEndPage" type="number" min="1" value="" />
            </label>
          </div>
        </div>

        <div class="actions">
          <button class="primary" id="priorityRunButton" disabled>
            <i data-lucide="scan-line"></i><span>สแกน</span>
          </button>
          <button id="priorityResetButton"><i data-lucide="rotate-ccw"></i><span>รีเซ็ต</span></button>
        </div>

        <div class="progress-wrap idle" id="priorityProgressWrap">
          <div class="progress-label">
            <span id="priorityProgressText">รอไฟล์ PDF</span>
            <span id="priorityProgressCount" class="progress-count"></span>
          </div>
          <div class="progress-track"><div id="priorityProgressBar"></div></div>
        </div>

        <div class="download-panel" id="priorityDownloadPanel" hidden>
          <a id="priorityDownloadPdf" class="download-link" target="_blank" rel="noreferrer">
            <i data-lucide="file-down"></i><span>PDF ที่เรียงแล้ว</span>
          </a>
          <a id="priorityDownloadCsv" class="download-link" target="_blank" rel="noreferrer">
            <i data-lucide="table"></i><span>CSV สำหรับทีมช่าง</span>
          </a>
        </div>
      </aside>

      <section class="result-panel">
        <div class="result-header">
          <div>
            <p class="eyebrow">Results</p>
            <h2>หน้าที่ต้องส่งทีมช่างก่อน</h2>
          </div>
          <div class="metric-strip">
            <div><strong id="priorityPageCount">0</strong><span>หน้าที่สแกน</span></div>
            <div><strong id="priorityTopCount">0</strong><span>Priority สูงสุด</span></div>
            <div><strong id="priorityTotalCount">0</strong><span>Priority รวม</span></div>
          </div>
        </div>
        <div class="table-frame">
          <table>
            <thead><tr><th>Rank</th><th>Page</th><th>Priority count</th><th>Score</th><th>Area</th><th>Band</th><th>Action</th></tr></thead>
            <tbody id="priorityResultBody"><tr><td colspan="7" class="empty-cell">ผลลัพธ์จะแสดงหลังสแกน PDF</td></tr></tbody>
          </table>
        </div>
      </section>
    </section>
  `;

  const els = {
    fileInput: root.querySelector("#priorityFileInput"),
    dropZone: root.querySelector("#priorityDropZone"),
    fileMeta: root.querySelector("#priorityFileMeta"),
    priorityColor: root.querySelector("#priorityColor"),
    priorityColorSwatch: root.querySelector("#priorityColorSwatch"),
    startPage: root.querySelector("#priorityStartPage"),
    endPage: root.querySelector("#priorityEndPage"),
    runButton: root.querySelector("#priorityRunButton"),
    resetButton: root.querySelector("#priorityResetButton"),
    progressText: root.querySelector("#priorityProgressText"),
    progressWrap: root.querySelector("#priorityProgressWrap"),
    progressCount: root.querySelector("#priorityProgressCount"),
    progressBar: root.querySelector("#priorityProgressBar"),
    downloadPanel: root.querySelector("#priorityDownloadPanel"),
    downloadPdf: root.querySelector("#priorityDownloadPdf"),
    downloadCsv: root.querySelector("#priorityDownloadCsv"),
    resultBody: root.querySelector("#priorityResultBody"),
    pageCount: root.querySelector("#priorityPageCount"),
    topPriority: root.querySelector("#priorityTopCount"),
    totalPriority: root.querySelector("#priorityTotalCount"),
  };

  els.fileInput.addEventListener("change", async (event) => {
    const [file] = event.target.files;
    if (file) await loadFile(file);
  });
  els.dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    els.dropZone.classList.add("dragging");
  });
  els.dropZone.addEventListener("dragleave", () => els.dropZone.classList.remove("dragging"));
  els.dropZone.addEventListener("drop", async (event) => {
    event.preventDefault();
    els.dropZone.classList.remove("dragging");
    const [file] = event.dataTransfer.files;
    if (isPdf(file)) await loadFile(file);
  });
  els.priorityColor.addEventListener("change", updatePriorityColorPreview);
  els.runButton.addEventListener("click", runScan);
  els.resetButton.addEventListener("click", resetApp);
  updatePriorityColorPreview();
  createIcons({ icons });

  async function loadFile(file) {
    state.file = file;
    state.pageCount = null;
    state.readingInfo = true;
    state.rows = [];
    state.downloads = null;
    els.fileMeta.textContent = `${file.name} - ${formatBytes(file.size)}`;
    els.downloadPanel.hidden = true;
    els.startPage.value = "1";
    els.endPage.value = "";
    renderRows([]);
    setProgressIdle("กำลังอ่านจำนวนหน้า");
    updateButtons();

    try {
      const apiBase = getScannerApiUrl();
      const info = await fetchPdfInfo(apiBase, file);
      state.pageCount = info.total_pages;
      els.startPage.value = "1";
      els.endPage.value = String(info.total_pages);
      els.startPage.max = String(info.total_pages);
      els.endPage.max = String(info.total_pages);
      els.fileMeta.textContent = `${file.name} - ${formatBytes(file.size)} - ${info.total_pages} หน้า`;
      setProgressIdle(`พร้อมสแกน ${info.total_pages} หน้า`);
    } catch (error) {
      state.file = null;
      state.pageCount = null;
      els.fileInput.value = "";
      els.startPage.removeAttribute("max");
      els.endPage.removeAttribute("max");
      els.fileMeta.textContent = `${file.name} - อ่านจำนวนหน้าไม่สำเร็จ`;
      setProgressIdle(error.message || "อ่านจำนวนหน้าไม่สำเร็จ");
    } finally {
      state.readingInfo = false;
      updateButtons();
    }
  }

  function resetApp() {
    state.file = null;
    state.pageCount = null;
    state.readingInfo = false;
    state.rows = [];
    state.downloads = null;
    state.processing = false;
    state.scanToken += 1;
    els.fileInput.value = "";
    els.fileMeta.textContent = "ยังไม่ได้เลือกไฟล์";
    els.startPage.value = "1";
    els.endPage.value = "";
    els.startPage.removeAttribute("max");
    els.endPage.removeAttribute("max");
    els.downloadPanel.hidden = true;
    renderRows([]);
    setProgressIdle("รอไฟล์ PDF");
    updateButtons();
  }

  async function runScan() {
    if (!state.file || !state.pageCount || state.processing) return;
    state.processing = true;
    const scanToken = state.scanToken + 1;
    state.scanToken = scanToken;
    updateButtons();
    els.downloadPanel.hidden = true;

    try {
      const startPage = Number.parseInt(els.startPage.value, 10);
      const endPage = Number.parseInt(els.endPage.value, 10);
      validateInputs(startPage, endPage);
      const pageTotal = endPage - startPage + 1;
      const form = new FormData();
      form.append("file", state.file);
      form.append("start_page", String(startPage));
      form.append("end_page", String(endPage));
      form.append("scale", "0");
      form.append("priority_color", els.priorityColor.value);

      const apiBase = getScannerApiUrl();
      setProgressValue("กำลังส่งไฟล์ไป scanner", 0, pageTotal);
      const response = await fetch(`${apiBase}/api/scan-job`, { method: "POST", body: form });
      const queued = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(queued.detail || `Scanner API error ${response.status}`);
      if (!queued.job_id) throw new Error("Scanner API ไม่ส่ง job id กลับมา");

      const payload = await pollScanJob(apiBase, queued.job_id, scanToken, pageTotal);
      if (scanToken !== state.scanToken) return;
      state.rows = payload.rows || [];
      state.downloads = absolutizeDownloads(apiBase, payload.downloads || {});
      renderRows(state.rows);
      wireDownloads(state.downloads);
      setProgressDone(`เสร็จแล้ว: ${payload.row_count || state.rows.length} หน้า`);
    } catch (error) {
      if (scanToken === state.scanToken) setProgressIdle(error.message || "สแกนไม่สำเร็จ");
    } finally {
      if (scanToken === state.scanToken) {
        state.processing = false;
        updateButtons();
      }
    }
  }

  async function pollScanJob(apiBase, jobId, scanToken, fallbackTotal) {
    while (scanToken === state.scanToken) {
      await sleep(700);
      const response = await fetch(`${apiBase}/api/jobs/${jobId}`);
      const status = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(status.detail || `Scanner API error ${response.status}`);
      if (status.status === "failed") throw new Error(status.error || "สแกนไม่สำเร็จ");
      const total = Number(status.total_scan_pages || fallbackTotal || 0);
      const completed = Number(status.completed_pages || 0);
      if (status.status === "complete") {
        setProgressDone(`เสร็จแล้ว: ${status.result?.row_count || completed} หน้า`);
        return status.result || {};
      }
      if (status.status === "queued") setProgressValue("รอคิว scanner", completed, total);
      else setProgressValue(`กำลังสแกน PDF ${status.current_page ? `หน้า ${status.current_page}` : "กำลังเริ่มสแกน"}`, completed, total);
    }
    return {};
  }

  function validateInputs(startPage, endPage) {
    if (!Number.isInteger(startPage) || startPage < 1) throw new Error("หน้าเริ่มต้องเป็นเลขจำนวนเต็มตั้งแต่ 1 ขึ้นไป");
    if (!Number.isInteger(endPage) || endPage < 1) throw new Error("หน้าสิ้นสุดต้องเป็นเลขจำนวนเต็มตั้งแต่ 1 ขึ้นไป");
    if (endPage < startPage) throw new Error("หน้าสิ้นสุดต้องมากกว่าหรือเท่ากับหน้าเริ่ม");
    if (state.pageCount && endPage > state.pageCount) throw new Error(`PDF นี้มี ${state.pageCount} หน้า`);
  }

  function renderRows(rows) {
    els.pageCount.textContent = rows.length;
    els.topPriority.textContent = rows.length ? rows[0].priority_count : "0";
    els.totalPriority.textContent = rows.reduce((sum, row) => sum + Number(row.priority_count || 0), 0);
    if (!rows.length) {
      els.resultBody.innerHTML = '<tr><td colspan="7" class="empty-cell">ผลลัพธ์จะแสดงหลังสแกน PDF</td></tr>';
      return;
    }
    els.resultBody.innerHTML = rows.map((row) => `
      <tr>
        <td>${row.rank}</td><td>${row.page}</td><td><strong>${row.priority_count}</strong></td>
        <td>${Number(row.priority_raw).toFixed(2)}</td><td>${Number(row.priority_area || 0).toLocaleString()}</td>
        <td><span class="band ${bandClass(row.priority_band)}">${escapeHtml(row.priority_band)}</span></td><td>${escapeHtml(row.action)}</td>
      </tr>
    `).join("");
  }

  function wireDownloads(downloads) {
    if (!downloads?.pdf) return;
    els.downloadPdf.href = downloads.pdf;
    els.downloadCsv.href = downloads.csv;
    els.downloadPanel.hidden = false;
    createIcons({ icons });
  }

  function updateButtons() {
    els.runButton.disabled = state.processing || state.readingInfo || !state.file || !state.pageCount;
  }

  function updatePriorityColorPreview() {
    const colorClass = { red: "red", green: "green", blue: "blue", pink: "pink", orange_marker: "orange" }[els.priorityColor.value] || "red";
    els.priorityColorSwatch.className = `color-swatch ${colorClass}`;
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
    els.progressCount.textContent = total ? `${completed}/${total} หน้า (${Math.round(percent)}%)` : `${completed} หน้า`;
    els.progressBar.style.width = `${percent}%`;
  }

  function setProgressDone(text) {
    els.progressWrap.className = "progress-wrap done";
    els.progressText.textContent = text;
    els.progressCount.textContent = "100%";
    els.progressBar.style.width = "100%";
  }
}

function isPdf(file) {
  return file?.type === "application/pdf" || file?.name?.toLowerCase().endsWith(".pdf");
}

function getScannerApiUrl() {
  const apiUrl = String(DEFAULT_API_URL || "").trim().replace(/\/+$/, "");
  if (!apiUrl) {
    throw new Error("ยังไม่ได้ตั้งค่า Scanner API สำหรับ deployment นี้");
  }
  return apiUrl;
}

function isLocalHost() {
  return ["127.0.0.1", "localhost", "::1"].includes(window.location.hostname);
}

async function fetchPdfInfo(apiBase, file) {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${apiBase}/api/pdf-info`, { method: "POST", body: form });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || `Scanner API error ${response.status}`);
  if (!Number.isInteger(payload.total_pages) || payload.total_pages < 1) throw new Error("ไฟล์ PDF ไม่มีจำนวนหน้าที่อ่านได้");
  return payload;
}

function absolutizeDownloads(apiBase, downloads) {
  return Object.fromEntries(Object.entries(downloads).map(([key, value]) => [key, String(value).startsWith("http") ? value : `${apiBase}${value}`]));
}

function bandClass(band) {
  return String(band || "").toLowerCase().replaceAll(" ", "-");
}

function formatBytes(bytes) {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
