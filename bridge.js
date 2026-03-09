/**
 * Refinery 003 — bridge between MAIN world and service worker
 *
 * content.js runs in MAIN world (to patch window.fetch).
 * MAIN world has no access to chrome.runtime or chrome.storage.
 * This script runs in ISOLATED world (default) and bridges:
 *   window.postMessage → chrome.runtime.sendMessage
 *   chrome.storage → window.postMessage (settings)
 *
 * Source: step-009/code/bridge.js (base)
 * Change: sends settings (maxMessages) to MAIN world on load
 */

// Send settings to MAIN world
chrome.storage.local.get({ maxMessages: 250 }, (settings) => {
  window.postMessage({
    source: 'refinery-003-settings',
    maxMessages: settings.maxMessages,
  }, '*');
});

// Relay conversation data from MAIN → service worker
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.source !== 'refinery-003') return;

  chrome.runtime.sendMessage({
    type: event.data.type,
    data: event.data.data,
  }).catch(err => {
    console.debug('[refinery-003-bridge] sendMessage failed:', err.message);
  });
});

// Bridge chrome.storage polyfill requests from MAIN world
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.source !== 'refinery-003-storage') return;

  const { type, keys, items, callbackId } = event.data;

  if (type === 'get') {
    chrome.storage.local.get(keys, (result) => {
      window.postMessage({
        source: 'refinery-003-storage',
        callbackId,
        result,
      }, '*');
    });
  } else if (type === 'set') {
    chrome.storage.local.set(items, () => {
      window.postMessage({
        source: 'refinery-003-storage',
        callbackId,
        result: null,
      }, '*');

      if (items.maxMessages !== undefined) {
        chrome.storage.local.get({ maxMessages: 250 }, (settings) => {
          window.postMessage({
            source: 'refinery-003-settings',
            maxMessages: settings.maxMessages,
          }, '*');
        });
      }
    });
  } else if (type === 'remove') {
    chrome.storage.local.remove(keys, () => {
      window.postMessage({
        source: 'refinery-003-storage',
        callbackId,
        result: null,
      }, '*');
    });
  }
});
