/**
 * background.js — AntiGravity Chrome Extension Service Worker
 *
 * Responsibilities:
 *   - Set default backend URL on install
 *   - Route GET_CONFIG / SAVE_CONFIG messages
 *   - Keep alive via periodic alarm (prevents MV3 suspension)
 *   - Forward notifications
 */

// ─── Default config ───────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(['backendUrl'], (result) => {
    if (!result.backendUrl) {
      chrome.storage.sync.set({ backendUrl: 'http://localhost:8000' });
    }
  });
});

// ─── Keep-alive alarm (fires every ~25 seconds via alarm API) ─────────────────
chrome.alarms.create('ag-keepalive', { periodInMinutes: 0.4 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'ag-keepalive') return;
  try {
    const { backendUrl } = await chrome.storage.sync.get(['backendUrl']);
    await fetch(`${backendUrl || 'http://localhost:8000'}/health`, {
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    // Backend not reachable — silent
  }
});

// ─── Message routing ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Config read
  if (message.type === 'GET_CONFIG') {
    chrome.storage.sync.get(['backendUrl'], (result) => {
      sendResponse({ backendUrl: result.backendUrl || 'http://localhost:8000' });
    });
    return true; // Keep channel open for async response
  }

  // Config write
  if (message.type === 'SAVE_CONFIG') {
    chrome.storage.sync.set({ backendUrl: message.backendUrl }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  // OS notification
  if (message.type === 'NOTIFY') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: message.title || 'AntiGravity',
      message: message.body || '',
    });
    sendResponse({ sent: true });
    return true;
  }

  // Open options page
  if (message.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    sendResponse({ opened: true });
    return true;
  }
});
