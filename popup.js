const toggle = document.getElementById("toggle");
const dot = document.getElementById("statusDot");

// Load current state and reflect it in the UI
chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
  const enabled = state?.enabled ?? true;
  toggle.checked = enabled;
  dot.classList.toggle("off", !enabled);
});

// Send updated state when the user flips the toggle
toggle.addEventListener("change", () => {
  const enabled = toggle.checked;
  dot.classList.toggle("off", !enabled);
  chrome.runtime.sendMessage({ type: "SET_ENABLED", enabled });
});
