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

  // Capture metadata at attach time so click handlers don't need cardEl.
  const channelId   = getChannelId(cardEl);   // defined in layer1.js
  const channelName = getChannelName(cardEl); // defined in layer1.js
  const title       = getCardTitle(cardEl);   // defined in layer1.js

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

  // JS-managed hover — CSS :hover breaks when YouTube's video preview overlay
  // intercepts pointer events. A 300ms grace period lets the user move the mouse
  // from the card surface to the buttons without the widget disappearing.
  let _hideTimer = null;
  const _show = () => { clearTimeout(_hideTimer); widget.classList.add("aicd-visible"); };
  const _scheduleHide = () => { _hideTimer = setTimeout(() => widget.classList.remove("aicd-visible"), 300); };
  cardEl.addEventListener("mouseenter", _show);
  cardEl.addEventListener("mouseleave", _scheduleHide);
  widget.addEventListener("mouseenter", _show);    // cancel hide when mouse reaches buttons
  widget.addEventListener("mouseleave", _scheduleHide);

  btnAi.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    _toggle(widget, videoId, channelId, channelName, title, "ai");
  });

  btnReal.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    _toggle(widget, videoId, channelId, channelName, title, "real");
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
}
