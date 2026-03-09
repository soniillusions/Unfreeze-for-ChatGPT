/**
 * Refinery 003 — fetch intercept with truncation, cache, progressive load
 *
 * Source: step-022/code/content.js
 * Changes:
 *   - loading status: setInlineStatus (inline in header) instead of showToast (floating)
 *   - status appears after model selector dropdown, same line
 */

(function() {
  'use strict';

  const UI = window.ChatGPTUI;
  const STATUS_ID = 'refinery-status';
  const LOAD_BTN_ID = 'refinery-load-more';
  const CONVERSATION_URL_RE = /\/backend-api\/conversation\/[0-9a-f-]{36}$/;
  let MAX_MESSAGES = 250;

  // Listen for settings from bridge
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source === 'refinery-003-settings') {
      if (event.data.maxMessages) {
        MAX_MESSAGES = event.data.maxMessages;
        console.log('[refinery-003] settings: maxMessages =', MAX_MESSAGES);
      }
    }
  });

  // --- Window size persistence (one-shot: survives exactly one reload) ---
  // Flow: "Load earlier" saves window → reload → fetch uses saved → clears it
  // Next navigation/refresh → back to default MAX_MESSAGES
  const WINDOW_KEY = 'refinery-003-windows';

  function getSavedWindow(conversationId) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(WINDOW_KEY) || '{}');
      return saved[conversationId] || null;
    } catch { return null; }
  }

  function saveWindow(conversationId, windowSize) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(WINDOW_KEY) || '{}');
      saved[conversationId] = windowSize;
      sessionStorage.setItem(WINDOW_KEY, JSON.stringify(saved));
    } catch (e) {
      console.warn('[refinery-003] window save failed:', e.message);
    }
  }

  function clearSavedWindow(conversationId) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(WINDOW_KEY) || '{}');
      delete saved[conversationId];
      if (Object.keys(saved).length === 0) {
        sessionStorage.removeItem(WINDOW_KEY);
      } else {
        sessionStorage.setItem(WINDOW_KEY, JSON.stringify(saved));
      }
    } catch {}
  }

  // --- In-memory cache ---
  const cache = new Map();

  // --- Truncation logic ---
  function truncateMapping(data, maxMessages) {
    const allNodeIds = Object.keys(data.mapping);
    const messageCount = allNodeIds.filter(id =>
      data.mapping[id].message?.content
    ).length;

    if (messageCount <= maxMessages) {
      return { truncatedData: data, messageCount, truncated: false };
    }

    const keepIds = new Set();
    let currentId = data.current_node;
    let count = 0;

    while (currentId && count < maxMessages) {
      const node = data.mapping[currentId];
      if (!node) break;
      keepIds.add(currentId);
      if (node.message?.content) count++;
      currentId = node.parent;
    }

    if (currentId && data.mapping[currentId]) {
      keepIds.add(currentId);
    }

    const truncatedMapping = {};
    for (const id of keepIds) {
      const node = { ...data.mapping[id] };
      if (node.children) {
        node.children = node.children.filter(cid => keepIds.has(cid));
      }
      if (node.parent && !keepIds.has(node.parent)) {
        node.parent = null;
      }
      truncatedMapping[id] = node;
    }

    return {
      truncatedData: { ...data, mapping: truncatedMapping },
      messageCount,
      truncated: true,
    };
  }

  // --- Footer counter + inline Load more ---
  function showTruncationInfo(conversationId, totalMessages, currentWindow) {
    UI.removeElement(LOAD_BTN_ID);

    if (currentWindow >= totalMessages) {
      UI.clearFooterText();
      return;
    }

    // Footer: "Showing last 150 of 3870 messages"
    UI.setFooterText(`Showing last ${currentWindow} of ${totalMessages} messages`);

    // "Load more" at the top of conversation
    addLoadMoreToTop(conversationId, totalMessages, currentWindow);
  }

  function addLoadMoreToTop(conversationId, totalMessages, currentWindow) {
    if (document.querySelector(`[data-cgq-id="${LOAD_BTN_ID}"]`)) return;

    // Find the first message in the conversation
    const firstMsg = document.querySelector('[data-message-author-role]');
    if (!firstMsg) {
      setTimeout(() => addLoadMoreToTop(conversationId, totalMessages, currentWindow), 1000);
      return;
    }

    // Walk up to the article-level container
    const article = firstMsg.closest('article') || firstMsg.closest('[data-testid^="conversation-turn"]') || firstMsg.parentElement?.parentElement;
    if (!article) return;

    const btn = document.createElement('div');
    btn.dataset.cgqId = LOAD_BTN_ID;
    btn.style.cssText = 'text-align: center; padding: 16px; cursor: pointer; color: var(--text-tertiary, #999); font-size: 13px; transition: color 0.2s;';
    btn.textContent = `▲ Load ${Math.min(MAX_MESSAGES, totalMessages - currentWindow)} earlier messages`;
    btn.title = `Show more (currently ${currentWindow} of ${totalMessages})`;

    btn.addEventListener('mouseenter', () => btn.style.color = 'var(--text-primary, #333)');
    btn.addEventListener('mouseleave', () => btn.style.color = 'var(--text-tertiary, #999)');

    btn.addEventListener('click', () => {
      const entry = cache.get(conversationId);
      const newWindow = (entry?.currentWindow || currentWindow) + MAX_MESSAGES;

      if (entry) entry.currentWindow = newWindow;
      saveWindow(conversationId, newWindow);

      btn.textContent = 'reloading…';
      btn.style.pointerEvents = 'none';
      window.location.reload();
    });

    article.parentElement.insertBefore(btn, article);
  }

  // --- Fetch intercept ---
  const originalFetch = window.fetch;

  window.fetch = async function(...args) {
    const [resource, init] = args;
    const url = typeof resource === 'string' ? resource : resource?.url || '';

    if (!CONVERSATION_URL_RE.test(url)) {
      return originalFetch.apply(this, args);
    }

    const conversationId = url.split('/').pop();
    console.log('[refinery-003] intercepted:', url);

    // Determine window size: saved (one-shot) > default
    const savedWindow = getSavedWindow(conversationId);
    const windowSize = savedWindow || MAX_MESSAGES;
    if (savedWindow) {
      console.log('[refinery-003] using saved window:', savedWindow, '(one-shot, clearing)');
      clearSavedWindow(conversationId);
    }

    // Check in-memory cache first
    const cached = cache.get(conversationId);
    if (cached) {
      cached.currentWindow = windowSize;
      console.log('[refinery-003] serving from cache, window:', windowSize);
      UI.setInlineStatus(`from cache — ${windowSize} msgs`, { id: STATUS_ID });

      const { truncatedData, messageCount, truncated } = truncateMapping(
        cached.fullData, windowSize
      );

      const truncatedCount = Object.keys(truncatedData.mapping).length;
      if (truncated) {
        UI.updateInlineStatus(STATUS_ID, `${messageCount} → ${truncatedCount} msgs (cached)`);
        showTruncationInfo(conversationId, messageCount, windowSize);
      } else {
        UI.removeElement(LOAD_BTN_ID);
      }
      UI.hideInlineStatus(STATUS_ID, 1500);

      return new Response(JSON.stringify(truncatedData), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
      });
    }

    // First load (or after reload): fetch from network
    UI.setInlineStatus('loading conversation…', { id: STATUS_ID });
    const response = await originalFetch.apply(this, args);
    UI.updateInlineStatus(STATUS_ID, 'parsing…');

    let data;
    try {
      data = await response.clone().json();
    } catch (err) {
      console.error('[refinery-003] JSON parse failed:', err.message);
      UI.hideInlineStatus(STATUS_ID);
      return response;
    }

    if (!data?.mapping) {
      console.log('[refinery-003] no mapping, passing through');
      UI.hideInlineStatus(STATUS_ID);
      return response;
    }

    const allNodeIds = Object.keys(data.mapping);
    const totalMessages = allNodeIds.filter(id =>
      data.mapping[id].message?.content
    ).length;

    const title = data.title || '…';
    console.log('[refinery-003] conversation:', title, '|', totalMessages, 'messages');
    UI.updateInlineStatus(STATUS_ID, `${title} — ${totalMessages} msgs`);

    // Cache full data in memory
    cache.set(conversationId, {
      fullData: data,
      currentWindow: windowSize,
    });

    // Send FULL data to service worker
    const messages = [];
    for (const [nodeId, node] of Object.entries(data.mapping)) {
      if (node.message?.content) {
        messages.push({
          id: node.message.id,
          role: node.message.author?.role,
          content: node.message.content,
          model: node.message.metadata?.model_slug,
          create_time: node.message.create_time,
        });
      }
    }

    window.postMessage({
      source: 'refinery-003',
      type: 'SYNC_CONVERSATION',
      data: {
        conversation_id: data.conversation_id || conversationId,
        title: data.title,
        url: window.location.href,
        messages: messages,
      }
    }, '*');

    // Truncate for React
    const { truncatedData, messageCount, truncated } = truncateMapping(data, windowSize);

    if (!truncated) {
      console.log('[refinery-003] small conversation, no truncation needed');
      UI.hideInlineStatus(STATUS_ID, 1500);
      return new Response(JSON.stringify(data), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    const truncatedCount = Object.keys(truncatedData.mapping).length;
    console.log('[refinery-003] truncated:', totalMessages, '→', truncatedCount, 'nodes');
    UI.updateInlineStatus(STATUS_ID, `${totalMessages} → ${truncatedCount} msgs`);
    UI.hideInlineStatus(STATUS_ID, 1500);

    showTruncationInfo(conversationId, totalMessages, windowSize);

    return new Response(JSON.stringify(truncatedData), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  console.log('[refinery-003] fetch intercept installed (inline-status)');

  // ============================================
  // chrome.storage polyfill for DevTools convenience
  // ============================================

  if (!window.chrome) window.chrome = {};
  if (!window.chrome.storage) window.chrome.storage = {};
  if (!window.chrome.storage.local) {
    window.chrome.storage.local = {
      get: function(keys, callback) {
        const callbackId = 'storage-callback-' + Date.now() + '-' + Math.random();
        return new Promise((resolve) => {
          const listener = function(event) {
            if (event.data?.source === 'refinery-003-storage' && event.data.callbackId === callbackId) {
              window.removeEventListener('message', listener);
              const result = event.data.result !== undefined ? event.data.result : undefined;
              if (callback) callback(result);
              resolve(result);
            }
          };
          window.addEventListener('message', listener);

          window.postMessage({
            source: 'refinery-003-storage',
            type: 'get',
            keys: keys,
            callbackId: callbackId,
          }, '*');
        });
      },

      set: function(items, callback) {
        const callbackId = 'storage-callback-' + Date.now() + '-' + Math.random();
        return new Promise((resolve) => {
          const listener = function(event) {
            if (event.data?.source === 'refinery-003-storage' && event.data.callbackId === callbackId) {
              window.removeEventListener('message', listener);
              if (callback) callback();
              resolve();
            }
          };
          window.addEventListener('message', listener);

          window.postMessage({
            source: 'refinery-003-storage',
            type: 'set',
            items: items,
            callbackId: callbackId,
          }, '*');
        });
      },

      remove: function(keys, callback) {
        const callbackId = 'storage-callback-' + Date.now() + '-' + Math.random();
        return new Promise((resolve) => {
          const listener = function(event) {
            if (event.data?.source === 'refinery-003-storage' && event.data.callbackId === callbackId) {
              window.removeEventListener('message', listener);
              if (callback) callback();
              resolve();
            }
          };
          window.addEventListener('message', listener);

          window.postMessage({
            source: 'refinery-003-storage',
            type: 'remove',
            keys: keys,
            callbackId: callbackId,
          }, '*');
        });
      },
    };
  }

  console.log('[refinery-003] chrome.storage polyfill installed');
})();
