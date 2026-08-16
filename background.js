/**
 * background.js — Service Worker (MV3)
 * 職責：
 * 1. chrome.downloads API 代理
 * 2. Batch Queue 持久化 + 背景執行（Phase 4）
 * 3. 離開 FB 頁面仍能跑（透過 executeScript 注入到 FB tab）
 */

// ─── Phase 9: 點擊 icon → toggle 浮動面板（取代 popup）──
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !tab.url?.includes('facebook.com')) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'togglePanel' });
  } catch (_) {}
});

// ─── Phase 9: 狀態快照（content → background → popup）──
let toolkitStatus = { phase: 'idle', action: '', progress: {}, startTime: null, error: null };

// ─── Downloads 代理 ─────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  // Phase 9: 狀態推送（content → background → popup）
  if (message.type === 'STATUS_UPDATE') {
    toolkitStatus = message.status || toolkitStatus;
    updateIconState(toolkitStatus);
    // 轉發給已開啟的 popup（popup 關閉時會拋錯，吞掉）
    chrome.runtime.sendMessage(message).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  // 處理 content script 的 READY ping（用 type 不用 action）
  if (message.type === 'CONTENT_SCRIPT_READY') {
    sendResponse({ ok: true, tabId: sender.tab?.id });
    return true;
  }

  switch (message.action) {
    case 'downloadFile':
      handleDownload(message, sendResponse);
      return true;

    case 'downloadContent': {
      // content script → background → data URL + onDeterminingFilename 覆寫檔名
      const { content: rawContent, mimeType: mt, filename: fn } = message;
      console.log('[BG] downloadContent:', fn, rawContent?.length, 'chars');
      if (!rawContent || !fn) { sendResponse({ ok: false, error: 'missing content or filename' }); return; }
      const b64 = btoa(unescape(encodeURIComponent(rawContent)));
      const dataUrl = 'data:' + (mt || 'application/json') + ';base64,' + b64;
      downloadWithFilename(dataUrl, fn).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
      return true;
    }

    case 'getToolkitStatus':
      sendResponse({ status: toolkitStatus });
      return true;

    case 'openDownloadSettings':
      chrome.tabs.create({ url: 'chrome://settings/downloads' });
      sendResponse({ ok: true });
      return true;

    case 'hideDownloadShelf':
    case 'showDownloadShelf':
      sendResponse({ ok: true });
      return true;

    case 'bg_startBatch':
      handleBgBatch(message.queue, message.options).then(sendResponse);
      return true;

    case 'bg_getBatchStatus':
      sendResponse({ ...bgBatchState });
      return true;

    case 'bg_pauseBatch':
      bgBatchState.paused = true;
      sendResponse({ ok: true });
      return true;

    case 'bg_resumeBatch':
      bgBatchState.paused = false;
      sendResponse({ ok: true });
      return true;

    case 'bg_cancelBatch':
      bgBatchState.cancelled = true;
      sendResponse({ ok: true });
      return true;

    case 'bg_saveQueue':
      chrome.storage.local.set({ batchQueue: message.queue }, () => {
        sendResponse({ ok: true });
      });
      return true;

    case 'bg_loadQueue':
      chrome.storage.local.get('batchQueue', (data) => {
        sendResponse({ queue: data.batchQueue || [] });
      });
      return true;

    default:
      return false;
  }
});

function handleDownload(message, sendResponse) {
  const { url, filename } = message;
  console.log('[BG] handleDownload:', filename, 'url length:', url?.length);
  if (!url) {
    sendResponse({ ok: false, error: 'empty URL' });
    return;
  }

  try {
    // 排入 queue（onDeterminingFilename 在 callback 之前觸發）
    if (filename) _filenameQueue.push(filename);
    chrome.downloads.download(
      {
        url,
        saveAs: false,
        conflictAction: 'uniquify'
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error('[BG] download error:', chrome.runtime.lastError.message);
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          console.log('[BG] download ok:', downloadId, filename);
          sendResponse({ ok: true, downloadId, filename });
        }
      }
    );
  } catch (e) {
    console.error('[BG] download exception:', e.message);
    sendResponse({ ok: false, error: e.message });
  }
}

// ─── Background Batch Execution（Phase 4 #3）────────────

const bgBatchState = {
  running: false,
  paused: false,
  cancelled: false,
  current: 0,
  total: 0,
  results: [],
  error: null
};

/**
 * 找到一個 FB tab 來執行 content script 指令
 * @returns {Promise<number|null>} tabId
 */
async function findFbTab() {
  const tabs = await chrome.tabs.query({ url: '*://*.facebook.com/*' });
  // 優先找 active 的，其次任何 FB tab
  const active = tabs.find(t => t.active);
  return (active || tabs[0])?.id || null;
}

