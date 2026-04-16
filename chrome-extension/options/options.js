/**
 * options.js — AntiGravity Extension Options Page Logic
 */

'use strict';

const DEFAULT_URL = 'https://safeinterview-1.onrender.com';

async function init() {
  // Load saved config
  const input = document.getElementById('backend-url');
  const saved = await getStoredUrl();
  input.value = saved;

  // Wire events
  document.getElementById('save-btn').addEventListener('click', saveSettings);
  document.getElementById('reset-btn').addEventListener('click', resetSettings);
  document.getElementById('test-btn').addEventListener('click', testConnection);
}

async function getStoredUrl() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['backendUrl'], (result) => {
      resolve(result.backendUrl || DEFAULT_URL);
    });
  });
}

async function saveSettings() {
  const input  = document.getElementById('backend-url');
  const status = document.getElementById('save-status');
  const url    = input.value.trim();

  if (!url) {
    showStatus(status, '⚠ Please enter a backend URL.', 'error');
    return;
  }

  try {
    new URL(url); // validate format
  } catch {
    showStatus(status, '⚠ Invalid URL format.', 'error');
    return;
  }

  await new Promise((resolve) =>
    chrome.storage.sync.set({ backendUrl: url }, resolve)
  );

  showStatus(status, '✓ Settings saved successfully.', 'success');
}

async function resetSettings() {
  const input  = document.getElementById('backend-url');
  const status = document.getElementById('save-status');

  input.value = DEFAULT_URL;
  await new Promise((resolve) =>
    chrome.storage.sync.set({ backendUrl: DEFAULT_URL }, resolve)
  );

  showStatus(status, '✓ Reset to default (localhost:8000).', 'success');
}

async function testConnection() {
  const input  = document.getElementById('backend-url');
  const result = document.getElementById('test-result');
  const btn    = document.getElementById('test-btn');

  const url = input.value.trim() || DEFAULT_URL;
  btn.textContent = 'Testing...';
  btn.disabled    = true;
  result.className = 'test-result';
  result.classList.remove('hidden');
  result.textContent = 'Connecting...';

  try {
    const res = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(6000),
    });
    const data = await res.json();

    if (res.ok) {
      result.classList.add('success');
      result.textContent = `✓ Connected! Service: "${data.service || 'ok'}" — version ${data.version || '?'}`;
    } else {
      result.classList.add('error');
      result.textContent = `✗ Endpoint responded with status ${res.status}.`;
    }
  } catch (err) {
    result.classList.add('error');
    result.textContent = `✗ Could not reach backend: ${err.message}`;
  } finally {
    btn.textContent = 'Test';
    btn.disabled    = false;
  }
}

function showStatus(el, message, type) {
  el.textContent = message;
  el.className   = `save-status ${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

document.addEventListener('DOMContentLoaded', init);
