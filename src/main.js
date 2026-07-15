import { createIcons, icons } from "lucide";
import { createDocumentCompare } from "./documentCompare.js";
import { createPriorityScanner } from "./priorityScan.js";
import "./styles.css";

document.querySelector("#app").innerHTML = `
  <main class="app-shell">
    <div class="app-card">
      <header class="topbar">
        <div class="brand">
          <img src="/logo_LE.svg" alt="L&E" />
          <div class="brand-copy">
            <h1>LE PDF Scan</h1>
            <p>สแกนและเปรียบเทียบเอกสารสำหรับทีมช่าง</p>
          </div>
        </div>
        <span class="beta-badge">Beta 2</span>
      </header>

      <nav class="mode-tabs" aria-label="โหมดการสแกน" role="tablist">
        <button class="mode-tab active" id="priorityModeTab" type="button" role="tab" aria-selected="true" aria-controls="priorityModeView" data-mode="priority">
          <i data-lucide="scan-line"></i><span>Priority scan</span>
        </button>
        <button class="mode-tab" id="compareModeTab" type="button" role="tab" aria-selected="false" aria-controls="compareModeView" data-mode="compare">
          <i data-lucide="git-compare"></i><span>Document compare</span>
        </button>
      </nav>

      <section id="priorityModeView" class="mode-view" role="tabpanel" aria-labelledby="priorityModeTab"></section>
      <section id="compareModeView" class="mode-view" role="tabpanel" aria-labelledby="compareModeTab" hidden></section>
    </div>
  </main>
`;

const priorityView = document.querySelector("#priorityModeView");
const compareView = document.querySelector("#compareModeView");
const tabs = [...document.querySelectorAll(".mode-tab")];

createPriorityScanner(priorityView);
createDocumentCompare(compareView);

tabs.forEach((tab) => {
  tab.addEventListener("click", () => selectMode(tab.dataset.mode));
});

function selectMode(mode) {
  const priorityActive = mode === "priority";
  priorityView.hidden = !priorityActive;
  compareView.hidden = priorityActive;
  tabs.forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
}

createIcons({ icons });