/**
 * 透過 executeScript + window.postMessage 呼叫 content script
 * 完全繞過 chrome.runtime.onMessage 通道（該通道在 SPA 導航後不可靠）
 * 走 content script 已有的 RPC bridge（API_CALL / API_RESPONSE）
 */
async function sendToFbTab(tabId, action, options = {}, timeoutMs = 60000) {
  // 先嘗試傳統 sendMessage（快速路徑）
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { action, options });
    if (resp !== undefined) return resp;
  } catch (_) {
    // 傳統通道失敗，走 executeScript RPC fallback
  }

  // Fallback: executeScript + window.postMessage RPC
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (action, options, timeoutMs) => {
      return new Promise((resolve, reject) => {
        const id = 'bg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const timer = setTimeout(() => {
          window.removeEventListener('message', handler);
          reject(new Error(`RPC timeout: ${action}`));
        }, timeoutMs);

        function handler(event) {
          if (event.source !== window) return;
          if (!event.data || event.data.channel !== 'FB_TOOLKIT_BRIDGE') return;
          if (event.data.type !== 'API_RESPONSE' || event.data.id !== id) return;
          window.removeEventListener('message', handler);
          clearTimeout(timer);
          if (event.data.error) {
            reject(new Error(event.data.error));
          } else {
            resolve(event.data.result);
          }
        }

        window.addEventListener('message', handler);
        window.postMessage({
          channel: 'FB_TOOLKIT_BRIDGE',
          type: 'API_CALL',
          id,
          action,
          options
        }, '*');
      });
    },
    args: [action, options, timeoutMs]
  });

  if (results?.[0]?.result !== undefined) return results[0].result;
  throw new Error(`executeScript RPC failed for action: ${action}`);
}

/**
 * 導航 tab 到指定 URL 並等待 content script 就緒（Ping-Pong 協議）
 *
 * 三層保障：
 * 1. 等 CONTENT_SCRIPT_READY 訊息（content script 主動通知）
 * 2. Fallback: tabs.onUpdated complete + executeScript 強制注入
 * 3. 安全超時
 */
function navigateAndEnsure(tabId, url, timeout = 30000) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let pageComplete = false;

    const timer = setTimeout(() => {
      cleanup();
      if (!resolved) {
        resolved = true;
        reject(new Error(`頁面載入超時 (${timeout / 1000}s): ${url}`));
      }
    }, timeout);

    // 層 1: 監聽 content script 主動 ping
    function onMessage(msg, sender) {
      if (resolved) return;
      if (sender.tab?.id === tabId && msg.type === 'CONTENT_SCRIPT_READY') {
        cleanup();
        resolved = true;
        // 再等 1 秒確保 fb_dtsg 也抓到
        setTimeout(() => resolve(tabId), 1000);
      }
    }

    // 層 2: 監聽頁面載入完成（作為 fallback 觸發點）
    function onUpdated(tid, changeInfo) {
      if (tid !== tabId || resolved) return;
      if (changeInfo.status === 'complete') {
        pageComplete = true;
        // 頁面載入完成但 content script 可能還沒 ready
        // 等 3 秒後如果還沒收到 ping，強制注入
        setTimeout(async () => {
          if (resolved) return;
          try {
            // 先嘗試 ping
            const resp = await chrome.tabs.sendMessage(tabId, { action: 'getStatus' });
            if (resp?.ok && !resolved) {
              cleanup();
              resolved = true;
              resolve(tabId);
              return;
            }
          } catch (_) {}

          // Ping 失敗：強制注入
          if (!resolved) {
            try {
              await chrome.scripting.executeScript({
                target: { tabId }, files: ['content.js']
              });
              await chrome.scripting.executeScript({
                target: { tabId }, files: ['injected.js'], world: 'MAIN'
              });
            } catch (_) {}
            // 等注入初始化
            await new Promise(r => setTimeout(r, 2000));
            if (!resolved) {
              cleanup();
              resolved = true;
              resolve(tabId);
            }
          }
        }, 3000);
      }
    }

    function cleanup() {
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    }

    chrome.runtime.onMessage.addListener(onMessage);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url });
  });
}

/**
 * Background batch orchestration
 * 離開 FB 頁面時，background 接管 batch 執行
 */
