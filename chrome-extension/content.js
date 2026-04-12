/**
 * content.js — AntiGravity Chrome Extension Content Script
 *
 * Injected into https://meet.google.com/* at document_idle.
 * Responsibilities:
 *   1. Wait for Google Meet to stabilise then inject the floating overlay <iframe>
 *   2. Make the overlay draggable
 *   3. Monitor tab visibility and window focus → forward as integrity events to overlay
 *   4. Listen for resize requests from overlay
 */

'use strict';

// ─── Self-guard (run only once) ───────────────────────────────────────────────
if (window.__agInjected) {
  console.debug('[AntiGravity] Already injected — skipping');
} else {
  window.__agInjected = true;
  main();
}

function main() {
  let overlayContainer = null;
  let overlayIframe    = null;
  let isDragging       = false;
  let dragOffsetX = 0, dragOffsetY = 0;

  // ─── Wait for Meet UI ─────────────────────────────────────────────────────
  function waitForMeet() {
    const selectors = [
      '[data-meeting-title]',
      '[data-call-waiting-ui]',
      '#yDmH0d',
      '[jsname="Qx7uuf"]',
    ];

    const check = () => selectors.some(s => document.querySelector(s));

    if (check()) {
      injectOverlay();
      return;
    }

    const observer = new MutationObserver(() => {
      if (check()) {
        observer.disconnect();
        setTimeout(injectOverlay, 800);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Hard fallback after 15s
    setTimeout(() => {
      observer.disconnect();
      injectOverlay();
    }, 15000);
  }

  // ─── Inject overlay ───────────────────────────────────────────────────────
  function injectOverlay() {
    if (document.getElementById('ag-overlay-container')) return;

    // Container
    const container = document.createElement('div');
    container.id = 'ag-overlay-container';
    Object.assign(container.style, {
      position:     'fixed',
      bottom:       '24px',
      right:        '24px',
      width:        '380px',
      height:       '580px',
      zIndex:       '2147483647',
      borderRadius: '18px',
      boxShadow:    '0 28px 64px rgba(0,0,0,0.55), 0 0 0 1.5px rgba(108,99,255,0.4)',
      overflow:     'hidden',
      userSelect:   'none',
      transition:   'box-shadow 0.2s ease, width 0.25s ease, height 0.25s ease',
    });

    // Iframe
    const iframe = document.createElement('iframe');
    iframe.id  = 'ag-overlay-iframe';
    iframe.src = chrome.runtime.getURL('overlay/overlay.html');
    Object.assign(iframe.style, {
      width:      '100%',
      height:     '100%',
      border:     'none',
      background: 'transparent',
      display:    'block',
    });
    // Permissions needed for getDisplayMedia inside the iframe
    iframe.allow = 'display-capture; microphone; camera; autoplay';
    iframe.setAttribute('allowfullscreen', '');

    container.appendChild(iframe);
    document.body.appendChild(container);

    overlayContainer = container;
    overlayIframe    = iframe;

    makeDraggable(container);
    setupIntegrityMonitoring();

    console.info('[AntiGravity] Overlay injected successfully.');
  }

  // ─── Draggable ────────────────────────────────────────────────────────────
  function makeDraggable(el) {
    el.addEventListener('mousedown', (e) => {
      // Only drag if target is the container itself or a marked drag-handle
      const isHandle = e.target === el ||
                       e.target.id === 'ag-overlay-container' ||
                       e.target.closest?.('.ag-drag-handle');
      if (!isHandle) return;

      isDragging  = true;
      const rect  = el.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;

      el.style.cursor = 'grabbing';
      el.style.transition = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging || !overlayContainer) return;

      let newLeft = e.clientX - dragOffsetX;
      let newTop  = e.clientY - dragOffsetY;

      const maxLeft = window.innerWidth  - overlayContainer.offsetWidth;
      const maxTop  = window.innerHeight - overlayContainer.offsetHeight;

      newLeft = Math.max(0, Math.min(newLeft, maxLeft));
      newTop  = Math.max(0, Math.min(newTop,  maxTop));

      overlayContainer.style.right  = 'auto';
      overlayContainer.style.bottom = 'auto';
      overlayContainer.style.left   = `${newLeft}px`;
      overlayContainer.style.top    = `${newTop}px`;
    });

    document.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      el.style.cursor = 'default';
      el.style.transition = 'box-shadow 0.2s ease, width 0.25s ease, height 0.25s ease';
    });
  }

  // ─── Integrity event monitoring ───────────────────────────────────────────
  let lastFocusTime = Date.now();

  function setupIntegrityMonitoring() {
    // Tab visibility
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        postToOverlay({
          type:       'integrity_event',
          event_type: 'tab_switch',
          timestamp:  new Date().toISOString(),
          direction:  'away',
        });
        lastFocusTime = Date.now();
      } else {
        const awayMs = Date.now() - lastFocusTime;
        postToOverlay({
          type:            'integrity_event',
          event_type:      'tab_return',
          timestamp:       new Date().toISOString(),
          duration_away_s: (awayMs / 1000).toFixed(1),
        });
        lastFocusTime = Date.now();
      }
    });

    // Window focus
    window.addEventListener('blur', () => {
      postToOverlay({
        type:       'integrity_event',
        event_type: 'focus_loss',
        timestamp:  new Date().toISOString(),
      });
    });

    window.addEventListener('focus', () => {
      postToOverlay({
        type:       'integrity_event',
        event_type: 'focus_return',
        timestamp:  new Date().toISOString(),
      });
    });
  }

  function postToOverlay(message) {
    try {
      overlayIframe?.contentWindow?.postMessage(message, '*');
    } catch {
      // iframe not ready
    }
  }

  // ─── Messages FROM overlay ────────────────────────────────────────────────
  window.addEventListener('message', (e) => {
    if (!e.data) return;

    // Resize / minimise
    if (e.data.type === 'AG_RESIZE' && overlayContainer) {
      if (e.data.mode === 'minimized') {
        overlayContainer.style.width        = '64px';
        overlayContainer.style.height       = '64px';
        overlayContainer.style.borderRadius = '50%';
      } else {
        overlayContainer.style.width        = '380px';
        overlayContainer.style.height       = '580px';
        overlayContainer.style.borderRadius = '18px';
      }
    }

    if (e.data.type === 'AG_SET_SIZE' && overlayContainer) {
      if (e.data.width)  overlayContainer.style.width  = `${e.data.width}px`;
      if (e.data.height) overlayContainer.style.height = `${e.data.height}px`;
    }
  });

  // ─── Start ────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForMeet);
  } else {
    waitForMeet();
  }
}
