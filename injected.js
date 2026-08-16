/**
 * injected.js — MAIN world script
 * 1. 讀取 Facebook 內部 fb_dtsg token
 * 2. 提供 window.__FB_TOOLKIT__ RPC proxy（Phase 3 CDP 整合）
 * 注入時機：由 content.js 透過 <script> 標籤注入到頁面 MAIN world。
 */
(function () {
  'use strict';

  const CHANNEL = 'FB_TOOLKIT_BRIDGE';
  const VERSION = '0.1.0';

  // ─── fb_dtsg 擷取 ────────────────────────────────────────

  function extractDtsg() {
    try {
      if (window.require) {
        const dtsgModule = window.require('DTSGInitialData');
        if (dtsgModule && dtsgModule.token) return dtsgModule.token;
      }
    } catch (_) {}

    const input = document.querySelector('input[name="fb_dtsg"]');
    if (input && input.value) return input.value;

    const scripts = document.querySelectorAll('script:not([src])');
    for (const s of scripts) {
      const match = s.textContent.match(/"DTSGInitialData".*?"token":"([^"]+)"/);
      if (match) return match[1];
    }

    try {
      if (window.__comet_req && window.__comet_req.dtsg) {
        return window.__comet_req.dtsg.token;
      }
    } catch (_) {}

    return null;
  }

  // ─── RPC Bridge（main world → content script）────────────

  let rpcId = 0;
  const pendingCalls = new Map(); // id → { resolve, reject, timer }

  // 監聽 content script 的回應
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.channel !== CHANNEL) return;

    if (event.data.type === 'REQUEST_DTSG') {
      const token = extractDtsg();
      window.postMessage({
        channel: CHANNEL,
        type: 'DTSG_RESPONSE',
        payload: { token, timestamp: Date.now() }
      }, '*');
      return;
    }

    if (event.data.type === 'API_RESPONSE') {
      const { id, result, error } = event.data;
      const pending = pendingCalls.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingCalls.delete(id);
        if (error) pending.reject(new Error(error));
        else pending.resolve(result);
      }
    }
  });

  /**
   * 發送 RPC 呼叫到 content script
   * @param {string} action - handleAction 的 action 名稱
   * @param {object} options - 傳給 action 的參數
   * @param {number} timeout - 逾時（ms），預設 60s
   * @returns {Promise<any>}
   */
  function rpcCall(action, options = {}, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const id = ++rpcId;
      const timer = setTimeout(() => {
        pendingCalls.delete(id);
        reject(new Error(`RPC timeout: ${action} (${timeout}ms)`));
      }, timeout);

      pendingCalls.set(id, { resolve, reject, timer });

      window.postMessage({
        channel: CHANNEL,
        type: 'API_CALL',
        id,
        action,
        options
      }, '*');
    });
  }

  // ─── window.__FB_TOOLKIT__ API（main world 可用）─────────

  const toolkitAPI = {
    platform: 'facebook',
    version: VERSION,

    posts: {
      scan: (opts) => rpcCall('scanPosts', opts),
      scanGraphQL: (opts) => rpcCall('scanPostsGraphQL', opts),
      download: (posts, format) => rpcCall('downloadPosts', { posts, format })
    },

    comments: {
      scrape: (opts) => rpcCall('scrapeComments', opts),
      scrapeFlat: (opts) => rpcCall('scrapeCommentsFlat', opts),
      scrapeWithMedia: (opts) => rpcCall('scrapeCommentsWithMedia', opts)
    },

    batch: {
      scrapeComments: (opts) => rpcCall('batchScrapeComments', opts, 300000),
      scrapeFromProfile: (opts) => rpcCall('batchScrapeFromProfile', opts, 600000),
      status: () => rpcCall('batchStatus'),
      pause: () => rpcCall('batchPause'),
      resume: () => rpcCall('batchResume'),
      cancel: () => rpcCall('batchCancel')
    },

    media: {
      downloadAll: (comments, postId) => rpcCall('downloadMediaAll', { comments, postId }),
      downloadAndEnrich: (comments, postId) => rpcCall('downloadMediaAndEnrich', { comments, postId }),
      downloadPostsMedia: (posts, username) => rpcCall('downloadPostsMedia', { posts, username })
    },

    download: (data, format, filename) => rpcCall('download', { data, format, filename }),
    status: () => rpcCall('getStatus'),
    refreshDtsg: () => rpcCall('refreshDtsg'),
    resetCounter: () => rpcCall('resetCounter'),
    togglePanel: () => rpcCall('togglePanel'),
    getToolkitStatus: () => rpcCall('getToolkitStatus')
  };

  Object.defineProperty(window, '__FB_TOOLKIT__', {
    value: Object.freeze(toolkitAPI),
    writable: false,
    configurable: false
  });

  // 啟動廣播
  window.postMessage({
    channel: CHANNEL,
    type: 'INJECTED_READY',
    payload: { timestamp: Date.now() }
  }, '*');
})();
