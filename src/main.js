import { createIcons, icons } from "lucide";
import { createDocumentCompare } from "./documentCompare.js";
import "./styles.css";

document.querySelector("#app").innerHTML = `
  <main class="app-shell">
    <div class="app-card">
      <header class="topbar">
        <div class="brand">
          <img src="/logo_LE.svg" alt="L&E" />
          <div class="brand-copy">
            <h1>LE PDF Scan</h1>
            <p>สแกนและเปรียบเทียบเอกสาร</p>
          </div>
        </div>
        <div class="header-actions">
          <button class="gemini-header-button" id="geminiSettingsButton" type="button" aria-haspopup="dialog" aria-controls="geminiKeyDialog">
            <i data-lucide="key-round"></i>
            <span class="gemini-header-copy">
              <span class="gemini-header-title">Gemini</span>
              <span class="gemini-header-status" id="geminiHeaderStatus">ยังไม่ได้ตั้งค่า</span>
            </span>
          </button>
        </div>
      </header>
      <div class="gemini-dialog" id="geminiKeyDialog" hidden role="dialog" aria-modal="true" aria-labelledby="geminiDialogTitle">
        <section class="gemini-dialog-card">
          <div class="gemini-dialog-header">
            <div>
              <h2 id="geminiDialogTitle">ตั้งค่า Gemini</h2>
            </div>
            <button class="icon-button" id="geminiDialogClose" type="button" title="ปิดหน้าต่าง" aria-label="ปิดหน้าต่าง"><i data-lucide="x"></i></button>
          </div>
          <div class="gemini-dialog-body">
            <p>กรอก API key เพื่อให้ Gemini ช่วยเปรียบเทียบเอกสาร</p>
            <ol>
              <li>เปิด Google AI Studio แล้วเข้าสู่ระบบ</li>
              <li>เลือก <strong>Get API key</strong> และสร้างหรือคัดลอก key</li>
              <li>วาง key ในช่องด้านล่างแล้วกดบันทึก</li>
            </ol>
            <a class="gemini-key-help-link" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">
              <span>เปิด Google AI Studio เพื่อหา API key</span>
              <i data-lucide="external-link"></i>
            </a>
            <label class="gemini-dialog-key-field">
              <span>Gemini API key</span>
              <input id="geminiDialogKey" type="password" autocomplete="off" aria-label="Gemini API key" placeholder="วาง API key ที่นี่" />
            </label>
          </div>
          <div class="gemini-dialog-actions">
            <button class="button-secondary" id="geminiDialogClear" type="button"><i data-lucide="trash-2"></i><span>ล้าง key</span></button>
            <div class="gemini-dialog-main-actions">
              <button class="button-secondary" id="geminiDialogCancel" type="button">ยกเลิก</button>
              <button class="primary" id="geminiDialogSave" type="button"><i data-lucide="save"></i><span>บันทึก</span></button>
            </div>
          </div>
        </section>
      </div>
      <section id="compareModeView" class="mode-view"></section>
    </div>
  </main>
`;

const compareView = document.querySelector("#compareModeView");

createDocumentCompare(compareView, {
  geminiButton: document.querySelector("#geminiSettingsButton"),
  geminiHeaderStatus: document.querySelector("#geminiHeaderStatus"),
  geminiDialog: document.querySelector("#geminiKeyDialog"),
  geminiDialogKey: document.querySelector("#geminiDialogKey"),
  geminiDialogClose: document.querySelector("#geminiDialogClose"),
  geminiDialogCancel: document.querySelector("#geminiDialogCancel"),
  geminiDialogClear: document.querySelector("#geminiDialogClear"),
  geminiDialogSave: document.querySelector("#geminiDialogSave"),
});

const appHeader = document.querySelector(".topbar");
const compareScrollContent = compareView.querySelector(".compare-scroll-content");
if (appHeader && compareScrollContent) compareScrollContent.prepend(appHeader);

createIcons({ icons });
