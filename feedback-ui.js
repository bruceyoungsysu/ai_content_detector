// feedback-ui.js — Hover feedback buttons (AI / Real) on each YouTube video card.
// layer1.js must be loaded before this file (provides getVideoId, getChannelId,
// getChannelName, getCardTitle).

// Session-level label memory — survives SPA navigations without re-querying IDB.
const _labeled = new Map(); // videoId → "ai" | "real"

// ---------------------------------------------------------------------------
// Public API — called from content.js processCard()
// ---------------------------------------------------------------------------

function attachFeedbackWidget(cardEl) {
  if (cardEl.querySelector(".aicd-feedback")) return; // idempotent

  const videoId = getVideoId(cardEl); // defined in layer1.js
  if (!videoId) return;

  // title is captured now; channelId/channelName are re-read at click time
  // so we get the freshest cache state (metaCache may not be fully populated yet).
  const title = getCardTitle(cardEl); // defined in layer1.js

  const widget = document.createElement("div");
  widget.className = "aicd-feedback";

  const btnAi = document.createElement("button");
  btnAi.className = "aicd-fb-btn aicd-fb-ai";
  btnAi.textContent = "AI";
  btnAi.setAttribute("aria-label", "Mark as AI-generated");

  const btnReal = document.createElement("button");
  btnReal.className = "aicd-fb-btn aicd-fb-real";
  btnReal.textContent = "Real";
  btnReal.setAttribute("aria-label", "Mark as real content");

  widget.append(btnAi, btnReal);
  cardEl.appendChild(widget);

  // Restore session state (card re-rendered after SPA navigation).
  const prev = _labeled.get(videoId);
  if (prev) widget.dataset.labeled = prev;

  btnAi.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    _toggle(widget, videoId, getChannelId(cardEl), getChannelName(cardEl), title, "ai");
  });

  btnReal.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    _toggle(widget, videoId, getChannelId(cardEl), getChannelName(cardEl), title, "real");
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _toggle(widget, videoId, channelId, channelName, title, label) {
  const current = _labeled.get(videoId);

  if (current === label) {
    // Clicking the active button un-labels visually.
    // The IDB entry stays so the classifier keeps the signal.
    _labeled.delete(videoId);
    widget.dataset.labeled = "";
    return;
  }

  _labeled.set(videoId, label);
  widget.dataset.labeled = label;
  _sendFeedback(videoId, channelId, channelName, title, label);
}

function _sendFeedback(videoId, channelId, channelName, title, userLabel) {
  if (!chrome.runtime?.id) {
    // Extension was reloaded while this tab was open — context is invalidated.
    console.warn("[AICD] Extension context lost. Reload the page to re-enable labeling.");
    return;
  }
  try {
    chrome.runtime.sendMessage({
      type: "STORE_FEEDBACK",
      entry: {
        videoId,
        channelId,
        channelName,
        title,
        thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        userLabel,
        timestamp: Date.now(),
      },
    });
  } catch (e) {
    console.warn("[AICD] sendMessage failed:", e.message);
  }
}
