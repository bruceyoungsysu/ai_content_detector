const toggle     = document.getElementById("toggle");
const dot        = document.getElementById("statusDot");
const statsCounts  = document.getElementById("statsCounts");
const statsStatus  = document.getElementById("statsStatus");
const btnExport  = document.getElementById("btnExport");

const MIN_PER_CLASS = 10;

// ---------------------------------------------------------------------------
// State — toggle
// ---------------------------------------------------------------------------

chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
  const enabled = state?.enabled ?? true;
  toggle.checked = enabled;
  dot.classList.toggle("off", !enabled);
});

toggle.addEventListener("change", () => {
  const enabled = toggle.checked;
  dot.classList.toggle("off", !enabled);
  chrome.runtime.sendMessage({ type: "SET_ENABLED", enabled });
});

// ---------------------------------------------------------------------------
// Training stats
// ---------------------------------------------------------------------------

chrome.runtime.sendMessage({ type: "GET_FEEDBACK_COUNTS" }, (counts) => {
  const ai   = counts?.ai   ?? 0;
  const real = counts?.real ?? 0;
  const total = ai + real;

  if (total === 0) {
    statsCounts.textContent = "No labels yet";
    statsStatus.textContent = "Use the AI / Real buttons on video cards to start training.";
    statsStatus.classList.remove("active");
    return;
  }

  statsCounts.innerHTML =
    `${total} labeled — ` +
    `<span class="ai-count">${ai} AI</span> · ` +
    `<span class="real-count">${real} Real</span>`;

  const needAi   = Math.max(0, MIN_PER_CLASS - ai);
  const needReal = Math.max(0, MIN_PER_CLASS - real);

  if (needAi === 0 && needReal === 0) {
    statsStatus.textContent = "✓ Classifier active";
    statsStatus.classList.add("active");
  } else {
    const parts = [];
    if (needAi   > 0) parts.push(`${needAi} more AI`);
    if (needReal > 0) parts.push(`${needReal} more Real`);
    statsStatus.textContent = `Need ${parts.join(" and ")} to activate classifier`;
    statsStatus.classList.remove("active");
  }
});

// ---------------------------------------------------------------------------
// Export — download current IDB as private_seed.json
// ---------------------------------------------------------------------------

btnExport.addEventListener("click", () => {
  btnExport.disabled = true;
  btnExport.textContent = "Exporting…";

  chrome.runtime.sendMessage({ type: "EXPORT_FEEDBACK" }, (response) => {
    const entries = response?.entries ?? [];

    if (entries.length === 0) {
      btnExport.textContent = "Nothing to export";
      setTimeout(() => {
        btnExport.disabled = false;
        btnExport.textContent = "Export training data";
      }, 2000);
      return;
    }

    const json = JSON.stringify(entries, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url  = URL.createObjectURL(blob);

    chrome.downloads.download({
      url,
      filename: "private_seed.json",
      saveAs: false,
    }, () => {
      URL.revokeObjectURL(url);
      btnExport.textContent = `Exported ${entries.length} labels`;
      setTimeout(() => {
        btnExport.disabled = false;
        btnExport.textContent = "Export training data";
      }, 2500);
    });
  });
});