async function handleBgBatch(queue, options = {}) {
  if (bgBatchState.running) {
    return { error: 'Batch already running' };
  }

  bgBatchState.running = true;
  bgBatchState.paused = false;
  bgBatchState.cancelled = false;
  bgBatchState.current = 0;
  bgBatchState.total = queue.length;
  bgBatchState.results = [];
  bgBatchState.error = null;

  // 保存進度到 storage
  await chrome.storage.local.set({ bgBatchState: { ...bgBatchState } });

  const tabId = await findFbTab();
  if (!tabId) {
    bgBatchState.running = false;
    bgBatchState.error = '找不到 Facebook 頁面。請至少保留一個 FB 分頁開著。';
    return { error: bgBatchState.error };
  }

  for (let i = 0; i < queue.length; i++) {
    if (bgBatchState.cancelled) break;

    // 暫停等待
    while (bgBatchState.paused && !bgBatchState.cancelled) {
      await new Promise(r => setTimeout(r, 500));
    }
    if (bgBatchState.cancelled) break;

    bgBatchState.current = i + 1;
    const entry = queue[i];

    try {
      // Step 0: 導航 + Ping-Pong 等 content script 就緒
      await navigateAndEnsure(tabId, entry.pageUrl);

      // Step 1: 刷新 fb_dtsg
      await sendToFbTab(tabId, 'refreshDtsg');

      // Step 2: 掃描貼文（只掃不抓留言，留言由用戶勾選後再抓）
      const scanResult = await sendToFbTab(tabId, 'scanPostsGraphQL', {
        targetCount: entry.count || 10
      });

      const posts = scanResult?.posts || [];
      bgBatchState.results.push({
        title: entry.pageName,
        pageUrl: entry.pageUrl,
        success: posts.length > 0,
        error: posts.length === 0 ? 'No posts found' : null,
        postsCount: posts.length,
        posts
      });
    } catch (err) {
      bgBatchState.results.push({
        title: entry.pageName,
        pageUrl: entry.pageUrl,
        success: false,
        error: err.message,
        totalComments: 0,
        posts: []
      });
    }

    // 保存進度
    await chrome.storage.local.set({ bgBatchState: { ...bgBatchState } });

    // 粉專間間隔（8-15 秒隨機）
    if (i < queue.length - 1 && !bgBatchState.cancelled) {
      const delay = 8000 + Math.random() * 7000;
      await new Promise(r => setTimeout(r, delay));
    }
  }

  bgBatchState.running = false;
  await chrome.storage.local.set({ bgBatchState: { ...bgBatchState } });

  return {
    meta: {
      total: queue.length,
      completed: bgBatchState.results.length,
      cancelled: bgBatchState.cancelled
    },
    results: bgBatchState.results
  };
}

// ─── onDeterminingFilename 攔截器（解決 data/blob URL + filename 失效問題）────
// Chrome 對 data/blob URL 忽略 download({ filename }) 參數
// 用 onDeterminingFilename 事件強制覆寫檔名（含子目錄）
// 注意：onDeterminingFilename 在 download callback 之前觸發，所以用 queue 而非 Map
const _filenameQueue = [];

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId === chrome.runtime.id && _filenameQueue.length > 0) {
    const fn = _filenameQueue.shift();
    console.log('[BG] onDeterminingFilename override:', item.id, '→', fn);
    suggest({ filename: fn, conflictAction: 'uniquify' });
  }
});

// ─── Phase 9 T1a: Icon badge + title 更新 ─────────────
const BADGE_MAP = {
  idle:        { text: '',  color: '#999999' },
  scanning:    { text: '掃', color: '#4a9eff' },
  downloading: { text: '↓',  color: '#22c55e' },
  exporting:   { text: '存', color: '#f59e0b' },
  done:        { text: '✓',  color: '#22c55e' },
  error:       { text: '✕',  color: '#ff4444' }
};

function updateIconState(status) {
  const phase = status?.phase || 'idle';
  const badge = BADGE_MAP[phase] || BADGE_MAP.idle;

  chrome.action.setBadgeText({ text: badge.text });
  if (badge.text) {
    chrome.action.setBadgeBackgroundColor({ color: badge.color });
  }

  // Title：idle 時簡潔，active 時帶進度
  if (phase === 'idle') {
    chrome.action.setTitle({ title: 'FB Catch' });
  } else {
    const action = status.action || phase;
    const pct = status.progress?.posts?.pct;
    let elapsed = '';
    if (status.startTime) {
      const secs = Math.round((Date.now() - status.startTime) / 1000);
      const mm = Math.floor(secs / 60);
      const ss = secs % 60;
      elapsed = ` · ${mm}:${String(ss).padStart(2, '0')}`;
    }
    const pctStr = pct != null ? ` ${pct}%` : '';
    chrome.action.setTitle({ title: `FB Catch — ${action}${pctStr}${elapsed}` });
  }
}

function downloadWithFilename(dataUrl, filename) {
  // 先排入 queue，再觸發下載（onDeterminingFilename 會在 callback 之前觸發）
  _filenameQueue.push(filename);
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: dataUrl, saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error('[BG] download error:', chrome.runtime.lastError.message);
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          console.log('[BG] download started:', downloadId, filename);
          resolve({ ok: true, downloadId, filename });
        }
      }
    );
  });
}
