// Service worker — manages extension state across tabs

const DEFAULT_STATE = { enabled: true };

// Initialize state on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set(DEFAULT_STATE);
});

// Relay toggle messages from popup to the active tab's content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SET_ENABLED") {
    chrome.storage.local.set({ enabled: message.enabled });

    // Notify all YouTube tabs
    chrome.tabs.query({ url: "https://www.youtube.com/*" }, (tabs) => {
      tabs.forEach((tab) => {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      });
    });
  }

  if (message.type === "GET_STATE") {
    chrome.storage.local.get(DEFAULT_STATE, sendResponse);
    return true; // keep channel open for async response
  }
});
