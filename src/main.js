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
      </header>
      <section id="compareModeView" class="mode-view"></section>
    </div>
  </main>
`;

const compareView = document.querySelector("#compareModeView");

createDocumentCompare(compareView);

createIcons({ icons });
