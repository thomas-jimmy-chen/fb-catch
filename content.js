/**
 * content.js — Content Script (Isolated World)
 * 角色：dispatcher + pipeline 容器 + window API 暴露
 *
 * Phase 1: 骨架 — dispatcher, injected.js 注入, fb_dtsg 橋接, window API shell
 * Phase 2a: postsPipeline 實作
 * Phase 2b: commentsPipeline 實作
 * Phase 2c: batchPipeline 實作
 */
(function () {
  'use strict';

  // 防止重複注入（背景 ensureContentScript 可能二次 inject）
  if (window.__FB_TOOLKIT_LOADED__) return;
  window.__FB_TOOLKIT_LOADED__ = true;

  const CHANNEL = 'FB_TOOLKIT_BRIDGE';
  const VERSION = '0.1.0';
  const _INTEGRITY = 'tch-9f4a7c2e-8b1d-4e6f-a3c0-5d7e2f9b8a41';

  // ─── 平台註冊表 ─────────────────────────────────────────
  const platforms = {
    facebook: {
      match: /facebook\.com/,
      delays: {
        postScan: 2000,
        commentFetch: 2000,
        replyFetch: 4000,
        betweenPosts: 5000,
        onRateLimit: 15000
      },
      // 安全下限（不可低於此值）
      minDelays: {
        postScan: 1000,
        commentFetch: 1000,
        replyFetch: 2000,
        betweenPosts: 3000,
        onRateLimit: 10000
      }
    }
    // 未來擴展: threads: { match: /threads\.net/, ... }
  };

  // 偵測當前平台
  function detectPlatform() {
    for (const [name, config] of Object.entries(platforms)) {
      if (config.match.test(window.location.hostname)) return { name, config };
    }
    return null;
  }

  const currentPlatform = detectPlatform();
  if (!currentPlatform) return; // 不在支援的網站上

  // ─── fb_dtsg 管理 ──────────────────────────────────────
  let cachedDtsg = null;
  let dtsgTimestamp = 0;
  const DTSG_TTL = 30 * 60 * 1000; // 30 分鐘快取

  function isDtsgValid() {
    return cachedDtsg && (Date.now() - dtsgTimestamp < DTSG_TTL);
  }

  /**
   * 同步 fb_dtsg 到 chrome.storage（供 background 背景執行用）
   */
  function syncDtsgToStorage(token) {
    if (token && chrome.storage?.local) {
      chrome.storage.local.set({ fb_dtsg: token, fb_dtsg_ts: Date.now() });
    }
  }

  /**
   * 取得 fb_dtsg（從快取或向 injected.js 請求）
   * @returns {Promise<string|null>}
   */
  function getDtsg() {
    if (isDtsgValid()) return Promise.resolve(cachedDtsg);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(null);
      }, 5000);

      function handler(event) {
        if (event.source !== window) return;
        if (!event.data || event.data.channel !== CHANNEL) return;
        if (event.data.type === 'DTSG_RESPONSE') {
          clearTimeout(timeout);
          window.removeEventListener('message', handler);
          cachedDtsg = event.data.payload.token;
          dtsgTimestamp = Date.now();
          syncDtsgToStorage(cachedDtsg);
          resolve(cachedDtsg);
        }
      }

      window.addEventListener('message', handler);
      window.postMessage({ channel: CHANNEL, type: 'REQUEST_DTSG' }, '*');
    });
  }

  // 監聽 injected.js 的訊息（dtsg + RPC API 呼叫）
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.channel !== CHANNEL) return;

    if (event.data.type === 'INJECTED_READY') {
      getDtsg();
      return;
    }

    // Phase 3 RPC：main world 透過 injected.js 呼叫 content script
    if (event.data.type === 'API_CALL') {
      const { id, action, options } = event.data;
      handleAction({ action, options })
        .then(result => {
          window.postMessage({
            channel: CHANNEL,
            type: 'API_RESPONSE',
            id,
            result
          }, '*');
        })
        .catch(err => {
          window.postMessage({
            channel: CHANNEL,
            type: 'API_RESPONSE',
            id,
            error: err.message || 'Unknown error'
          }, '*');
        });
    }
  });

  // ─── 注入 injected.js 到 MAIN world ───────────────────
  function injectMainWorldScript() {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('injected.js');
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  }
  injectMainWorldScript();

  // ─── Pipeline Stubs（Phase 2 實作）─────────────────────

  // ─── 工具函式 ──────────────────────────────────────────

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─── 請求類型加權表（Phase 7a — 研究依據：kevinzg #409 協作者確認不同類型有不同配額）──
  const REQUEST_WEIGHTS = {
    postsScan: 1,    // 貼文掃描（最輕）
    engagement: 2,   // 互動數補查（中等）
    comments: 3,     // 留言抓取（較重）
    replies: 4,      // 回覆遞迴（最重）
  };

  /**
   * 帶 Gamma 分布的隨機延遲（Phase 7a — 模擬人類瀏覽行為）
   * Gamma(shape=2, scale=baseMs/2) 產生多數偏短、偶爾較長的自然間隔
   * @param {number} baseMs - 基礎延遲（期望值 = shape × scale = baseMs）
   * @returns {Promise<void>}
   */
  function randomSleep(baseMs) {
    // Gamma(2, baseMs/2) = sum of 2 exponential(baseMs/2)
    // = -scale * ln(U1 * U2)，期望值 = baseMs
    const scale = baseMs / 2;
    const sample = -scale * Math.log(Math.random() * Math.random() || 1e-10);
    const minVal = currentPlatform.config.minDelays.commentFetch || 500;
    const maxVal = baseMs * 4;
    const actual = Math.max(minVal, Math.min(maxVal, Math.round(sample)));
    return sleep(actual);
  }

  // ─── Micro-pause 自然停頓（Phase 7a — 模擬用戶停下來「讀內容」）──
  let _requestsSinceLastPause = 0;
  let _nextPauseAt = Math.floor(Math.random() * 11) + 5; // 5-15 之間

  async function maybeInsertMicroPause() {
    _requestsSinceLastPause++;
    if (_requestsSinceLastPause >= _nextPauseAt) {
      const pauseMs = Math.floor(Math.random() * 22000) + 8000; // 8-30 秒
      console.log(`[FB Catch] 📖 自然停頓 ${(pauseMs / 1000).toFixed(1)}s（模擬閱讀）`);
      if (_activeScanLogger) _activeScanLogger.emit('PAUSE', { pauseMs, requestsSinceLast: _requestsSinceLastPause });
      await sleep(pauseMs);
      _requestsSinceLastPause = 0;
      _nextPauseAt = Math.floor(Math.random() * 11) + 5;
    }
  }

  // ─── Per-session 加權預算計數器（Phase 7a — 替代固定 40 硬上限）──
  const requestCounter = {
    weightedPoints: 0,
    rawCount: 0,
    budget: 200,
    _onLimitCallbacks: [],

    /**
     * 加權遞增
     * @param {string} type - 請求類型（postsScan/engagement/comments/replies）
     */
    increment(type = 'comments') {
      const weight = REQUEST_WEIGHTS[type] || 3;
      this.weightedPoints += weight;
      this.rawCount++;
      console.log(`[FB Catch] 📊 請求 #${this.rawCount} (${type} +${weight}) → ${this.weightedPoints}/${this.budget} 點`);

      if (this.weightedPoints >= this.budget) {
        console.warn(`[FB Catch] ⚠️ 已達 ${this.budget} 點預算上限。`);
        this._onLimitCallbacks.forEach(cb => cb(this.weightedPoints));
      }
    },

    isAtLimit() { return this.weightedPoints >= this.budget; },

    /**
     * 預算警告等級
     * @returns {'none'|'yellow'|'orange'}
     */
    getWarningLevel() {
      const pct = this.weightedPoints / this.budget;
      if (pct >= 1.0) return 'orange';
      if (pct >= 0.8) return 'yellow';
      return 'none';
    },

    reset() {
      this.weightedPoints = 0;
      this.rawCount = 0;
      _requestsSinceLastPause = 0;
    },

    getCount() { return this.rawCount; },
    getPoints() { return this.weightedPoints; },
    onLimit(cb) { this._onLimitCallbacks.push(cb); },

    /**
     * 檢查是否可以繼續請求
     * - 達上限時：不硬停，改為自動加大間隔（軟預算）
     * - 真正的煞車是 detectRateLimit（軟封鎖偵測）
     */
    check() {
      if (this.isAtLimit()) {
        console.warn(`[FB Catch] ⚠️ 超出 ${this.budget} 點預算，間隔自動 ×2。軟封鎖偵測仍為主要煞車。`);
      }
    }
  };

  // ─── Phase 8d-β：ScanRateLimiter（Token Bucket + AutoThrottle）──
  const scanRateLimiter = {
    // Token Bucket
    tokens: 8,
    capacity: 8,
    refillRate: 3,        // 每分鐘補充 3 token
    lastRefill: Date.now(),

    // AutoThrottle 動態延遲
    baseDelayMin: 3000,   // 正常最低 3s
    baseDelayMax: 8000,   // 正常最高 8s
    currentDelay: 5000,   // 當前基線（會被 AutoThrottle 調整）
    delayCap: 30000,      // 延遲上限 30s

    // 來源切換延遲
    switchDelayMin: 5000,
    switchDelayMax: 15000,

    // 指數退避（空回應用）
    backoffLevel: 0,
    backoffBase: 15000,   // 15s → 30s → 60s
    backoffCap: 60000,

    _refillTokens() {
      const now = Date.now();
      const elapsed = (now - this.lastRefill) / 60000; // 分鐘
      const refill = Math.floor(elapsed * this.refillRate);
      if (refill > 0) {
        this.tokens = Math.min(this.capacity, this.tokens + refill);
        this.lastRefill = now;
      }
    },

    /** 取得下一次請求的延遲（毫秒），含 Gamma 隨機化 */
    async acquire() {
      this._refillTokens();
      if (this.tokens > 0) {
        this.tokens--;
      } else {
        // 無 token → 等到下次補充
        const waitMs = (60000 / this.refillRate) + 1000;
        console.log(`[FB Catch] 🪣 Token 耗盡，等待 ${(waitMs / 1000).toFixed(1)}s 補充`);
        await sleep(waitMs);
        this._refillTokens();
        if (this.tokens > 0) this.tokens--;
      }
      // Gamma 隨機化（多數偏短、偶爾較長）
      const scale = this.currentDelay / 2;
      const sample = -scale * Math.log(Math.random() * Math.random() || 1e-10);
      const actual = Math.max(this.baseDelayMin, Math.min(this.currentDelay * 2, Math.round(sample)));
      await sleep(actual);
    },

    /** 來源切換時的較長隨機延遲 */
    async switchDelay() {
      const ms = this.switchDelayMin + Math.random() * (this.switchDelayMax - this.switchDelayMin);
      console.log(`[FB Catch] 🔀 來源切換延遲 ${(ms / 1000).toFixed(1)}s`);
      await sleep(Math.round(ms));
    },

    /** 回應回饋 — AutoThrottle 核心 */
    onResponse(latencyMs, isEmpty) {
      if (isEmpty) {
        // 空回應 → 指數退避
        this.backoffLevel = Math.min(this.backoffLevel + 1, 3);
        const backoff = Math.min(this.backoffBase * Math.pow(2, this.backoffLevel - 1), this.backoffCap);
        console.log(`[FB Catch] 📈 空回應退避 L${this.backoffLevel}：${(backoff / 1000).toFixed(0)}s`);
        if (_activeScanLogger) _activeScanLogger.emit('REQUEST_END', { latencyMs, isEmpty: true, backoffMs: backoff, tokensRemaining: this.tokens });
        return backoff;
      }
      // 有資料 → 重設退避
      this.backoffLevel = 0;
      const oldDelay = this.currentDelay;
      // AutoThrottle：回應慢 → 加大延遲，回應正常 → 緩慢恢復
      if (latencyMs > 3000) {
        this.currentDelay = Math.min(this.currentDelay * 1.5, this.delayCap);
        console.log(`[FB Catch] 🐢 回應慢 (${latencyMs}ms)，延遲調升至 ${(this.currentDelay / 1000).toFixed(1)}s`);
        if (_activeScanLogger) _activeScanLogger.emit('THROTTLE_CHANGE', { direction: 'up', oldDelay, newDelay: this.currentDelay });
      } else if (this.currentDelay > this.baseDelayMax) {
        this.currentDelay = Math.max(this.currentDelay * 0.9, this.baseDelayMax);
        console.log(`[FB Catch] 🐇 回應正常，延遲回降至 ${(this.currentDelay / 1000).toFixed(1)}s`);
        if (_activeScanLogger) _activeScanLogger.emit('THROTTLE_CHANGE', { direction: 'down', oldDelay, newDelay: this.currentDelay });
      }
      if (_activeScanLogger) _activeScanLogger.emit('REQUEST_END', { latencyMs, isEmpty: false, backoffMs: 0, tokensRemaining: this.tokens });
      return 0;
    },

    /** 重設狀態（新掃描開始時） */
    reset() {
      this.tokens = this.capacity;
      this.lastRefill = Date.now();
      this.currentDelay = 5000;
      this.backoffLevel = 0;
    }
  };

  // ─── 軟封鎖偵測（Phase 7a — 三路研究交叉確認的偵測模式）──
  let _consecutiveEmptyResults = 0; // Shadow Throttle 偵測用

  /**
   * Rate limit 偵測（Phase 7a 強化版）
   * 偵測優先序：致命 → 嚴重 → 中度 → 輕度
   * @param {Response} resp - fetch response
   * @param {string} text - response text
   * @returns {{isLimited: boolean, reason: string, severity: 'fatal'|'severe'|'moderate'|'none'}}
   */
  function detectRateLimit(resp, text) {
    // ── 致命：帳號被封或需驗證 → 立即停止 session ──
    if (text && (text.includes('temporarily blocked') || text.includes("can't use this feature"))) {
      return { isLimited: true, reason: 'text_blocked', severity: 'fatal' };
    }
    if (text && text.includes('checkpoint') && text.includes('verify')) {
      return { isLimited: true, reason: 'checkpoint', severity: 'fatal' };
    }
    if (resp.status === 401 || resp.status === 403 ||
        (text && (text.includes('"errorSummary"') || text.includes('LoginRequired')))) {
      return { isLimited: true, reason: 'auth_expired', severity: 'fatal' };
    }

    // ── 嚴重：明確限速回應 → 長冷卻 ──
    if (resp.status === 429) {
      return { isLimited: true, reason: 'http_429', severity: 'severe' };
    }

    // ── 中度：空回傳 / data_null（FB 軟封鎖常見表現）→ 長冷卻 ──
    if (!text || text.trim() === '' || text.trim() === '{}') {
      return { isLimited: true, reason: 'empty_response', severity: 'moderate' };
    }
    // data_null 偵測（文獻未明確記錄，保守處理）
    try {
      const firstLine = text.split('\n').find(l => l.trim());
      if (firstLine) {
        const parsed = JSON.parse(firstLine);
        if (parsed.data === null || (parsed.data && typeof parsed.data === 'object' && Object.keys(parsed.data).length === 0 && !parsed.label)) {
          return { isLimited: true, reason: 'data_null', severity: 'moderate' };
        }
      }
    } catch (_) { /* 非 JSON，繼續正常流程 */ }

    // ── 正常 → 重置連續空結果計數器 ──
    _consecutiveEmptyResults = 0;
    return { isLimited: false, reason: '', severity: 'none' };
  }

  /**
   * 冷卻等待（Phase 7a — 依嚴重度分級）
   * @param {number} attempt - 第幾次重試（0-based）
   * @param {string} reason - 限速原因
   * @param {'fatal'|'severe'|'moderate'} severity - 嚴重度
   */
  async function rateLimitBackoff(attempt, reason, severity = 'moderate') {
    // 致命：不等待，直接拋錯停止 session
    if (severity === 'fatal') {
      if (_activeScanLogger) _activeScanLogger.emit('RATE_LIMIT', { reason, severity, attempt, waitMs: 0 });
      throw new Error(`Facebook 封鎖偵測 (${reason})。請等待 24 小時後再試。`);
    }

    // 嚴重（HTTP 429）：固定 15 分鐘
    if (severity === 'severe') {
      const delay = 15 * 60 * 1000;
      console.warn(`[FB Catch] 🛑 嚴重限速 (${reason})，等待 15 分鐘...`);
      if (_activeScanLogger) _activeScanLogger.emit('RATE_LIMIT', { reason, severity, attempt, waitMs: delay });
      await sleep(delay);
      return;
    }

    // 中度（empty_response / data_null）：固定 10 分鐘
    const delay = 10 * 60 * 1000;
    console.warn(`[FB Catch] ⏸️ 軟封鎖 (${reason})，等待 10 分鐘... (attempt ${attempt + 1})`);
    if (_activeScanLogger) _activeScanLogger.emit('RATE_LIMIT', { reason, severity, attempt, waitMs: delay });
    await sleep(delay);
  }

  /**
   * 安全取得延遲值（不低於下限）
   * @param {string} key
   * @param {number} [override]
   * @returns {number}
   */
  function getDelay(key, override) {
    const min = currentPlatform.config.minDelays[key] || 1000;
    const def = currentPlatform.config.delays[key] || 2000;
    const val = override || def;
    return Math.max(val, min);
  }

  // ─── Posts Pipeline（Phase 2a）─────────────────────────

  // ─── 貼文容器識別（路線 B：aria-label 反推）────────────

  // 多語系 action 按鈕 pattern（FB 的三點選單）
  const ACTION_LABEL_PATTERN = /動作|Actions for this post|actions? for this/i;
  // 時間文字 pattern
  const TIME_TEXT_PATTERN = /^\d+\s*(秒|分鐘|小時|天|週|月|年|s|m|h|d|w|hr|min|hour|day|week|month|year)s?\s*(前|ago)?$|^(昨天|前天|Yesterday|Just now|剛剛)$|^\d{1,2}月\s*\d{1,2}日$|^\d{1,2}\/\d{1,2}$/i;

  /**
   * 廣告/贊助貼文偵測
   */
  function isSponsored(el) {
    // 注意：[data-ad-comet-preview] 不可靠（一般貼文也有），已移除
    return !!(
      el.querySelector('[aria-label*="Sponsored" i], [aria-label*="贊助"]') ||
      el.querySelector('a[href*="/ads/about"]')
    );
  }

  /**
   * 找到所有貼文的 action 按鈕 → 反推貼文容器
   * @returns {Array<{container: Element, actionBtn: Element}>}
   */
  function findPostContainers() {
    const actionBtns = document.querySelectorAll('[aria-label]');
    const results = [];
    const seenContainers = new Set();

    for (const btn of actionBtns) {
      const label = btn.getAttribute('aria-label') || '';
      if (!ACTION_LABEL_PATTERN.test(label)) continue;

      // 向上爬找貼文容器：最近（最小）的 actionCount===1 祖先（至少 5 層以上）
      // 不用 getBoundingClientRect（FB 虛擬化渲染讓隱藏貼文尺寸 = 0）
      // 取最近而非最遠，避免不同貼文映射到同一大容器被去重
      let el = btn;
      let bestContainer = null;
      for (let i = 0; i < 20; i++) {
        el = el.parentElement;
        if (!el || el === document.body || el === document.documentElement) break;
        if (i < 5) continue; // 前 5 層太小，跳過
        let actionCount = 0;
        for (const a of el.querySelectorAll('[aria-label]')) {
          if (ACTION_LABEL_PATTERN.test(a.getAttribute('aria-label') || '')) actionCount++;
        }
        if (actionCount === 1) { bestContainer = el; break; } // 取最近的，不再往上
      }

      if (bestContainer && !seenContainers.has(bestContainer)) {
        // Bug 2: 過濾廣告/贊助貼文
        if (isSponsored(bestContainer)) continue;
        seenContainers.add(bestContainer);
        results.push({ container: bestContainer, actionBtn: btn });
      }
    }

    return results;
  }

  /** Posts pipeline — DOM 掃描貼文清單 */
  const postsPipeline = {
    /**
     * 掃描貼文直到達到目標數量或頁面底部
     * @param {object} options
     * @param {number} [options.targetCount=30] - 要抓幾篇貼文
     * @returns {Promise<{posts: Array, total: number}>}
     */
    async scan(options = {}) {
      const targetCount = options.targetCount || 30;
      const scrollDelay = getDelay('postScan');
      const seen = new Map(); // key → post object（去重）
      const MAX_STALE_ROUNDS = 5;

      function harvestPosts() {
        const before = seen.size;
        const containers = findPostContainers();

        for (const { container } of containers) {
          const post = extractPostData(container);
          if (!post) continue;
          // Bug 3: 丟棄空白條目（id + permalink + text 都空 = 非貼文）
          if (!post.id && !post.permalink && !post.text) continue;
          const key = post.permalink || post.id || `container_${seen.size}`;
          if (!seen.has(key)) seen.set(key, post);
        }

        return seen.size - before;
      }

      // 首次掃描
      harvestPosts();

      // 持續捲動直到達標或到底
      let staleRounds = 0;
      while (seen.size < targetCount && staleRounds < MAX_STALE_ROUNDS) {
        window.scrollBy(0, window.innerHeight * 2);
        await randomSleep(scrollDelay);
        const newCount = harvestPosts();
        staleRounds = newCount === 0 ? staleRounds + 1 : 0;
      }

      window.scrollTo(0, 0);

      const posts = Array.from(seen.values()).slice(0, targetCount);
      const hitBottom = staleRounds >= MAX_STALE_ROUNDS;
      return {
        posts,
        total: posts.length,
        hitBottom,
        message: hitBottom && posts.length < targetCount
          ? `Reached page bottom. Found ${posts.length} / ${targetCount} requested.`
          : null
      };
    },

    async download(posts, format = 'json') {
      await exportData(posts, format, 'fb_posts');
    },

    /**
     * 路線 A：GraphQL 貼文掃描（比 DOM 穩定，不受 CSS class 輪換影響）
     * @param {object} options
     * @param {string} options.userId - 目標用戶 numeric ID
     * @param {number} [options.count=10] - 每頁筆數
     * @returns {Promise<{posts: Array, total: number}>}
     */
    async scanGraphQL(options = {}) {
      // 自動偵測 ID 與 feed context（Groups / Profile / Page）
      let targetId = options.userId;
      let feedContext = options.feedContext || 'timeline'; // 預設：個人頁 / 粉專（Phase 8b 面板可傳入）

      // 偵測 Groups URL
      const groupsMatch = window.location.pathname.match(/^\/groups\/([^/?]+)/);
      if (groupsMatch && !targetId) {
        feedContext = 'group';
        const html = document.documentElement.innerHTML;
        // Groups 的 numeric ID 在 HTML 的 "group_id":"xxx"
        const gidMatch = html.match(/"group_id":"(\d+)"/);
        if (gidMatch) {
          targetId = gidMatch[1];
        } else {
          // fallback: URL 裡的可能是 numeric ID
          const urlGid = groupsMatch[1];
          if (/^\d+$/.test(urlGid)) targetId = urlGid;
        }
      }

      if (!targetId) {
        // 方法 0: profile.php?id=xxx（URL 直接取，最可靠）
        const urlParams = new URLSearchParams(window.location.search);
        const profileId = urlParams.get('id');
        if (window.location.pathname === '/profile.php' && profileId && /^\d+$/.test(profileId)) {
          targetId = profileId;
        }
      }
      if (!targetId) {
        const html = document.documentElement.innerHTML;
        // 方法 1: "userID":"xxx"
        const uidMatch = html.match(/"userID":"(\d+)"/);
        if (uidMatch) targetId = uidMatch[1];
        // 方法 2: "profile_owner":{"id":"xxx"}
        if (!targetId) {
          const ownerMatch = html.match(/"profile_owner":\s*\{[^}]*"id":"(\d+)"/);
          if (ownerMatch) targetId = ownerMatch[1];
        }
        // 方法 3: entity_id in URL params
        if (!targetId) {
          const urlMatch = html.match(/"entity_id":"(\d+)"/);
          if (urlMatch) targetId = urlMatch[1];
        }
      }
      if (!targetId) {
        return { posts: [], error: 'Cannot detect userId/groupId. Provide it manually or navigate to a profile/page/group.' };
      }

      const targetCount = options.targetCount || options.count || 10;
      const count = Math.min(targetCount, 10); // FB 每頁實際回 ~3 篇（Relay streaming），不需要要太多
      // 自動計算需要幾頁（每頁約 3 篇，多抓 2 頁作為安全餘量）
      const afterTime = options.afterTime || null;
      const beforeTime = options.beforeTime || null;
      const scrollDelay = getDelay('postScan');
      const allPosts = [];
      let cursor = null;
      let pages = 0;

      do {
        const data = await fetchPosts(targetId, cursor, count, afterTime, beforeTime, feedContext);
        const { posts, pageInfo } = parsePostsResponse(data);
        allPosts.push(...posts);
        pages++;

        // Phase 8b: 進度回調（面板用）
        if (options.onProgress) options.onProgress({ scanned: allPosts.length, target: targetCount, pages });

        // 已達目標數量，提早結束
        if (allPosts.length >= targetCount) {
          cursor = null;
          break;
        }

        if (pageInfo?.has_next_page && pageInfo.end_cursor) {
          cursor = pageInfo.end_cursor;
          await randomSleep(scrollDelay);
        } else {
          cursor = null;
        }
      } while (cursor);

      // Phase 6c: Groups client-side 日期過濾（Groups doc_id 不支援 server-side afterTime/beforeTime）
      let dateFiltered = 0;
      let filtered = allPosts;
      if ((afterTime || beforeTime) && feedContext === 'group') {
        filtered = allPosts.filter(p => {
          if (!p.timestamp) return true; // 無時間戳的保留
          const ts = Math.floor(new Date(p.timestamp).getTime() / 1000);
          if (afterTime && ts < afterTime) return false;
          if (beforeTime && ts > beforeTime) return false;
          return true;
        });
        dateFiltered = allPosts.length - filtered.length;
      }

      const trimmed = filtered.slice(0, targetCount);

      // Phase 6a: 粉專互動數補查（engagement 全 0 的貼文逐篇查詢）
      const enrichCount = await enrichPostsEngagement(trimmed);

      return {
        posts: trimmed,
        total: trimmed.length,
        pages,
        method: 'graphql',
        enriched: enrichCount,
        dateFiltered
      };
    }
  };

  /**
   * 從貼文容器提取資料
   * @param {Element} container - 由 findPostContainers 找到的貼文 DOM
   * @returns {object|null}
   */
  function extractPostData(container) {
    try {
      // ── 作者 ──
      const authorEl = container.querySelector('h2 a, h3 a, h4 a')
        || container.querySelector('strong a');
      const authorName = authorEl?.textContent?.trim() || '';
      const authorUrl = authorEl ? cleanPermalink(authorEl.href) : '';

      // ── Permalink ──
      // 找含有 /posts/ 或 pfbid 或 /photo 的連結
      const allLinks = container.querySelectorAll('a[href*="facebook.com"]');
      let permalink = '';
      let timeLink = null;

      for (const link of allLinks) {
        const href = link.href;
        // 貼文 permalink
        if (!permalink && (href.includes('/posts/') || href.includes('pfbid') || href.includes('story_fbid'))) {
          permalink = href;
        }
        // photo/video permalink（備用）
        if (!permalink && (href.includes('/photo') || href.includes('/videos/') || href.includes('/reel/'))) {
          permalink = href;
        }
        // 時間連結
        const linkText = link.textContent?.trim() || '';
        if (!timeLink && TIME_TEXT_PATTERN.test(linkText)) {
          timeLink = link;
        }
      }

      // ── 時間 ──
      const timestamp = timeLink?.textContent?.trim() || '';

      // ── 內文 ──
      // 策略：找 action 按鈕之前的 dir="auto" 文字區塊（排除留言區的）
      const actionBtn = container.querySelector('[aria-label]');
      let text = '';
      const dirAutoDivs = container.querySelectorAll('div[dir="auto"]');
      for (const div of dirAutoDivs) {
        const t = div.textContent?.trim() || '';
        // 跳過太短（可能是按鈕標籤）或等於作者名的
        if (t.length < 2 || t === authorName || t === 'Facebook') continue;
        // 跳過在留言區（role="article" 內）的文字
        if (div.closest('[role="article"]')) continue;
        // 取最長的那段作為內文
        if (t.length > text.length) text = t;
      }

      // ── 互動數 ──
      const reactions = extractReactionCount(container);
      const commentCount = extractCountByLabel(container, /則留言|comments?/i);
      const shareCount = extractCountByLabel(container, /次分享|shares?/i);

      // ── 媒體 ──
      const hasImage = !!container.querySelector('img[src*="scontent"]');
      const hasVideo = !!container.querySelector('video, [aria-label*="video" i]');
      const mediaType = hasVideo ? 'video' : hasImage ? 'image' : 'text';

      // ── ID ──
      const postId = permalink ? extractPostId(permalink) : '';
      const cleanLink = permalink ? cleanPermalink(permalink) : '';

      return {
        id: postId,
        permalink: cleanLink,
        author: { name: authorName, url: authorUrl },
        text: text.slice(0, 500),
        timestamp,
        reactions,
        commentCount,
        shareCount,
        mediaType,
        scrapedAt: new Date().toISOString()
      };
    } catch (_) {
      return null;
    }
  }

  /**
   * 從 permalink 提取貼文 ID
   */
  function extractPostId(url) {
    try {
      const u = new URL(url);
      const postsMatch = u.pathname.match(/\/posts\/(\d+)/);
      if (postsMatch) return postsMatch[1];
      const storyId = u.searchParams.get('story_fbid');
      if (storyId) return storyId;
      const fbidParam = u.searchParams.get('fbid');
      if (fbidParam) return fbidParam;
      const mediaMatch = u.pathname.match(/\/(photos|videos|reel)\/[^/]*\/(\d+)/);
      if (mediaMatch) return mediaMatch[2];
      const pfbidMatch = u.pathname.match(/(pfbid\w+)/);
      if (pfbidMatch) return pfbidMatch[1];
    } catch (_) { /* 無法解析 */ }
    return '';
  }

  /**
   * 清理 permalink（移除追蹤參數）
   */
  function cleanPermalink(url) {
    try {
      const u = new URL(url);
      const keepParams = ['story_fbid', 'id', 'set', 'fbid'];
      const cleanParams = new URLSearchParams();
      for (const key of keepParams) {
        if (u.searchParams.has(key)) cleanParams.set(key, u.searchParams.get(key));
      }
      u.search = cleanParams.toString() ? '?' + cleanParams.toString() : '';
      u.hash = '';
      return u.toString();
    } catch (_) {
      return url;
    }
  }

  /**
   * 提取按讚/反應數（總數，非 emoji 種類數）
   */
  function extractReactionCount(container) {
    // 優先：aria-label 含完整總數（如「所有心情：3,348」「3.3K reactions」）
    const reactionEl = container.querySelector(
      '[aria-label*="心情"], [aria-label*="reaction" i], [aria-label*="like" i][aria-label*="and"]'
    );
    if (reactionEl) {
      const label = reactionEl.getAttribute('aria-label') || '';
      const num = parseCountText(label);
      if (num > 0) return num;
    }

    // 備用：span 文字（「所有心情：3,348」有時也直接在文字中）
    const spans = container.querySelectorAll('span');
    for (const span of spans) {
      const text = span.textContent?.trim() || '';
      if (/所有心情|All reactions/.test(text)) {
        const num = parseCountText(text);
        if (num > 0) return num;
      }
    }

    // 再備用：找純數字的 span（在 reaction bar 附近）
    for (const span of spans) {
      const text = span.textContent?.trim() || '';
      if (/^[\d,.\s]+[KkMm萬]?$/.test(text) && text.length < 15) {
        // 確認是 reaction 區域（附近有 emoji 圖示）
        const parent = span.closest('div');
        if (parent && parent.querySelector('img[src*="emoji"], img[alt]')) {
          const num = parseCountText(text);
          if (num > 0) return num;
        }
      }
    }
    return 0;
  }

  /**
   * 從文字標籤提取數字（如「98則留言」→ 98）
   */
  function extractCountByLabel(container, pattern) {
    const spans = container.querySelectorAll('span');
    for (const span of spans) {
      const text = span.textContent?.trim() || '';
      if (pattern.test(text)) {
        const num = parseCountText(text);
        if (num > 0) return num;
      }
    }
    return 0;
  }

  /**
   * 解析數字文字（支援「1.2K」「3萬」「3,348」等格式）
   */
  function parseCountText(text) {
    if (!text) return 0;
    const plain = text.replace(/[,，]/g, '').match(/([\d.]+)/);
    if (plain) {
      const n = parseFloat(plain[1]);
      if (/[kK千]/.test(text)) return Math.round(n * 1000);
      if (/[mM]/.test(text) && !/min/i.test(text)) return Math.round(n * 1000000);
      if (/萬/.test(text)) return Math.round(n * 10000);
      return Math.round(n);
    }
    return 0;
  }

  // ─── Posts GraphQL（Phase 2 #4 — 路線 A）────────────────

  const POSTS_DOC_ID = '27826317400295089';
  const GROUPS_DOC_ID = '27152044451084198';

  /**
   * GraphQL 貼文清單查詢（支援 Timeline / Groups）
   * @param {string} targetId - 用戶或社團 numeric ID
   * @param {string|null} cursor - 分頁 cursor
   * @param {number} count - 每頁筆數
   * @param {number|null} afterTime - 時間篩選（秒）
   * @param {number|null} beforeTime - 時間篩選（秒）
   * @param {string} feedContext - 'timeline' | 'group'
   * @returns {Promise<object>}
   */
  async function fetchPosts(targetId, cursor = null, count = 10, afterTime = null, beforeTime = null, feedContext = 'timeline') {
    const dtsg = await getDtsg();
    if (!dtsg) throw new Error('fb_dtsg not available. Please refresh the page.');

    const isGroup = feedContext === 'group';

    const variables = isGroup ? {
      count,
      cursor,
      feedLocation: 'GROUP',
      feedType: 'DISCUSSION',
      feedbackSource: 0,
      filterTopicId: null,
      focusCommentID: null,
      privacySelectorRenderLocation: 'COMET_STREAM',
      referringStoryRenderLocation: null,
      renderLocation: 'group',
      scale: 1,
      sortingSetting: 'CHRONOLOGICAL',
      stream_count: 1,
      useDefaultActor: false,
      id: targetId
    } : {
      afterTime: afterTime || null,
      beforeTime: beforeTime || null,
      count,
      cursor,
      feedLocation: 'TIMELINE',
      feedbackSource: 0,
      focusCommentID: null,
      memorializedSplitTimeFilter: null,
      omitPinnedPost: true,
      postedBy: null,
      privacy: null,
      privacySelectorRenderLocation: 'COMET_STREAM',
      referringStoryRenderLocation: null,
      renderLocation: 'timeline',
      scale: 1,
      stream_count: 1,
      taggedInOnly: null,
      useDefaultActor: false,
      id: targetId
    };

    const body = new URLSearchParams({
      fb_dtsg: dtsg,
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: isGroup ? 'GroupsCometFeedRegularStoriesPaginationQuery' : 'ProfileCometTimelineFeedRefetchQuery',
      variables: JSON.stringify(variables),
      server_timestamps: 'true',
      doc_id: isGroup ? GROUPS_DOC_ID : POSTS_DOC_ID
    });

    // Rate limit retry loop（最多 3 次）
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      requestCounter.check();
      await maybeInsertMicroPause();
      requestCounter.increment('postsScan');

      const resp = await fetch('https://www.facebook.com/api/graphql/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        credentials: 'include'
      });

      if (!resp.ok && resp.status !== 429) {
        throw new Error(`GraphQL posts request failed: ${resp.status}`);
      }

      const text = await resp.text();
      const rateCheck = detectRateLimit(resp, text);
      if (rateCheck.isLimited) {
        if (attempt < MAX_RETRIES - 1) {
          await rateLimitBackoff(attempt, rateCheck.reason, rateCheck.severity);
          continue;
        }
        throw new Error(`被 Facebook 限速 (${rateCheck.reason})，請等待後再試。`);
      }

      // FB 用 Relay Streaming NDJSON：第 1 行有初始資料，
      // 後面 $stream$ 行各帶 1 篇追加貼文，需合併
      const lines = text.split('\n').filter(l => l.trim());
      let baseData = null;
      const streamEdges = [];

      let deferredPageInfo = null;

      for (const line of lines) {
        try {
          const json = JSON.parse(line);
          if ((json.data?.node?.timeline_list_feed_units || json.data?.node?.timeline_feed_units || json.data?.node?.group_feed) && !baseData) {
            // 初始資料（含第一篇貼文；Groups 用 group_feed）
            baseData = json;
          } else if (json.label?.includes('$stream$') && json.data?.node) {
            // Streaming 追加的貼文
            streamEdges.push({ node: json.data.node, cursor: json.data.cursor });
          } else if (json.label?.includes('$defer$') && json.label?.includes('page_info')) {
            // Deferred page_info（FB 把分頁資訊延遲回傳）
            const piStr = JSON.stringify(json.data);
            const piMatch = piStr.match(/"has_next_page":\s*(true|false)/);
            const cursorMatch = piStr.match(/"end_cursor":\s*"([^"]+)"/);
            if (piMatch) {
              deferredPageInfo = {
                has_next_page: piMatch[1] === 'true',
                end_cursor: cursorMatch ? cursorMatch[1] : null
              };
            }
          }
        } catch (_) { /* 跳過非 JSON 行 */ }
      }

      if (!baseData) throw new Error('No valid data in GraphQL posts response');

      // 合併 stream edges 到 baseData（Groups 用 group_feed）
      const feed = baseData.data.node.timeline_list_feed_units || baseData.data.node.timeline_feed_units || baseData.data.node.group_feed;
      if (streamEdges.length > 0 && feed.edges) {
        feed.edges.push(...streamEdges);
      }

      // 用 deferred page_info 覆蓋（比初始的更準確）
      if (deferredPageInfo) {
        feed.page_info = deferredPageInfo;
      }

      return baseData;
    }
  }

  /**
   * 從 GraphQL response 提取貼文清單
   */
  function parsePostsResponse(data) {
    const posts = [];
    const feedUnits = data?.data?.node?.timeline_list_feed_units
      || data?.data?.node?.timeline_feed_units
      || data?.data?.node?.group_feed;
    if (!feedUnits) return { posts, pageInfo: null };

    const edges = feedUnits.edges || [];
    for (const edge of edges) {
      const story = edge?.node;
      if (!story || story.__typename !== 'Story') continue;

      const feedbackNode = story.feedback || {};
      const feedbackId = feedbackNode.id || ''; // Base64 encoded
      const owningProfile = feedbackNode.owning_profile || {};

      // 提取貼文文字（comet_sections.content.story.message.text）
      const message = story.comet_sections?.content?.story?.message
        || story.message || {};
      const text = message.text || '';

      // 提取 permalink
      const permalink = story.permalink_url
        || story.comet_sections?.context_layout?.story?.comet_sections?.metadata?.[0]?.story?.url
        || '';

      // 提取時間戳
      const createdTime = story.created_time || story.creation_time || 0;
      const timestamp = createdTime ? new Date(createdTime * 1000).toISOString() : '';

      // 提取 post ID — 多來源 fallback chain
      let postId = '';
      // 來源 1: feedbackNode.id decode Base64
      if (feedbackId) {
        try {
          const decoded = atob(feedbackId);
          if (decoded.startsWith('feedback:')) {
            postId = decoded.replace('feedback:', '');
          }
        } catch (_) { /* 非法 Base64 */ }
      }
      // 來源 2: story 自身的 numeric ID 欄位（FB GraphQL 常見）
      if (!postId) {
        postId = story.post_id
          || story.legacy_token
          || feedbackNode.legacy_token
          || '';
      }
      // 來源 3: story.id decode（relay ID 格式 "S:_Ixxxxxx:yyyyyyy" → yyyyyyy 是 post ID）
      if (!postId && story.id) {
        try {
          const decoded = atob(story.id);
          const relayMatch = decoded.match(/:(\d{10,})$/);
          if (relayMatch) postId = relayMatch[1];
        } catch (_) {}
      }
      // 來源 4: permalink 裡的 numeric ID（pfbid 不會匹配）
      if (!postId && permalink) {
        const pMatch = permalink.match(/\/posts\/(\d+)/);
        if (pMatch) postId = pMatch[1];
        // reel URL: /reel/xxxx/
        if (!postId) {
          const reelMatch = permalink.match(/\/reel\/(\d+)/);
          if (reelMatch) postId = reelMatch[1];
        }
      }
      // 確保 feedbackId 是 Comments query 需要的 btoa("feedback:postId") 格式
      const commentsFeedbackId = postId ? toFeedbackId(postId) : feedbackId;

      // 提取貼文附件（圖片/影片）
      const postAttachments = [];
      const storyAttachments = story.attachments || [];
      for (const att of storyAttachments) {
        // 收集所有媒體來源（單張 or 相簿 or 影片）
        const mediaSources = [];
        const attData = att.styles?.attachment || {};
        // 相簿：all_subattachments.nodes[]
        if (attData.all_subattachments?.nodes?.length) {
          for (const node of attData.all_subattachments.nodes) {
            if (node.media) mediaSources.push(node.media);
          }
        }
        // 單張/影片：attachment.media
        if (attData.media?.__typename) mediaSources.push(attData.media);
        // 頂層 stub fallback
        if (!mediaSources.length && att.media?.__typename) mediaSources.push(att.media);

        for (const media of mediaSources) {
          const typename = media.__typename || '';
          if (typename === 'Photo' || typename === 'Video') {
            // Phase 9: 優先取高解析度圖片（original > viewer > photo_image > image）
            const mediaUrl = typename === 'Photo'
              ? (media.original_image?.uri || media.viewer_image?.uri || media.photo_image?.uri || media.image?.uri || '')
              : (media.playable_url || media.permalink_url || media.first_frame_thumbnail || '');
            const thumbUrl = media.first_frame_thumbnail || media.image?.uri || '';
            if (mediaUrl || thumbUrl) {
              const mediaAtt = {
                type: typename.toLowerCase(),
                url: mediaUrl || thumbUrl,
                thumbnail: thumbUrl,
                width: media.original_width || media.width || 0,
                height: media.original_height || media.height || 0
              };
              if (typename === 'Video') mediaAtt.videoId = media.id || '';
              postAttachments.push(mediaAtt);
            }
          }
        }
      }

      // 提取互動數（Phase 3b #5）
      const reactionsCount = parseInt(feedbackNode.reactors?.count || feedbackNode.reaction_count?.count || '0', 10);
      const commentCount = parseInt(feedbackNode.comment_count?.total_count || feedbackNode.total_comment_count || '0', 10);
      const shareCount = parseInt(feedbackNode.share_count?.count || feedbackNode.reshares?.count || '0', 10);

      posts.push({
        id: postId,
        storyId: story.id || '',
        feedbackId: commentsFeedbackId || feedbackId,
        permalink,
        text: text.slice(0, 500),
        timestamp,
        author: {
          name: owningProfile.name || '',
          id: owningProfile.id || ''
        },
        reactions: reactionsCount,
        commentCount,
        shareCount,
        attachments: postAttachments.length > 0 ? postAttachments : undefined
      });
    }

    const pageInfo = feedUnits.page_info || null;
    return { posts, pageInfo };
  }

  // ─── Engagement Enrichment（Phase 6a — 粉專互動數補查）────────────

  /**
   * 輕量 feedback 查詢：用 Comments doc_id 但 commentsAfterCount=0，只拿互動數
   * @param {string} feedbackId - Base64 encoded feedback ID
   * @returns {Promise<{reactions: number, commentCount: number, shareCount: number}>}
   */
  async function fetchEngagement(feedbackId) {
    const dtsg = await getDtsg();
    if (!dtsg) return { reactions: 0, commentCount: 0, shareCount: 0 };

    const variables = {
      commentsAfterCount: 0,
      commentsAfterCursor: null,
      commentsBeforeCount: null,
      commentsBeforeCursor: null,
      commentsIntentToken: resolveIntentToken('all'),
      feedLocation: 'POST_PERMALINK_DIALOG',
      focusCommentID: null,
      scale: 1,
      useDefaultActor: false,
      id: feedbackId,
      __relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider: 'ORIGINAL',
      __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false,
      __relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider: false,
      __relay_internal__pv__IsWorkUserrelayprovider: false
    };

    const body = new URLSearchParams({
      fb_dtsg: dtsg,
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: 'CommentsListComponentsPaginationQuery',
      variables: JSON.stringify(variables),
      server_timestamps: 'true',
      doc_id: COMMENTS_DOC_ID
    });

    requestCounter.check();
    await maybeInsertMicroPause();
    requestCounter.increment('engagement');

    const resp = await fetch('https://www.facebook.com/api/graphql/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      credentials: 'include'
    });

    if (!resp.ok) return { reactions: 0, commentCount: 0, shareCount: 0 };

    const text = await resp.text();
    const rateCheck = detectRateLimit(resp, text);
    if (rateCheck.isLimited) return { reactions: 0, commentCount: 0, shareCount: 0 };

    // 從 response 解析 feedback 互動數
    const lines = text.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const json = JSON.parse(line);
        const node = json?.data?.node;
        if (!node) continue;
        // feedback 可能在 node 自身或 comment_rendering_instance 的 feedback
        const fb = node.feedback
          || node.comment_rendering_instance_for_feed_location?.feedback
          || node.comment_rendering_instance?.feedback
          || {};
        const reactions = parseInt(fb.reactors?.count || fb.reaction_count?.count || '0', 10);
        const commentCount = parseInt(fb.comment_count?.total_count || fb.total_comment_count || '0', 10);
        const shareCount = parseInt(fb.share_count?.count || fb.reshares?.count || '0', 10);
        if (reactions || commentCount || shareCount) {
          return { reactions, commentCount, shareCount };
        }
      } catch (_) { /* 跳過非 JSON 行 */ }
    }
    return { reactions: 0, commentCount: 0, shareCount: 0 };
  }

  /**
   * 批次補查互動數：對所有 engagement 全 0 的貼文逐篇查詢
   * @param {Array} posts - parsePostsResponse 回傳的貼文陣列
   * @param {function} [onProgress] - 進度回報 callback(current, total)
   * @returns {Promise<number>} 補查成功的貼文數
   */
  async function enrichPostsEngagement(posts, onProgress = null) {
    const needEnrich = posts.filter(p =>
      p.feedbackId && p.reactions === 0 && p.commentCount === 0 && p.shareCount === 0
    );
    if (needEnrich.length === 0) return 0;

    let enriched = 0;
    for (let i = 0; i < needEnrich.length; i++) {
      const post = needEnrich[i];
      try {
        const eng = await fetchEngagement(post.feedbackId);
        if (eng.reactions || eng.commentCount || eng.shareCount) {
          post.reactions = eng.reactions;
          post.commentCount = eng.commentCount;
          post.shareCount = eng.shareCount;
          enriched++;
        }
      } catch (_) { /* 單篇失敗不中斷 */ }
      if (onProgress) onProgress(i + 1, needEnrich.length);
      if (i < needEnrich.length - 1) await randomSleep(getDelay('commentFetch'));
    }
    return enriched;
  }

  // ─── Comments Pipeline（Phase 2b — GraphQL）────────────

  const COMMENTS_DOC_ID = '27806180149070312';
  const DEPTH1_REPLIES_DOC_ID = '27888228590762910';
  const DEPTH2_REPLIES_DOC_ID = '26487206987618724';

  /**
   * 將貼文 ID 轉為 feedbackID（Base64 編碼的 "feedback:{post_id}"）
   * FB 使用 Base64("feedback:{numeric_post_id}") 作為 GraphQL 的 id 參數
   */
  function toFeedbackId(postId) {
    // 如果已經是 Base64（含 = 且不含 /posts/），直接用
    if (/^[A-Za-z0-9+/]+=*$/.test(postId) && postId.length > 20) return postId;
    // 從 pfbid URL 不容易轉換，需要另一個查詢；先處理純數字 ID
    if (/^\d+$/.test(postId)) {
      return btoa(`feedback:${postId}`);
    }
    return null;
  }

  /**
   * 發送 GraphQL 留言查詢
   * @param {string} feedbackId - Base64 編碼的 feedback ID
   * @param {string|null} cursor - 分頁 cursor
   * @returns {Promise<object>} - 原始 GraphQL response
   */
  // ─── 排序模式 → Intent Token 對應表 ──────────────────
  const SORT_ORDER_TOKENS = {
    all: 'RANKED_UNFILTERED_CHRONOLOGICAL_REPLIES_INTENT_V1',
    relevant: null,
    newest: 'REVERSE_CHRONOLOGICAL_UNFILTERED_INTENT_V1'
  };

  function resolveIntentToken(sortOrder) {
    return SORT_ORDER_TOKENS[sortOrder] ?? SORT_ORDER_TOKENS.all;
  }

  async function fetchComments(feedbackId, cursor = null, requestType = 'comments', expansionToken = null, sortOrder = 'all') {
    const dtsg = await getDtsg();
    if (!dtsg) throw new Error('fb_dtsg not available. Please refresh the page.');

    // replies/depth2 用含 expansionToken + repliesAfter/Before 的 variables
    const isReply = requestType === 'replies' || requestType === 'depth2';
    const intentToken = resolveIntentToken(sortOrder);
    const variables = isReply ? {
      clientKey: null,
      expansionToken: expansionToken,
      feedLocation: 'POST_PERMALINK_DIALOG',
      focusCommentID: null,
      repliesAfterCount: null,
      repliesAfterCursor: cursor,
      repliesBeforeCount: null,
      repliesBeforeCursor: null,
      scale: 1,
      useDefaultActor: false,
      id: feedbackId,
      __relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider: 'ORIGINAL',
      __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false,
      __relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider: false,
      __relay_internal__pv__IsWorkUserrelayprovider: false
    } : {
      commentsAfterCount: -1,
      commentsAfterCursor: cursor,
      commentsBeforeCount: null,
      commentsBeforeCursor: null,
      commentsIntentToken: intentToken,
      feedLocation: 'POST_PERMALINK_DIALOG',
      focusCommentID: null,
      scale: 1,
      useDefaultActor: false,
      id: feedbackId,
      __relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider: 'ORIGINAL',
      __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false,
      __relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider: false,
      __relay_internal__pv__IsWorkUserrelayprovider: false
    };

    // 根據 requestType 選擇正確的 query + doc_id
    const queryMap = {
      comments: { name: 'CommentsListComponentsPaginationQuery', docId: COMMENTS_DOC_ID },
      replies:  { name: 'Depth1CommentsListPaginationQuery', docId: DEPTH1_REPLIES_DOC_ID },
      depth2:   { name: 'Depth2CommentsListPaginationQuery', docId: DEPTH2_REPLIES_DOC_ID }
    };
    const query = queryMap[requestType] || queryMap.comments;

    const body = new URLSearchParams({
      fb_dtsg: dtsg,
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: query.name,
      variables: JSON.stringify(variables),
      server_timestamps: 'true',
      doc_id: query.docId
    });

    // Rate limit retry loop（最多 3 次）
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      requestCounter.check();
      await maybeInsertMicroPause();
      requestCounter.increment(requestType);

      const resp = await fetch('https://www.facebook.com/api/graphql/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        credentials: 'include'
      });

      if (!resp.ok && resp.status !== 429) {
        throw new Error(`GraphQL request failed: ${resp.status}`);
      }

      const text = await resp.text();
      const rateCheck = detectRateLimit(resp, text);
      if (rateCheck.isLimited) {
        if (attempt < MAX_RETRIES - 1) {
          await rateLimitBackoff(attempt, rateCheck.reason, rateCheck.severity);
          continue;
        }
        throw new Error(`被 Facebook 限速 (${rateCheck.reason})，請等待後再試。`);
      }

      // FB 回傳 NDJSON（Relay Streaming）：第 1 行初始資料，
      // $stream$ 行追加留言，$defer$ 行帶 page_info
      const lines = text.split('\n').filter(l => l.trim());
      let baseData = null;
      let deferredPageInfo = null;
      const streamEdges = [];

      for (const line of lines) {
        try {
          const json = JSON.parse(line);
          if (json.data?.node && !baseData) {
            baseData = json;
          } else if (json.label?.includes('$stream$') && json.data?.node) {
            streamEdges.push({ node: json.data.node });
          } else if (json.label?.includes('$defer$')) {
            // 尋找 deferred page_info
            const piStr = JSON.stringify(json.data);
            const piMatch = piStr.match(/"has_next_page":\s*(true|false)/);
            const cursorMatch = piStr.match(/"end_cursor":\s*"([^"]+)"/);
            if (piMatch) {
              deferredPageInfo = {
                has_next_page: piMatch[1] === 'true',
                end_cursor: cursorMatch ? cursorMatch[1] : null
              };
            }
          }
        } catch (_) { /* 跳過非 JSON 行 */ }
      }
      if (!baseData) throw new Error('No valid data in GraphQL response');

      // 合併 stream edges
      const instance = baseData.data.node.comment_rendering_instance_for_feed_location
        || baseData.data.node.comment_rendering_instance;
      if (instance?.comments?.edges && streamEdges.length > 0) {
        for (const se of streamEdges) {
          const seInstance = se.node.comment_rendering_instance_for_feed_location
            || se.node.comment_rendering_instance;
          if (seInstance?.comments?.edges) {
            instance.comments.edges.push(...seInstance.comments.edges);
          }
        }
      }

      // 用 deferred page_info 覆蓋（比初始的更準確）
      const commTarget = instance?.comments || baseData.data.node.replies_connection;
      if (deferredPageInfo && commTarget) {
        commTarget.page_info = deferredPageInfo;
      }

      return baseData;
    }
  }

  /**
   * 從 GraphQL response 提取留言陣列
   */
  function parseCommentsResponse(data) {
    const comments = [];
    const node = data?.data?.node;
    if (!node) return { comments, pageInfo: null };

    const instance = node.comment_rendering_instance_for_feed_location
      || node.comment_rendering_instance;
    // Depth1/Depth2 reply queries 回傳 replies_connection 而非 instance.comments
    const commentsConn = instance?.comments || node.replies_connection;
    if (!commentsConn) return { comments, pageInfo: null };

    const edges = commentsConn.edges || [];
    for (const edge of edges) {
      const cNode = edge?.node;
      if (!cNode) continue;
      const comment = extractCommentNode(cNode, 0);
      if (comment) comments.push(comment);
    }

    const pageInfo = commentsConn.page_info || null;
    return { comments, pageInfo };
  }

  /**
   * 從留言 node 提取資料（遞迴處理回覆）
   * @param {object} cNode - GraphQL comment node
   * @param {number} depth - 巢狀深度
   * @returns {object}
   */
  function extractCommentNode(cNode, depth) {
    const id = cNode.legacy_fbid || cNode.id || '';
    const authorNode = cNode.author || {};
    const author = {
      name: authorNode.name || '',
      id: authorNode.id || '',
      url: authorNode.url || ''
    };
    const text = cNode.body?.text || '';
    const timestamp = cNode.created_time
      ? new Date(cNode.created_time * 1000).toISOString()
      : '';

    // Reactions
    const feedback = cNode.feedback || {};
    const reactionsCount = parseInt(feedback.reactors?.count_reduced || '0', 10);
    const replyCount = feedback.replies_fields?.total_count || 0;
    const url = feedback.url || '';
    const expansionToken = feedback.expansion_info?.expansion_token || null;

    // 附件（貼圖/圖片/影片/連結）
    const attachments = [];
    const rawAttachments = cNode.attachments || [];
    for (const att of rawAttachments) {
      const styles = att.style_list || [];
      // 評論用 style_type_renderer，貼文用 styles（兩者路徑不同）
      const renderer = att.style_type_renderer || att.styles || {};
      const media = renderer.attachment?.media || att.media || {};
      const type = styles[0] || media.__typename?.toLowerCase() || 'unknown';
      // Phase 9: 優先取高解析度（同 Posts 邏輯）
      const mediaUrl = media.url || media.original_image?.uri || media.viewer_image?.uri
        || media.photo_image?.uri || media.image?.uri
        || media.blurred_image?.uri || media.sticker_image?.uri
        || media.playable_url || '';
      if (mediaUrl) {
        const commentAtt = {
          type,
          url: mediaUrl,
          alt: media.accessibility_caption || media.alt_text || ''
        };
        if (media.__typename === 'Video') commentAtt.videoId = media.id || '';
        attachments.push(commentAtt);
      }
    }

    // 巢狀回覆
    const replies = [];
    const repliesConn = feedback.replies_connection || feedback.replies_fields;
    if (repliesConn?.edges) {
      for (const rEdge of repliesConn.edges) {
        const rNode = rEdge?.node;
        if (rNode) {
          const reply = extractCommentNode(rNode, depth + 1);
          if (reply) replies.push(reply);
        }
      }
    }

    return {
      id,
      feedbackId: feedback.id || null,
      expansionToken,
      parentId: depth > 0 ? '' : null, // 在 flatten 時填入
      depth,
      author,
      text,
      timestamp,
      likes: reactionsCount,
      replyCount,
      url,
      attachments: attachments.length > 0 ? attachments : undefined,
      replies
    };
  }

  /**
   * 將巢狀留言樹扁平化為陣列
   */
  function flattenComments(comments, parentId = null, path = '') {
    const flat = [];
    for (const c of comments) {
      const currentPath = path ? `${path}/${c.id}` : c.id;
      flat.push({
        id: c.id,
        parentId,
        depth: c.depth,
        path: currentPath,
        author: c.author,
        text: c.text,
        timestamp: c.timestamp,
        likes: c.likes,
        replyCount: c.replyCount,
        url: c.url
      });
      if (c.replies && c.replies.length > 0) {
        flat.push(...flattenComments(c.replies, c.id, currentPath));
      }
    }
    return flat;
  }

  /** Comments pipeline — GraphQL 留言 + 巢狀回覆 */
  const commentsPipeline = {
    /**
     * 抓取留言（tree 結構）
     * @param {object} options
     * @param {string} options.postUrl - 貼文 URL（用來解析 post ID）
     * @param {string} [options.feedbackId] - 直接指定 feedbackId
     * @param {number} [options.maxDepth=3] - 最大巢狀深度
     * @returns {Promise<object>}
     */
    async scrape(options = {}) {
      const feedbackId = options.feedbackId || await resolveFeedbackId(options.postUrl);
      if (!feedbackId) {
        return { comments: [], error: 'Cannot resolve feedbackId. Use numeric post ID or provide feedbackId directly.' };
      }

      const sortOrder = options.sortOrder || 'all';
      const allComments = [];
      let cursor = null;
      let pages = 0;
      const delay = getDelay('commentFetch');

      do {
        const data = await fetchComments(feedbackId, cursor, 'comments', null, sortOrder);
        const { comments, pageInfo } = parseCommentsResponse(data);
        allComments.push(...comments);
        pages++;

        if (pageInfo?.has_next_page && pageInfo.end_cursor) {
          cursor = pageInfo.end_cursor;
          await randomSleep(delay);
        } else {
          cursor = null;
        }
      } while (cursor);

      // ─── 回覆遞迴擴展（Phase 2b #2）───
      const maxDepth = options.maxDepth || 3;
      const replyDelay = getDelay('replyFetch');
      let repliesExpanded = 0;

      async function expandReplies(comments, depth) {
        if (depth >= maxDepth) return;
        for (const comment of comments) {
          // 已有完整回覆或 replyCount=0 → 跳過
          if (!comment.replyCount || comment.replies.length >= comment.replyCount) continue;
          // 用留言的 feedback.id 查詢回覆（比 toFeedbackId 組裝更準確）
          const commentFbId = comment.feedbackId || toFeedbackId(comment.id);
          if (!commentFbId) continue;

          try {
            await randomSleep(replyDelay);
            const data = await fetchComments(commentFbId, null, 'replies', comment.expansionToken);
            const { comments: fetchedReplies } = parseCommentsResponse(data);
            if (fetchedReplies.length > 0) {
              // 合併：用新抓到的取代原有的（原有的通常是子集）
              comment.replies = fetchedReplies;
              repliesExpanded++;
              // 遞迴往下（深度 +1）
              await expandReplies(fetchedReplies, depth + 1);
            }
          } catch (err) { console.warn(`[FB Catch] expandReplies skip ${comment.id}:`, err.message); }
        }
      }

      await expandReplies(allComments, 0);

      // 計算回覆數與總計
      function countReplies(comments) {
        let total = 0;
        for (const c of comments) {
          if (c.replies?.length) {
            total += c.replies.length;
            total += countReplies(c.replies);
          }
        }
        return total;
      }
      const totalReplies = countReplies(allComments);
      const grandTotal = allComments.length + totalReplies;

      const postUrl = options.postUrl || '';
      return {
        meta: {
          postUrl,
          scrapedAt: new Date().toISOString(),
          totalFetched: allComments.length,
          totalReplies,
          grandTotal,
          repliesExpanded,
          pages,
          sortOrder,
          tool: 'FB Catch v' + VERSION
        },
        comments: allComments
      };
    },

    /**
     * 抓取留言（flat 扁平化陣列）
     */
    async scrapeFlat(options = {}) {
      const result = await this.scrape(options);
      if (result.error) return result;
      const flat = flattenComments(result.comments);
      const topLevelCount = result.comments.length;
      const repliesCount = flat.length - topLevelCount;
      return {
        meta: {
          ...result.meta,
          totalFetched: flat.length,
          topLevelCount,
          repliesCount
        },
        comments: flat
      };
    }
  };

  /**
   * 從 postUrl 解析 feedbackId
   * 多策略消歧：top_level_post_id → story_node_id → Base64 掃描 → 鄰近/頻率消歧
   * 找不到寧可回 null（讓 caller 報錯），不亂猜
   */
  async function resolveFeedbackId(postUrl) {
    if (!postUrl) return null;
    const id = extractPostId(postUrl);

    // ─── 快速路徑：URL 含 /posts/{numericId}（Groups / 個人頁 / 粉專）───
    // 直接構建 feedbackId，不需搜 HTML（解決 Groups 首頁抓不到的問題）
    const postsNumericMatch = postUrl.match(/\/posts\/(\d+)/);
    if (postsNumericMatch) {
      const directFbId = toFeedbackId(postsNumericMatch[1]);
      if (directFbId) return directFbId;
    }

    const html = document.documentElement.innerHTML;

    // ─── 策略 0：搜 "top_level_post_id":"xxx"（最精準，FB 貼文頁必有）───
    const topLevelMatches = [...html.matchAll(/"top_level_post_id":\s*"(\d+)"/g)].map(m => m[1]);
    const topLevelIds = [...new Set(topLevelMatches)];
    if (topLevelIds.length === 1) {
      return toFeedbackId(topLevelIds[0]);
    }

    // ─── 策略 0b：搜 "story_node_id":"xxx"（comet 架構備援）───
    const storyNodeMatches = [...html.matchAll(/"story_node_id":\s*"(\d+)"/g)].map(m => m[1]);
    const storyNodeIds = [...new Set(storyNodeMatches)];
    if (storyNodeIds.length === 1) {
      return toFeedbackId(storyNodeIds[0]);
    }

    // ─── 策略 1：從 HTML 搜 Base64 feedbackId ───
    const feedbackIds = new Set();
    const fbMatches = [...html.matchAll(/ZmVlZGJhY2s6([A-Za-z0-9+/=]+)/g)];
    for (const m of fbMatches) {
      try {
        const decoded = atob('ZmVlZGJhY2s6' + m[1]);
        if (decoded.startsWith('feedback:')) {
          const numId = decoded.replace('feedback:', '');
          if (/^\d+$/.test(numId)) feedbackIds.add(numId);
        }
      } catch (_) { /* 非法 Base64 */ }
    }

    // ─── 策略 2：搜 "post_id":"xxx" ───
    const postIdMatches = [...html.matchAll(/"post_id":\s*"(\d+)"/g)].map(m => m[1]);
    for (const pid of postIdMatches) feedbackIds.add(pid);

    // 合併策略 0/0b 的多值候選到 feedbackIds
    for (const tid of topLevelIds) feedbackIds.add(tid);
    for (const sid of storyNodeIds) feedbackIds.add(sid);

    // ─── 消歧邏輯 ───

    // URL 的 fbid 直接在候選中 → 直接用（不變量：原正確路徑）
    if (id && /^\d+$/.test(id) && feedbackIds.has(id)) {
      return toFeedbackId(id);
    }

    // 唯一候選 → 直接用
    if (feedbackIds.size === 1) {
      return toFeedbackId([...feedbackIds][0]);
    }

    // 多候選消歧
    if (feedbackIds.size > 1) {
      // 消歧 A：pfbid / fbid 鄰近搜尋（擴大到 2000 字元）
      const searchId = id || '';
      if (searchId) {
        const idPos = html.indexOf(searchId);
        if (idPos > 0) {
          const nearby = html.slice(Math.max(0, idPos - 2000), idPos + 2000);
          for (const pid of feedbackIds) {
            if (nearby.includes(pid)) return toFeedbackId(pid);
          }
        }
      }

      // 消歧 B：top_level_post_id 有多個時，取與 URL fbid 最相關的
      if (topLevelIds.length > 1 && searchId) {
        for (const tid of topLevelIds) {
          // 在 HTML 中搜 fbid 和 top_level_post_id 是否在同一 JSON 物件內
          const tidPos = html.indexOf(`"top_level_post_id":"${tid}"`);
          if (tidPos > 0) {
            const jsonBlock = html.slice(Math.max(0, tidPos - 3000), tidPos + 3000);
            if (jsonBlock.includes(searchId)) return toFeedbackId(tid);
          }
        }
      }

      // 消歧 C：頻率消歧 — 出現次數最多的 post_id 通常是主貼文
      const freq = new Map();
      for (const pid of feedbackIds) {
        const re = new RegExp(pid, 'g');
        const count = (html.match(re) || []).length;
        freq.set(pid, count);
      }
      let maxPid = null, maxCount = 0;
      for (const [pid, count] of freq) {
        if (count > maxCount) { maxCount = count; maxPid = pid; }
      }
      // 只有在頻率明顯領先時才採用（至少比第二名多 2 倍）
      if (maxPid) {
        const sorted = [...freq.values()].sort((a, b) => b - a);
        if (sorted.length < 2 || sorted[0] >= sorted[1] * 2) {
          return toFeedbackId(maxPid);
        }
      }
    }

    // ─── 最後 fallback：不猜，回 null 讓 caller 報錯 ───
    // （原版會拿 photo fbid 硬轉，但已知 photo ID ≠ post ID，寧可明確失敗）
    return null;
  }

  /** Batch pipeline — 掃貼文 → 勾選 → 批次抓留言 */
  const batchPipeline = {
    _running: false,
    _paused: false,
    _cancelled: false,
    _progress: { current: 0, total: 0, results: [] },

    /**
     * 批次抓取多篇貼文的留言
     * @param {object} options
     * @param {Array<{url:string, feedbackId?:string, title?:string}>} options.posts - 貼文清單
     * @param {number} [options.maxDepth=3] - 每篇的最大回覆深度
     * @returns {Promise<object>}
     */
    async scrapeComments(options = {}) {
      const posts = options.posts || [];
      if (posts.length === 0) {
        return { results: [], error: 'No posts provided' };
      }

      this._running = true;
      this._paused = false;
      this._cancelled = false;
      this._progress = { current: 0, total: posts.length, results: [] };

      const betweenDelay = getDelay('betweenPosts');

      for (let i = 0; i < posts.length; i++) {
        // 取消檢查
        if (this._cancelled) break;

        // 暫停等待
        while (this._paused && !this._cancelled) {
          await sleep(500);
        }
        if (this._cancelled) break;

        this._progress.current = i + 1;
        const post = posts[i];

        try {
          const result = await commentsPipeline.scrape({
            postUrl: post.url,
            feedbackId: post.feedbackId,
            maxDepth: options.maxDepth,
            sortOrder: options.sortOrder
          });
          this._progress.results.push({
            url: post.url,
            title: post.title || '',
            success: !result.error,
            totalFetched: result.meta?.grandTotal || result.meta?.totalFetched || 0,
            error: result.error || null,
            data: result
          });
        } catch (err) {
          this._progress.results.push({
            url: post.url,
            title: post.title || '',
            success: false,
            totalFetched: 0,
            error: err.message
          });
        }

        // 貼文間安全間隔（最後一篇不等）
        if (i < posts.length - 1 && !this._cancelled) {
          await randomSleep(betweenDelay);
        }
      }

      this._running = false;
      return {
        meta: {
          total: posts.length,
          completed: this._progress.results.length,
          cancelled: this._cancelled,
          scrapedAt: new Date().toISOString(),
          tool: 'FB Catch v' + VERSION
        },
        results: this._progress.results
      };
    },

    status() {
      return {
        running: this._running,
        paused: this._paused,
        cancelled: this._cancelled,
        progress: { ...this._progress }
      };
    },

    pause() { this._paused = true; },
    resume() { this._paused = false; },
    cancel() { this._cancelled = true; this._running = false; }
  };

  // ─── 媒體下載（B+C 方案）────────────────────────────────

  // 去重：記錄已下載的 URL（session 內有效，避免重複下載）
  const downloadedUrls = new Set();

  /**
   * 下載單一媒體檔案到「下載」資料夾
   * @param {string} url - CDN URL
   * @param {string} filename - 存檔名（含路徑前綴）
   * @returns {Promise<{ok:boolean, filename:string, error?:string}>}
   */
  async function downloadMedia(url, filename) {
    if (!url) return { ok: false, filename, error: 'empty URL' };
    // 去重：同一 URL 不重複下載
    if (downloadedUrls.has(url)) {
      return { ok: true, filename, skipped: true };
    }
    try {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: 'downloadFile', url, filename },
          (resp) => {
            if (resp?.ok) downloadedUrls.add(url);
            resolve(resp || { ok: false, error: 'no response from background' });
          }
        );
      });
    } catch (err) {
      return { ok: false, filename, error: err.message };
    }
  }

  /**
   * 解析影片真實 URL — timeline GraphQL 不含 playable_url，需額外查詢
   * 方法：fetch /watch/?v={id} 頁面，解析 data-sjs script 中的 JSON 提取 playable_url
   * 參考：yt-dlp facebook.py 的 data-sjs 解析策略
   * @param {string} videoId - Video relay ID (base64) 或數字 ID
   * @param {string} fallbackUrl - 解析失敗時回傳的 URL（通常是縮圖）
   * @returns {Promise<string>} 影片真實 URL 或 fallback
   */
  const _videoUrlCache = new Map();

  // 遞迴搜尋 JSON 物件中的指定 key（深度限制防堆疊溢位）
  function _deepSearchVideoUrl(obj, key, depth) {
    if (depth > 15 || !obj || typeof obj !== 'object') return null;
    // 直接命中
    if (typeof obj[key] === 'string' && obj[key].startsWith('http')) return obj[key];
    // 2024+ 新容器：videoDeliveryLegacyFields
    if (obj.videoDeliveryLegacyFields) {
      const r = _deepSearchVideoUrl(obj.videoDeliveryLegacyFields, key, depth + 1);
      if (r) return r;
    }
    // 遞迴子物件
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const r = _deepSearchVideoUrl(item, key, depth + 1);
        if (r) return r;
      }
    } else {
      for (const v of Object.values(obj)) {
        const r = _deepSearchVideoUrl(v, key, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  // 影片 GraphQL doc_id（來源：github.com/monokaijs gist，2025-03 驗證有效）
  const VIDEO_DOC_ID = '5279476072161634';

  async function resolveVideoUrl(videoId, fallbackUrl) {
    if (!videoId) return fallbackUrl;
    // 從 relay ID 提取數字 ID
    let numericId = videoId;
    if (!/^\d+$/.test(videoId)) {
      try {
        const decoded = atob(videoId);
        const m = decoded.match(/:(\d+)$/);
        if (m) numericId = m[1];
      } catch (_) {}
    }
    if (!/^\d+$/.test(numericId)) return fallbackUrl;
    // 快取命中
    if (_videoUrlCache.has(numericId)) return _videoUrlCache.get(numericId);

    // 策略：用 GraphQL API 直接查影片 URL（跟掃描貼文同一套機制）
    try {
      const dtsg = await getDtsg();
      if (!dtsg) return fallbackUrl;

      requestCounter.check();
      await maybeInsertMicroPause();
      requestCounter.increment('videoResolve');

      const body = new URLSearchParams({
        fb_dtsg: dtsg,
        fb_api_caller_class: 'RelayModern',
        fb_api_req_friendly_name: 'FBReelPlaybackQuery',
        variables: JSON.stringify({ videoID: numericId, feedLocation: 'TAHOE', scale: 1 }),
        server_timestamps: 'true',
        doc_id: VIDEO_DOC_ID
      });

      const resp = await fetch('https://www.facebook.com/api/graphql/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        credentials: 'include'
      });

      if (!resp.ok) {
        console.warn('[FB Catch] resolveVideoUrl GraphQL failed:', resp.status);
        return fallbackUrl;
      }

      const text = await resp.text();
      // GraphQL 回應可能是多行 JSON（每行一個 JSON object）
      const lines = text.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const json = JSON.parse(line);
          // 遞迴搜尋影片 URL（優先 HD）
          const hd = _deepSearchVideoUrl(json, 'playable_url_quality_hd', 0);
          if (hd) { _videoUrlCache.set(numericId, hd); return hd; }
          const sd = _deepSearchVideoUrl(json, 'playable_url', 0);
          if (sd) { _videoUrlCache.set(numericId, sd); return sd; }
          const bnHd = _deepSearchVideoUrl(json, 'browser_native_hd_url', 0);
          if (bnHd) { _videoUrlCache.set(numericId, bnHd); return bnHd; }
          const bnSd = _deepSearchVideoUrl(json, 'browser_native_sd_url', 0);
          if (bnSd) { _videoUrlCache.set(numericId, bnSd); return bnSd; }
        } catch (_) { /* 非 JSON 行，跳過 */ }
      }

      console.warn('[FB Catch] resolveVideoUrl: GraphQL response has no playable_url for', numericId);
      return fallbackUrl;
    } catch (err) {
      console.warn('[FB Catch] resolveVideoUrl failed for', numericId, err.message);
      return fallbackUrl;
    }
  }

  /**
   * 下載貼文的附件（圖片/影片）+ 寫回 localPath
   * @param {Array} posts - parsePostsResponse 回傳的 posts 陣列
   * @param {string} username - 粉專 username（作為資料夾名）
   * @returns {Promise<{total, success, skipped, results}>}
   */
  async function downloadPostsMedia(posts, username = 'unknown', options = {}) {
    // 批量下載時隱藏 Chrome 下載列（減少干擾）
    try { chrome.runtime.sendMessage({ action: 'hideDownloadShelf' }); } catch (_) {}
    const results = [];
    // Phase 8e: scanContext 優先，無則 fallback
    const ctx = options.scanContext || null;
    const safeName = ctx ? _safeFilename(options.pageName || username) : _safeFilename(options.pageName || username);
    const ts = ctx ? ctx.ts : _formatTimestamp();
    const isBatch = ctx ? ctx.isBatch : !!options.isBatch;
    const dirPrefix = isBatch
      ? `FBToolKit_batch_mode/${safeName}/${ts}/media`
      : `${safeName}/${ts}/media`;

    // 先計算總數
    let total = 0;
    for (const post of posts) {
      if (post.attachments?.length) total += post.attachments.filter(a => a.url).length;
    }

    for (const post of posts) {
      if (!post.attachments?.length) continue;
      for (let i = 0; i < post.attachments.length; i++) {
        const att = post.attachments[i];
        if (!att.url) continue;
        // 影片 URL 解析：若只有縮圖，嘗試取得真實影片 URL
        if (att.type === 'video' && att.videoId) {
          const resolved = await resolveVideoUrl(att.videoId, att.url);
          if (resolved !== att.url) att.url = resolved;
        }
        const ext = att.type === 'video' ? 'mp4' : 'jpg';
        const filename = `${dirPrefix}/${post.id}_${att.type}_${i}.${ext}`;
        const result = await downloadMedia(att.url, filename);
        if (result.ok || result.skipped) {
          // Phase 8e T6: localFile 用相對路徑（相對於 JSON 檔同層）
          att.localFile = `./media/${post.id}_${att.type}_${i}.${ext}`;
        }
        results.push({ postId: post.id, ...result });
        // Phase 6b: 逐檔進度回報
        try { chrome.runtime.sendMessage({ type: 'MEDIA_PROGRESS', source: 'posts', current: results.length, total }); } catch (_) {}
        await sleep(300);
      }
    }
    // 批量下載完成，恢復下載列
    try { chrome.runtime.sendMessage({ action: 'showDownloadShelf' }); } catch (_) {}
    const success = results.filter(r => r.ok && !r.skipped).length;
    const skipped = results.filter(r => r.skipped).length;
    return { total: results.length, success, skipped, failed: results.length - success - skipped, results };
  }

  /**
   * 從留言樹中收集所有附件 URL
   * @param {Array} comments - 留言陣列（tree 結構）
   * @param {string} postId - 貼文 ID（作為資料夾名）
   * @returns {Array<{url, filename, commentId, type}>}
   */
  function collectMediaFromComments(comments, postId = 'unknown', options = {}) {
    const media = [];
    // Phase 8e: scanContext 優先，無則 fallback
    const ctx = options.scanContext || null;
    const safeName = _safeFilename(options.pageName || postId);
    const ts = ctx ? ctx.ts : _formatTimestamp();
    const isBatch = ctx ? ctx.isBatch : !!options.isBatch;
    const dirPrefix = isBatch
      ? `FBToolKit_batch_mode/${safeName}/${ts}/media`
      : `${safeName}/${ts}/media`;

    function walk(list) {
      for (const c of list) {
        if (c.attachments) {
          c.attachments.forEach((att, i) => {
            if (!att.url) return;
            const ext = att.type === 'video_inline' ? 'mp4'
              : att.type === 'sticker' ? 'png' : 'jpg';
            const basename = `${c.id}_${att.type}_${i}.${ext}`;
            media.push({
              url: att.url,
              filename: `${dirPrefix}/${basename}`,
              localFile: `./media/${basename}`,
              commentId: c.id,
              type: att.type,
              videoId: att.videoId || ''
            });
          });
        }
        if (c.replies?.length) walk(c.replies);
      }
    }
    walk(comments);
    return media;
  }

  /**
   * 批次下載所有附件（方案 B：抓完留言後立即下載）
   * @param {Array} comments - 留言樹
   * @param {string} postId - 貼文 ID
   * @returns {Promise<{total, success, failed, results}>}
   */
  async function downloadAllMedia(comments, postId, progressSource = 'comments', options = {}) {
    const mediaList = collectMediaFromComments(comments, postId, options);
    if (mediaList.length === 0) return { total: 0, success: 0, failed: 0, results: [] };

    const results = [];
    for (const item of mediaList) {
      // 影片 URL 解析：若只有縮圖，嘗試取得真實影片 URL
      if (item.videoId && (item.type === 'video' || item.type === 'video_inline')) {
        const resolved = await resolveVideoUrl(item.videoId, item.url);
        if (resolved !== item.url) item.url = resolved;
      }
      const result = await downloadMedia(item.url, item.filename);
      results.push({ ...item, ...result });
      // Phase 6b: 逐檔進度回報
      try { chrome.runtime.sendMessage({ type: 'MEDIA_PROGRESS', source: progressSource, current: results.length, total: mediaList.length }); } catch (_) {}
      await sleep(300);
    }

    const success = results.filter(r => r.ok).length;
    return {
      total: mediaList.length,
      success,
      failed: mediaList.length - success,
      results
    };
  }

  /**
   * 方案 C 加強版：批次下載 + 把 localPath 寫回 comments 資料
   * @param {Array} comments - 留言樹（會被修改，加上 localPath）
   * @param {string} postId - 貼文 ID
   * @returns {Promise<{comments, media, enrichedJson}>}
   */
  async function downloadMediaAndEnrich(comments, postId) {
    const mediaResult = await downloadAllMedia(comments, postId);

    // 建立 mapping: commentId+type+index → localPath
    const pathMap = new Map();
    for (const r of mediaResult.results) {
      if (r.ok && r.filename) {
        pathMap.set(`${r.commentId}_${r.type}`, r.filename);
      }
    }

    // 寫回 localPath 到 comments 的 attachments
    function enrichTree(list) {
      for (const c of list) {
        if (c.attachments) {
          c.attachments.forEach((att, i) => {
            const key = `${c.id}_${att.type}`;
            const localPath = pathMap.get(key);
            if (localPath) att.localPath = localPath;
          });
        }
        if (c.replies?.length) enrichTree(c.replies);
      }
    }
    enrichTree(comments);

    return {
      comments, // 已加上 localPath
      media: mediaResult,
      enrichedCount: pathMap.size
    };
  }

  // ─── 匯出工具 ─────────────────────────────────────────

  /**
   * 從當前頁面 URL 提取 username（如 cwa.weather）
   */
  function getPageUsername() {
    return _usernameFromUrl(window.location.href);
  }

  /** Phase 8e fix: 從任意 FB URL 提取 username（不限當前頁面） */
  function _usernameFromUrl(url) {
    try {
      const u = new URL(url);
      const path = u.pathname;
      // profile.php?id= → 回傳 "id_數字"（比完整 URL 好）
      if (path === '/profile.php') {
        const pid = u.searchParams.get('id');
        if (pid) return `id_${pid}`;
      }
      const match = path.match(/^\/([^/?#]+)/);
      if (match && !['watch', 'reel', 'photo', 'groups', 'events', 'profile.php'].includes(match[1])) {
        return match[1];
      }
    } catch (_) {}
    return '';
  }

  /**
   * 從頁面 DOM 提取粉專/個人名稱
   */
  /** Phase 8e fix: 判斷是否為 FB 泛用名稱（登入頁、重導頁、空白頁等） */
  function _isGenericFbName(name) {
    if (!name || !name.trim()) return true;
    const n = name.trim();
    // FB 站名 / 首頁 / 搜尋結果 / 影片 / Marketplace 等 UI 區段標題
    if (/^\s*(Facebook|首頁|Home|搜尋結果|Search\s*Results?|Watch|影片|Marketplace|Reels|Gaming)\s*$/i.test(n)) return true;
    // "Facebook - 登入或註冊" / "Log into Facebook" / "Facebook – log in or sign up" 等
    if (/facebook/i.test(n) && /(log\s*in|sign\s*up|登入|註冊|iniciar|anmeld)/i.test(n)) return true;
    return false;
  }

  function getPageDisplayName() {
    // 優先：<title> 標籤（FB 格式：「名稱 | Facebook」或「名稱 - 首頁」）
    const title = document.title || '';
    const cleaned = title.replace(/\s*[|\-–—]\s*(Facebook|首頁|Home).*$/i, '').trim();
    if (cleaned && cleaned.length < 50 && !_isGenericFbName(cleaned)) return cleaned;
    // 備用：h1 或 profile name
    const h1 = document.querySelector('h1');
    const h1Text = h1?.textContent?.trim();
    if (h1Text && !_isGenericFbName(h1Text)) return h1Text.slice(0, 50);
    return '';
  }

  /**
   * 產生標準化檔名
   * 格式：{pageName}_{username}_{YYYYMMDDHHmm}_{type}.{ext}
   * @param {string} type - 'posts' | 'comments' | 'batch'
   * @param {string} format - 'json' | 'csv'
   * @param {object} [override] - { pageName, username } 手動覆蓋
   */
  // T9: 共用安全檔名清理（Windows 保留字 + 控制字元 + 尾端空白點）
  function _safeFilename(name) {
    let s = (name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, '-').replace(/[\s.]+$/, '');
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(s.split('.')[0])) s = '_' + s;
    return s.slice(0, 30) || 'download';
  }

  // ─── Phase 8e: 統一時間戳 ─────────────────────────────────
  function _formatTimestamp(date) {
    const d = date || new Date();
    return d.getFullYear().toString() +
      String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0') + '-' +
      String(d.getHours()).padStart(2, '0') +
      String(d.getMinutes()).padStart(2, '0');
  }

  /** 掃描上下文 — executeSelected() 開頭建立一次，穿透傳入所有 export/download 函式 */
  function createScanContext(isBatch) {
    const now = new Date();
    return {
      startTime: now,
      ts: _formatTimestamp(now),  // "YYYYMMdd-HHmm"
      isBatch,
      logger: null,               // Phase β 加入
      files: [],                  // Phase γ 加入
    };
  }

  // ─── Phase 8e T2: ScanLogger 儀表化 ─────────────────────
  class ScanLogger {
    constructor(startTime) {
      this._startTime = startTime;
      this._events = [];
      this._buffer = [];
      this._flushThreshold = 20;
      this._storageKey = 'fbt_scan_log_' + startTime.getTime();
    }

    emit(eventType, payload = {}) {
      const now = Date.now();
      const entry = {
        timestamp: new Date(now).toISOString(),
        elapsedMs: now - this._startTime.getTime(),
        eventType,
        payload
      };
      this._events.push(entry);
      this._buffer.push(entry);
      if (this._buffer.length >= this._flushThreshold) this.flush();
    }

    async flush() {
      if (!this._buffer.length) return;
      try {
        const data = await new Promise(r =>
          chrome.storage.local.get(this._storageKey, d => r(d[this._storageKey] || []))
        );
        await new Promise((resolve, reject) =>
          chrome.storage.local.set(
            { [this._storageKey]: [...data, ...this._buffer] },
            () => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve()
          )
        );
        this._buffer = [];
      } catch (e) {
        console.warn('[ScanLogger] flush failed:', e.message);
      }
    }

    getEvents() { return this._events; }
    getStartTime() { return this._startTime; }

    async cleanup() {
      try { chrome.storage.local.remove(this._storageKey); } catch (_) {}
    }
  }

  // 模組層級 logger 參考（startScan 設定，executeSelected 讀取）
  let _activeScanLogger = null;

  // ─── Phase 8e T3-T5: 產出 log.md / index.md / top_index.md ──

  function _fmtElapsed(ms) {
    const s = Math.round(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function _fmtTime(iso) {
    return iso ? iso.replace('T', ' ').slice(11, 19) : '';
  }

  /**
   * T3: 產生 _log.md（掃描日誌 + Mermaid gantt）
   * @param {ScanLogger} logger
   * @param {object} scanInfo - { targets, settings, isBatch }
   * @returns {string} markdown 內容
   */
  function generateLogMd(logger, scanInfo = {}) {
    const events = logger.getEvents();
    const startTime = logger.getStartTime();
    const endTime = new Date();
    const elapsed = endTime - startTime;

    // 統計各 eventType
    const stats = {};
    for (const e of events) {
      if (!stats[e.eventType]) stats[e.eventType] = { count: 0, totalMs: 0 };
      stats[e.eventType].count++;
      // 估算各事件持續時間
      if (e.payload.pauseMs) stats[e.eventType].totalMs += e.payload.pauseMs;
      if (e.payload.waitMs) stats[e.eventType].totalMs += e.payload.waitMs;
      if (e.payload.backoffMs) stats[e.eventType].totalMs += e.payload.backoffMs;
      if (e.payload.delayMs) stats[e.eventType].totalMs += e.payload.delayMs;
    }

    // Token Bucket 統計
    const reqEvents = events.filter(e => e.eventType === 'REQUEST_END');
    const minTokens = reqEvents.length ? Math.min(...reqEvents.map(e => e.payload.tokensRemaining ?? 8)) : 8;

    // 失敗紀錄
    const failures = events.filter(e => e.eventType === 'RETRY_FAIL' || e.eventType === 'RATE_LIMIT');
    const firstFailIdx = events.findIndex(e => e.eventType === 'RETRY_FAIL' || e.eventType === 'RATE_LIMIT');
    const firstFailElapsed = firstFailIdx >= 0 ? events[firstFailIdx].elapsedMs : null;

    // Throttle 統計
    const throttles = events.filter(e => e.eventType === 'THROTTLE_CHANGE');
    const maxDelay = throttles.length ? Math.max(...throttles.map(e => e.payload.newDelay || 0)) : 0;
    const pauses = events.filter(e => e.eventType === 'PAUSE');

    let md = `# 掃描日誌\n\n`;
    md += `## 掃描參數\n`;
    md += `| 項目 | 值 |\n|------|---|\n`;
    md += `| 模式 | ${scanInfo.isBatch ? 'Batch' : '單一'} |\n`;
    md += `| 目標 | ${(scanInfo.targets || []).map(t => t.name || t.url).join(', ') || '-'} |\n`;
    md += `| 開始時間 | ${startTime.toISOString()} |\n`;
    md += `| 結束時間 | ${endTime.toISOString()} |\n`;
    md += `| 總耗時 | ${_fmtElapsed(elapsed)} |\n\n`;

    md += `## 時間統計\n`;
    md += `| 動作 | 次數 | 總秒數 | 平均 |\n|------|------|--------|------|\n`;
    for (const [type, s] of Object.entries(stats)) {
      const avg = s.count > 0 ? (s.totalMs / s.count / 1000).toFixed(1) : '-';
      md += `| ${type} | ${s.count} | ${(s.totalMs / 1000).toFixed(1)} | ${avg}s |\n`;
    }

    md += `\n## Token Bucket 狀態\n`;
    md += `| 項目 | 值 |\n|------|---|\n`;
    md += `| 初始容量 | 8 |\n`;
    md += `| 請求次數 | ${reqEvents.length} |\n`;
    md += `| 最低水位 | ${minTokens} |\n\n`;

    md += `## 反偵測動作\n`;
    md += `- 🔀 來源打亂：${scanInfo.isBatch ? '是' : '否'}\n`;
    md += `- 📈 延遲調升次數：${throttles.filter(t => t.payload.direction === 'up').length}（最高 ${maxDelay}ms）\n`;
    md += `- 📖 Micro-pause 次數：${pauses.length}（總 ${(pauses.reduce((s, p) => s + (p.payload.pauseMs || 0), 0) / 1000).toFixed(0)}s）\n\n`;

    if (failures.length) {
      md += `## 失敗與重試\n`;
      md += `| # | 時間 | 類型 | 詳情 |\n|---|------|------|------|\n`;
      failures.forEach((f, i) => {
        md += `| ${i + 1} | ${_fmtTime(f.timestamp)} | ${f.eventType} | ${f.payload.reason || f.payload.error || '-'} |\n`;
      });
      md += `\n## 失敗統計\n`;
      md += `- 正常運行到首次失敗：${firstFailElapsed !== null ? _fmtElapsed(firstFailElapsed) : '無失敗'}\n\n`;
    }

    // Mermaid gantt（T7）
    if (events.length > 0) {
      md += `## 掃描時間軸\n\n`;
      md += '```mermaid\ngantt\n    title 掃描事件時間軸\n    dateFormat HH:mm:ss\n    axisFormat %H:%M:%S\n';
      const baseH = startTime.getHours(), baseM = startTime.getMinutes(), baseS = startTime.getSeconds();
      const fmtGantt = (ms) => {
        const total = Math.round(ms / 1000) + baseH * 3600 + baseM * 60 + baseS;
        const h = Math.floor(total / 3600) % 24, m = Math.floor((total % 3600) / 60), s = total % 60;
        return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      };
      md += '    section 事件\n';
      for (const e of events.slice(0, 30)) { // 限 30 筆避免過長
        const dur = e.payload.pauseMs || e.payload.waitMs || e.payload.backoffMs || 1000;
        md += `    ${e.eventType} :${fmtGantt(e.elapsedMs)}, ${Math.max(1, Math.round(dur / 1000))}s\n`;
      }
      md += '```\n\n';
    }

    md += `*由 FB Catch v${VERSION} 自動產生*\n`;
    return md;
  }

  /**
   * T4: 產生 _index.md（單次掃描關聯圖 + Mermaid pie）
   * @param {object} ctx - ScanContext
   * @param {Array} files - [{ filename, type, count, mediaCount }]
   * @param {object} mediaMap - [{ mediaFile, sourceJson, fieldPath, postOrCommentId }]
   * @returns {string} markdown 內容
   */
  function generateIndexMd(ctx, files = [], mediaMap = []) {
    const safeName = ctx.safeName || 'unknown';
    let md = `# 掃描索引 — ${safeName} ${ctx.ts}\n\n`;
    md += `## 掃描資訊\n`;
    md += `| 項目 | 值 |\n|------|---|\n`;
    md += `| 時間 | ${ctx.startTime.toISOString()} |\n`;
    md += `| 模式 | ${ctx.isBatch ? 'Batch' : '單一'} |\n`;
    md += `| 工具版本 | FB Catch v${VERSION} |\n\n`;

    if (files.length) {
      md += `## 檔案清單\n`;
      md += `| 檔名 | 類型 | 筆數 | 媒體數 |\n|------|------|------|--------|\n`;
      for (const f of files) {
        md += `| ${f.filename} | ${f.type} | ${f.count} | ${f.mediaCount || 0} |\n`;
      }
      md += '\n';
    }

    if (mediaMap.length) {
      md += `## 媒體關聯表\n`;
      md += `| 媒體檔案 | 來源 JSON | 貼文/評論 ID |\n|----------|----------|-------------|\n`;
      for (const m of mediaMap.slice(0, 50)) { // 限 50 筆
        md += `| ${m.mediaFile} | ${m.sourceJson} | ${m.id} |\n`;
      }
      md += '\n';
    }

    // Log 連結
    md += `## Log 連結\n`;
    md += `→ [${safeName}_${ctx.ts}_log.md](./${safeName}_${ctx.ts}_log.md)\n\n`;

    // Mermaid pie（T7）
    if (files.length) {
      const typeCounts = {};
      for (const f of files) typeCounts[f.type] = (typeCounts[f.type] || 0) + f.count;
      md += `## 檔案類型分布\n\n`;
      md += '```mermaid\npie title 檔案類型分布\n';
      for (const [t, c] of Object.entries(typeCounts)) {
        md += `    "${t}" : ${c}\n`;
      }
      md += '```\n\n';
    }

    md += `*由 FB Catch v${VERSION} 自動產生*\n`;
    return md;
  }

  /**
   * T5: top_index 歷史累積（chrome.storage.local）
   */
  async function appendTopIndexEntry(safeName, entry) {
    const key = `fbt_topindex_${safeName}`;
    const existing = await new Promise(r =>
      chrome.storage.local.get(key, d => r(d[key] || []))
    );
    existing.push(entry);
    await new Promise((resolve, reject) =>
      chrome.storage.local.set({ [key]: existing },
        () => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve()
      )
    );
    return existing;
  }

  function generateTopIndexMd(safeName, history = []) {
    let md = `# 掃描總索引 — ${safeName}\n\n`;
    md += `| # | 時間 | 模式 | 貼文 | 評論 | 媒體 | Index | Log |\n`;
    md += `|---|------|------|------|------|------|-------|-----|\n`;
    history.forEach((h, i) => {
      md += `| ${i + 1} | ${h.ts} | ${h.mode} | ${h.postsCount} | ${h.commentsCount} | ${h.mediaCount} | [index](./${h.ts}/${safeName}_${h.ts}_index.md) | [log](./${h.ts}/${safeName}_${h.ts}_log.md) |\n`;
    });
    md += `\n*由 FB Catch v${VERSION} 自動產生，追加不覆寫*\n`;
    return md;
  }

  function buildFilename(type, format, override = {}) {
    // Phase 8e: scanContext 優先，無則 fallback（向後相容 popup 舊呼叫）
    const ctx = override.scanContext || null;
    const pageName = override.pageName || getPageDisplayName() || '';
    const safeName = _safeFilename(pageName);
    const ts = ctx ? ctx.ts : _formatTimestamp();
    const isBatch = ctx ? ctx.isBatch : !!override.isBatch;
    const ext = format === 'csv' ? 'csv' : format === 'md_raw' ? 'md' : 'json';
    const dir = isBatch
      ? `FBToolKit_batch_mode/${safeName}/${ts}`
      : `${safeName}/${ts}`;
    const parts = [safeName, ts, type].filter(Boolean);
    return `${dir}/${parts.join('_')}.${ext}`;
  }

  /**
   * 下載資料為檔案
   * @param {*} data
   * @param {'json'|'csv'|'tree'} format
   * @param {string} filenamePrefix - 舊式前綴（向後相容）或 type
   * @param {object} [naming] - { pageName, username, type } 新式命名
   */
  async function exportData(data, format, filenamePrefix, naming) {
    let content, mimeType, ext;

    // Phase 8e T6: JSON meta 區塊（有 scanContext 且非 CSV 時包裝）
    let outputData = data;
    if (naming?.scanContext && format !== 'csv' && format !== 'md_raw') {
      const ctx = naming.scanContext;
      outputData = {
        meta: {
          source: naming.pageName || '',
          scannedAt: ctx.startTime.toISOString(),
          tool: 'FB Catch v' + VERSION,
          mediaDir: './media/'
        },
        data
      };
    }

    switch (format) {
      case 'csv':
        content = convertToCsv(data);
        mimeType = 'text/csv;charset=utf-8';
        ext = 'csv';
        break;
      case 'md_raw':
        // Phase 8e: markdown 直出（log.md / index.md）
        content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        mimeType = 'text/markdown;charset=utf-8';
        ext = 'md';
        break;
      case 'tree':
        content = JSON.stringify(outputData, null, 2);
        mimeType = 'application/json';
        ext = 'json';
        break;
      case 'json':
      default:
        content = JSON.stringify(outputData, null, 2);
        mimeType = 'application/json';
        ext = 'json';
        break;
    }

    // 新式命名（有 naming 參數時用標準格式）
    let filename;
    if (naming) {
      filename = buildFilename(naming.type || filenamePrefix, format, naming);
    } else {
      filename = buildFilename(filenamePrefix, format);
    }

    // 透過 background → offscreen document 建 blob URL → chrome.downloads（支援子目錄）
    console.log('[FB Catch] exportData →', filename, '(', content.length, 'chars)');
    try {
      await new Promise((resolve, reject) => {
        if (!chrome.runtime?.sendMessage) { reject(new Error('chrome.runtime unavailable')); return; }
        const timer = setTimeout(() => reject(new Error('timeout 15s')), 15000);
        chrome.runtime.sendMessage(
          { action: 'downloadContent', content, mimeType, filename },
          (resp) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
            console.log('[FB Catch] exportData response:', JSON.stringify(resp));
            if (resp?.ok) resolve(resp); else reject(new Error(resp?.error || 'download failed'));
          }
        );
      });
    } catch (e) {
      console.warn('[FB Catch] exportData offscreen failed, fallback to <a>:', e.message);
      const blob = new Blob([content], { type: mimeType });
      const fallbackUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = fallbackUrl; a.download = filename.split('/').pop();
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(fallbackUrl);
    }
  }

  /**
   * 將留言陣列轉為 CSV（含 depth 縮排）
   * @param {Array} comments
   * @returns {string}
   */
  function convertToCsv(comments) {
    if (!Array.isArray(comments) || comments.length === 0) return '';

    const headers = ['id', 'parentId', 'depth', 'path', 'author', 'timestamp', 'likes', 'text'];
    const rows = [headers.join(',')];

    for (const c of comments) {
      const indent = c.depth > 0 ? '  '.repeat(c.depth) + '\u21B3 ' : '';
      const escapedText = `"${indent}${(c.text || '').replace(/"/g, '""')}"`;
      rows.push([
        c.id || '',
        c.parentId || '',
        c.depth || 0,
        c.path || '',
        `"${(c.author?.name || '').replace(/"/g, '""')}"`,
        c.timestamp || '',
        c.likes || 0,
        escapedText
      ].join(','));
    }

    return rows.join('\n');
  }

  // ─── Phase 9: 狀態推送（content → background → popup）──
  let _statusStartTime = null;
  let _lastStatusEmit = 0;
  function _emitStatus(phase, action, progress) {
    // 節流：≥500ms 間隔才發送（idle/done/error 不節流）
    const now = Date.now();
    if (phase !== 'idle' && phase !== 'done' && phase !== 'error' && now - _lastStatusEmit < 500) return;
    _lastStatusEmit = now;
    try {
      chrome.runtime.sendMessage({
        type: 'STATUS_UPDATE',
        status: {
          phase,
          action: action || '',
          progress: progress || { posts: null, comments: null, media: null },
          startTime: _statusStartTime,
          error: phase === 'error' ? (action || 'Unknown error') : null
        }
      });
    } catch (_) {} // popup 或 SW 可能沒在聯
    // 同步更新頁面內迷你泡泡
    _updateMiniBubble(phase, action, progress);
  }

  // ─── Phase 9: 迷你進度泡泡（頁面右上角自動浮現）──────
  let _miniBubble = null;
  let _miniBubbleTimer = null;
  let _miniBubbleElapsedTimer = null;

  function _ensureMiniBubble() {
    if (_miniBubble) return _miniBubble;
    // 注入 CSS
    if (!document.getElementById('fbt-mini-bubble-css')) {
      const css = document.createElement('style');
      css.id = 'fbt-mini-bubble-css';
      css.textContent = `
        #fbt-mini-bubble {
          position: fixed; top: 12px; right: 12px; z-index: 2147483646;
          background: #1a1a2e; color: #e0e0e0; border: 1px solid #333;
          border-radius: 10px; padding: 10px 14px; min-width: 200px; max-width: 280px;
          font-family: system-ui, -apple-system, sans-serif; font-size: 12px;
          box-shadow: 0 4px 20px rgba(0,0,0,0.5);
          opacity: 0; transform: translateY(-10px);
          transition: opacity 0.3s, transform 0.3s;
          pointer-events: none; cursor: grab; user-select: none;
        }
        #fbt-mini-bubble.dragging { cursor: grabbing; transition: opacity 0.3s; }
        #fbt-mini-bubble.visible { opacity: 1; transform: translateY(0); pointer-events: auto; }
        #fbt-mini-bubble .mb-header { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
        #fbt-mini-bubble .mb-pulse { width: 8px; height: 8px; border-radius: 50%; background: #22c55e;
          animation: fbt-pulse 1.5s ease-in-out infinite; flex-shrink: 0; }
        #fbt-mini-bubble .mb-action { color: #4a9eff; font-weight: 600; font-size: 12px; }
        #fbt-mini-bubble .mb-bar-track { width: 100%; height: 4px; background: #12122a;
          border-radius: 2px; overflow: hidden; margin: 4px 0; }
        #fbt-mini-bubble .mb-bar-fill { height: 100%; background: linear-gradient(90deg, #4a9eff, #22c55e);
          border-radius: 2px; transition: width 0.3s; width: 0%; }
        #fbt-mini-bubble .mb-info { display: flex; justify-content: space-between;
          font-size: 10px; color: #888; }
        #fbt-mini-bubble .mb-close { position: absolute; top: 4px; right: 8px;
          background: none; border: none; color: #666; font-size: 14px; cursor: pointer; padding: 2px; }
        #fbt-mini-bubble .mb-close:hover { color: #fff; }
      `;
      document.head.appendChild(css);
    }
    const el = document.createElement('div');
    el.id = 'fbt-mini-bubble';
    el.innerHTML = `
      <button class="mb-close" title="關閉">✕</button>
      <div class="mb-header">
        <span class="mb-pulse"></span>
        <span class="mb-action">—</span>
      </div>
      <div class="mb-bar-track"><div class="mb-bar-fill"></div></div>
      <div class="mb-info"><span class="mb-pct">—</span><span class="mb-elapsed">⏱ --:--</span></div>
    `;
    el.querySelector('.mb-close').onclick = () => { el.classList.remove('visible'); };

    // 拖曳支援
    let _mbDragging = false, _mbShiftX = 0, _mbShiftY = 0, _mbHasMoved = false;
    el.addEventListener('mousedown', (e) => {
      if (e.target.closest('.mb-close')) return; // 不攔截關閉鈕
      _mbDragging = true; _mbHasMoved = false;
      _mbShiftX = e.clientX - el.getBoundingClientRect().left;
      _mbShiftY = e.clientY - el.getBoundingClientRect().top;
      el.classList.add('dragging');
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!_mbDragging) return;
      _mbHasMoved = true;
      el.style.left = (e.clientX - _mbShiftX) + 'px';
      el.style.top = (e.clientY - _mbShiftY) + 'px';
      el.style.right = 'auto'; // 解除 right:12px 定位，改用 left
    });
    document.addEventListener('mouseup', () => {
      if (!_mbDragging) return;
      _mbDragging = false;
      el.classList.remove('dragging');
    });

    document.body.appendChild(el);
    _miniBubble = el;
    return el;
  }

  function _updateMiniBubble(phase, action, progress) {
    const isActive = phase === 'scanning' || phase === 'downloading' || phase === 'exporting';
    const isDone = phase === 'done';

    if (!isActive && !isDone) {
      // idle / error → 隱藏
      if (_miniBubble) _miniBubble.classList.remove('visible');
      clearInterval(_miniBubbleElapsedTimer);
      _miniBubbleElapsedTimer = null;
      clearTimeout(_miniBubbleTimer);
      return;
    }

    const el = _ensureMiniBubble();

    if (isDone) {
      // 完成 → 短暫顯示後隱藏
      el.querySelector('.mb-action').textContent = '✅ ' + (action || '完成');
      el.querySelector('.mb-bar-fill').style.width = '100%';
      el.querySelector('.mb-pct').textContent = '100%';
      el.querySelector('.mb-pulse').style.animation = 'none';
      el.classList.add('visible');
      clearInterval(_miniBubbleElapsedTimer);
      _miniBubbleElapsedTimer = null;
      clearTimeout(_miniBubbleTimer);
      _miniBubbleTimer = setTimeout(() => { el.classList.remove('visible'); }, 3000);
      return;
    }

    // active → 顯示進度
    el.classList.add('visible');
    clearTimeout(_miniBubbleTimer);
    el.querySelector('.mb-action').textContent = action || phase;
    el.querySelector('.mb-pulse').style.animation = 'fbt-pulse 1.5s ease-in-out infinite';

    const pct = progress?.posts?.pct ?? progress?.comments?.pct ?? progress?.media?.pct ?? 0;
    el.querySelector('.mb-bar-fill').style.width = pct + '%';
    el.querySelector('.mb-pct').textContent = pct > 0 ? pct + '%' : '—';

    // 已用時間計時器
    if (!_miniBubbleElapsedTimer && _statusStartTime) {
      _miniBubbleElapsedTimer = setInterval(() => {
        if (!_statusStartTime) return;
        const secs = Math.round((Date.now() - _statusStartTime) / 1000);
        const mm = Math.floor(secs / 60), ss = secs % 60;
        const elapsedEl = _miniBubble?.querySelector('.mb-elapsed');
        if (elapsedEl) elapsedEl.textContent = `⏱ ${mm}:${String(ss).padStart(2, '0')}`;
      }, 1000);
    }
  }

  // ─── Dispatcher（處理 popup 訊息）─────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.action) return false;

    handleAction(message).then(sendResponse);
    return true; // 非同步回應
  });

  async function handleAction(message) {
    const { action, options = {} } = message;

    switch (action) {
      case 'getStatus': {
        // 如果 dtsg 還沒 cache，主動取一次
        if (!isDtsgValid()) await getDtsg();
        return {
          ok: true,
          platform: currentPlatform.name,
          version: VERSION,
          hasDtsg: isDtsgValid(),
          batch: batchPipeline.status(),
          requests: { count: requestCounter.getCount(), points: requestCounter.getPoints(), budget: requestCounter.budget, warningLevel: requestCounter.getWarningLevel(), atLimit: requestCounter.isAtLimit() }
        };
      }

      case 'resetCounter':
        requestCounter.reset();
        return { ok: true, requests: { count: 0, points: 0, budget: requestCounter.budget, warningLevel: 'none' } };

      case 'refreshDtsg':
        cachedDtsg = null;
        const token = await getDtsg();
        return { ok: !!token, hasDtsg: !!token };

      case 'scanPosts':
        return postsPipeline.scan(options);

      case 'downloadPosts':
        postsPipeline.download(options.posts, options.format);
        return { ok: true };

      case 'scrapeComments':
        return commentsPipeline.scrape({ ...options, sortOrder: options.sortOrder || 'all' });

      case 'scrapeCommentsFlat':
        return commentsPipeline.scrapeFlat({ ...options, sortOrder: options.sortOrder || 'all' });

      case 'batchScrapeComments':
        return batchPipeline.scrapeComments({ ...options, sortOrder: options.sortOrder || 'all' });

      case 'batchStatus':
        return batchPipeline.status();

      case 'batchPause':
        batchPipeline.pause();
        return { ok: true };

      case 'batchResume':
        batchPipeline.resume();
        return { ok: true };

      case 'batchCancel':
        batchPipeline.cancel();
        return { ok: true };

      case 'download':
        await exportData(options.data, options.format, options.filename || 'fb_export');
        return { ok: true };

      case 'scanPostsGraphQL':
        return postsPipeline.scanGraphQL(options);

      case 'downloadMediaAll':
        return downloadAllMedia(options.comments || [], options.postId || 'unknown', options.progressSource || 'comments');

      case 'downloadMediaAndEnrich':
        return downloadMediaAndEnrich(options.comments || [], options.postId || 'unknown');

      case 'downloadPostsMedia':
        return downloadPostsMedia(options.posts || [], options.username || getPageUsername() || 'unknown');

      case 'scrapeCommentsWithMedia': {
        const result = await commentsPipeline.scrape({ ...options, sortOrder: options.sortOrder || 'all' });
        if (result.error) return result;
        // 方案 B：抓完留言後立即下載附件
        const postId = options.postId || extractPostId(options.postUrl) || 'unknown';
        const mediaResult = await downloadAllMedia(result.comments, postId);
        return { ...result, media: mediaResult };
      }

      case 'batchScrapeFromProfile': {
        // 一鍵流程：GraphQL 掃貼文 → 逐篇抓留言（跳過 resolveFeedbackId）→ 下載附件
        const userId = options.userId;
        if (!userId) return { error: 'userId is required' };

        // Step 1: 掃貼文
        const postsResult = await postsPipeline.scanGraphQL({
          userId,
          count: options.postsCount || 10,
        });
        if (!postsResult.posts?.length) return { error: 'No posts found', postsResult };

        // Step 2: 逐篇抓留言（直接用 feedbackId，不需要 resolveFeedbackId）
        const sortOrder = options.sortOrder || 'all';
        const betweenDelay = getDelay('betweenPosts');
        const results = [];
        for (const post of postsResult.posts) {
          if (!post.feedbackId) continue;
          try {
            const commentsResult = await commentsPipeline.scrape({
              feedbackId: post.feedbackId,
              maxDepth: options.maxDepth || 3,
              sortOrder: options.sortOrder
            });
            // Step 3: 下載附件（如果有且用戶要求）
            let media = null;
            if (options.downloadMedia && commentsResult.comments?.length) {
              media = await downloadAllMedia(commentsResult.comments, post.id);
            }
            results.push({
              postId: post.id,
              permalink: post.permalink,
              text: post.text?.slice(0, 100),
              commentsCount: commentsResult.meta?.grandTotal || commentsResult.comments?.length || 0,
              media,
              success: true
            });
          } catch (err) {
            results.push({ postId: post.id, success: false, error: err.message });
          }
          await randomSleep(betweenDelay);
        }

        return {
          meta: {
            userId,
            postsScanned: postsResult.posts.length,
            postsWithComments: results.filter(r => r.commentsCount > 0).length,
            totalComments: results.reduce((s, r) => s + (r.commentsCount || 0), 0),
            scrapedAt: new Date().toISOString(),
            tool: 'FB Catch v' + VERSION
          },
          posts: postsResult.posts,
          results
        };
      }

      case 'togglePanel': {
        const p = document.getElementById('fb-toolkit-panel');
        if (p) {
          p.style.display = p.style.display === 'none' ? 'block' : 'none';
        }
        return { ok: true };
      }

      case 'getToolkitStatus':
        return {
          ok: true,
          phase: _statusStartTime ? 'unknown' : 'idle',
          startTime: _statusStartTime
        };

      default:
        return { ok: false, error: `Unknown action: ${action}` };
    }
  }

  // ─── window.__FB_TOOLKIT__ API（供 CDP 操控）──────────

  const toolkitAPI = {
    platform: currentPlatform.name,
    version: VERSION,

    posts: {
      scan: (options) => postsPipeline.scan(options),
      download: (posts, format) => postsPipeline.download(posts, format)
    },

    comments: {
      scrape: (options) => commentsPipeline.scrape(options),
      scrapeFlat: (options) => commentsPipeline.scrapeFlat(options)
    },

    batch: {
      scrapeComments: (options) => batchPipeline.scrapeComments(options),
      status: () => batchPipeline.status(),
      pause: () => batchPipeline.pause(),
      resume: () => batchPipeline.resume(),
      cancel: () => batchPipeline.cancel()
    },

    download: async (data, format, filename) => await exportData(data, format, filename),

    status: async () => ({
      platform: currentPlatform.name,
      version: VERSION,
      hasDtsg: isDtsgValid(),
      dtsg: isDtsgValid() ? '(cached)' : null,
      batch: batchPipeline.status()
    })
  };

  // 暴露到 window（content script 在 isolated world，需透過頁面 script 注入）
  // 由於 MV3 限制，這裡先直接設定；Phase 3 CDP 整合時再評估
  try {
    Object.defineProperty(window, '__FB_TOOLKIT__', {
      value: toolkitAPI,
      writable: false,
      configurable: false
    });
  } catch (_) {
    window.__FB_TOOLKIT__ = toolkitAPI;
  }

  // ─── 浮動面板工具函式（Phase 8b — M1/M3/M5 安全防護）──────

  /** DOM 快捷建構 */
  function _el(tag, s, p) {
    const e = document.createElement(tag);
    if (s) Object.assign(e.style, s);
    if (p) for (const [k, v] of Object.entries(p)) {
      if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else e[k] = v;
    }
    return e;
  }

  /** M1: URL 正規化（統一 m./fb.com → www.facebook.com、去追蹤參數） */
  function normalizeUrl(input) {
    if (!input || typeof input !== 'string') return null;
    let url = input.trim();
    if (!url) return null;
    if (/^(javascript|data):/i.test(url)) return null;
    // T1: 純 slug（無 / 無空白無 :）→ 自動補 facebook.com 前綴
    if (/^[a-zA-Z0-9._-]+$/.test(url)) url = 'https://www.facebook.com/' + url;
    else if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^(www\.|m\.|web\.)/, '');
      if (host !== 'facebook.com' && host !== 'fb.com') return null;
      u.hostname = 'www.facebook.com';
      ['ref', 'fref', '__tn__', '__cft__[0]', 'notif_id', 'notif_t'].forEach(p => u.searchParams.delete(p));
      return u.toString();
    } catch { return null; }
  }

  /** M5: Storage 安全寫入（每次 set 後檢查 lastError） */
  function safeStorageSet(data) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(data, () => {
        if (chrome.runtime.lastError) {
          console.error('[FB Catch] Storage error:', chrome.runtime.lastError.message);
          reject(new Error(chrome.runtime.lastError.message));
        } else resolve();
      });
    });
  }
  function safeStorageGet(keys) {
    return new Promise(resolve => {
      chrome.storage.local.get(keys, data => resolve(data || {}));
    });
  }

  /** M3: Import 檔案解析（BOM 移除 + 10MB 限制 + JSON/TXT 雙格式） */
  function parseImportFile(file) {
    return new Promise((resolve, reject) => {
      if (file.size > 10 * 1024 * 1024) return reject(new Error('檔案過大，上限 10MB'));
      const reader = new FileReader();
      reader.onload = () => {
        try {
          let text = reader.result;
          if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // BOM
          text = text.trim();
          if (text.startsWith('{')) {
            const data = JSON.parse(text);
            if (!data.targets || !Array.isArray(data.targets)) throw new Error('JSON 缺少 targets 陣列');
            resolve({
              targets: data.targets.map(t => ({ url: normalizeUrl(t.url), count: parseInt(t.count, 10) || 50, override: t.override || {} })).filter(t => t.url),
              global: data.global || {}
            });
          } else {
            const targets = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
              .map(l => { const p = l.split(/\t|,/); return { url: normalizeUrl(p[0]), count: parseInt(p[1], 10) || 50, override: {} }; })
              .filter(t => t.url);
            if (!targets.length) throw new Error('未找到有效的 Facebook URL');
            resolve({ targets, global: {} });
          }
        } catch (e) { reject(e); }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file, 'UTF-8');
    });
  }

  /** 解析目標 ID（batch 用，透過 fetch 頁面 HTML 取得 userId） */
  async function resolveTargetId(url) {
    // 社團數字 ID（URL 直取）
    const groupNum = url.match(/groups\/(\d+)/);
    if (groupNum) return { id: groupNum[1], context: 'group', name: null };
    // profile.php?id= — 不再早期返回，讓 fetch 路徑同時取得 name
    // （Phase 8e: 目錄命名需要粉專名稱，純 ID 不夠用）
    // 需要 fetch 頁面
    try {
      const resp = await fetch(url, { credentials: 'include' });
      const html = await resp.text();
      const isGroup = url.includes('/groups/');
      const context = isGroup ? 'group' : 'timeline';
      // T4: 多層 fallback 取名稱 — og:title > <title> 去除尾綴
      let name = null;
      const ogM = html.match(/<meta\s+(?:property|name)="og:title"\s+content="([^"]+)"/i)
                || html.match(/content="([^"]+)"\s+(?:property|name)="og:title"/i);
      if (ogM && ogM[1] && !_isGenericFbName(ogM[1])) {
        name = ogM[1].trim();
      } else {
        const titleM = html.match(/<title>([^<]+)<\/title>/);
        if (titleM) {
          const cleaned = titleM[1].replace(/\s*[|\-–—]\s*(Facebook|首頁|Home).*$/i, '').trim();
          if (cleaned && !_isGenericFbName(cleaned)) name = cleaned;
        }
      }
      if (isGroup) {
        const gid = html.match(/"groupID":"(\d+)"/);
        if (gid) return { id: gid[1], context: 'group', name };
      }
      // 多模式匹配：涵蓋粉專/個人/各種 Facebook HTML 結構
      const idPatterns = [
        /"userID":"(\d+)"/,
        /"profile_owner":\s*\{[^}]*"id":"(\d+)"/,
        /"entity_id":"(\d+)"/,
        /"pageID":"(\d+)"/,
        /"ownerID":"(\d+)"/,
        /"actorID":"(\d+)"/,
        /content="fb:\/\/(?:page|profile)\/(\d+)"/,
        /"__isProfile":"Page","id":"(\d+)"/,
        /"page_id":"(\d+)"/
      ];
      for (const pat of idPatterns) {
        const m = html.match(pat);
        if (m) return { id: m[1], context, name };
      }
      return { id: null, context, name, error: '無法偵測頁面 ID' };
    } catch (e) {
      return { id: null, context: 'timeline', name: null, error: e.message };
    }
  }

  /** 貼文篩選（filterMode: and=全部達標, or=任一達標） */
  function filterPosts(posts, settings) {
    const { minLikes, minComments, minShares, filterMode, resultLimit } = settings;
    let out = posts;
    if (minLikes || minComments || minShares) {
      out = posts.filter(p => {
        const c = [];
        if (minLikes) c.push((p.likes || 0) >= minLikes);
        if (minComments) c.push((p.commentCount || 0) >= minComments);
        if (minShares) c.push((p.shares || 0) >= minShares);
        return filterMode === 'or' ? c.some(Boolean) : c.every(Boolean);
      });
    }
    return resultLimit > 0 ? out.slice(0, resultLimit) : out;
  }

  const PANEL_DEFAULTS = { dateFrom: '', dateTo: '', minLikes: '', minComments: '', minShares: '', filterMode: 'and', resultLimit: '', formats: ['json'] };
  const STORAGE_KEY = { settings: 'fbt_settings', results: 'fbt_results' };

  // ─── 浮動球 + 面板（Phase 8a/8b — 參考 Threads Insight v1.8）──

  function createFloatingBall() {
    if (document.getElementById('fb-toolkit-ball')) return;

    const ball = document.createElement('div');
    ball.id = 'fb-toolkit-ball';

    Object.assign(ball.style, {
      position: 'fixed',
      top: '70px',
      right: '20px',
      width: '48px',
      height: '48px',
      backgroundImage: `url(${chrome.runtime.getURL('icons/icon48.png')})`,
      backgroundSize: 'contain',
      backgroundRepeat: 'no-repeat',
      backgroundPosition: 'center',
      cursor: 'grab',
      zIndex: '2147483647',
      userSelect: 'none',
      filter: 'drop-shadow(0 4px 6px rgba(0,0,0,0.4))',
      transition: 'transform 0.1s'
    });

    ball.onmouseover = () => { ball.style.transform = 'scale(1.1)'; };
    ball.onmouseout = () => { ball.style.transform = 'scale(1)'; };

    let isDragging = false;
    let hasMoved = false;

    function updatePanelPosition() {
      const panel = document.getElementById('fb-toolkit-panel');
      if (!panel) return;
      const ballRect = ball.getBoundingClientRect();
      panel.style.top = (ballRect.bottom + 10) + 'px';
      const ballCenter = ballRect.left + ballRect.width / 2;
      if (ballCenter > window.innerWidth / 2) {
        panel.style.left = 'auto';
        panel.style.right = (window.innerWidth - ballRect.right) + 'px';
      } else {
        panel.style.right = 'auto';
        panel.style.left = ballRect.left + 'px';
      }
    }

    ball.addEventListener('mousedown', (e) => {
      isDragging = true;
      hasMoved = false;
      ball.style.cursor = 'grabbing';

      const rect = ball.getBoundingClientRect();
      const shiftX = e.clientX - rect.left;
      const shiftY = e.clientY - rect.top;

      ball.style.right = 'auto';
      ball.style.left = rect.left + 'px';
      ball.style.top = rect.top + 'px';

      function onMouseMove(event) {
        if (!isDragging) return;
        hasMoved = true;
        ball.style.left = (event.clientX - shiftX) + 'px';
        ball.style.top = (event.clientY - shiftY) + 'px';
        const panel = document.getElementById('fb-toolkit-panel');
        if (panel && panel.style.display !== 'none') updatePanelPosition();
      }

      function onMouseUp() {
        isDragging = false;
        ball.style.cursor = 'grab';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      }

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    ball.addEventListener('click', () => {
      if (!hasMoved) {
        const panel = document.getElementById('fb-toolkit-panel');
        if (panel) {
          if (panel.style.display === 'none') {
            panel.style.display = 'block';
            updatePanelPosition();
          } else {
            panel.style.display = 'none';
          }
        }
      }
    });

    ball.ondragstart = () => false;
    document.body.appendChild(ball);
  }

  function createFloatingPanel() {
    if (document.getElementById('fb-toolkit-panel')) return;

    // ── Refs ──
    let pctEl, barEl, detailEl, subEl, matchEl, treeEl, statsEl, estEl;
    let dateFromInput, dateToInput, minLikesInput, minCommentsInput, minSharesInput;
    let resultLimitInput, urlListEl;
    const formatChecks = {};
    let scanAbort = false;
    let panelResults = null;

    // ── Panel container ──
    const panel = _el('div', {
      position: 'fixed', top: '80px', right: '20px', width: '400px',
      maxWidth: 'calc(100vw - 40px)', backgroundColor: '#1a1a2e', color: '#e0e0e0',
      borderRadius: '12px', zIndex: '2147483647', border: '1px solid #333',
      boxShadow: '0 8px 32px rgba(0,0,0,0.6)', fontFamily: 'system-ui,-apple-system,sans-serif',
      fontSize: '13px', display: 'none', maxHeight: '85vh', overflow: 'hidden'
    }, { id: 'fb-toolkit-panel' });

    // ── Header ──
    const hdr = _el('div', { padding: '14px 16px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' });
    hdr.appendChild(_el('div', { fontWeight: 'bold', color: '#4a9eff', fontSize: '15px' }, { text: 'FB Catch' }));
    const closeBtn = _el('button', { background: 'none', border: 'none', color: '#888', fontSize: '16px', cursor: 'pointer', padding: '4px 8px', borderRadius: '4px' }, { text: '✕' });
    closeBtn.onmouseover = () => { closeBtn.style.color = '#fff'; };
    closeBtn.onmouseout = () => { closeBtn.style.color = '#888'; };
    closeBtn.onclick = () => { panel.style.display = 'none'; };
    hdr.appendChild(closeBtn);
    panel.appendChild(hdr);

    // ── State Nav ──
    const nav = _el('div', { display: 'flex', gap: '4px', padding: '12px 16px 0' });
    const navBtns = [];
    ['① 設定條件', '② 掃描中', '③ 結果勾選'].forEach((label, i) => {
      const b = _el('button', {
        flex: '1', padding: '6px 4px', borderRadius: '6px',
        border: '1px solid ' + (i === 0 ? '#4a9eff' : '#333'),
        background: i === 0 ? '#4a9eff' : '#12122a',
        color: i === 0 ? '#fff' : '#888',
        fontSize: '11px', fontWeight: '600', cursor: 'pointer', transition: '0.15s'
      }, { text: label });
      b.onclick = () => switchState(i);
      navBtns.push(b);
      nav.appendChild(b);
    });
    panel.appendChild(nav);

    // ── State containers ──
    const sc = [];
    for (let i = 0; i < 3; i++) {
      const c = _el('div', { padding: '16px', display: i === 0 ? 'block' : 'none', overflowY: 'auto', maxHeight: 'calc(85vh - 80px)' });
      sc.push(c);
      panel.appendChild(c);
    }
    const [s1, s2, s3] = sc;

    // ── UI Helpers ──
    function sectionLabel(t) {
      return _el('div', { fontSize: '11px', color: '#666', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '8px', marginTop: '14px', borderBottom: '1px solid #2a2a3e', paddingBottom: '4px' }, { text: t });
    }
    function formRow(lbl, inp) {
      const r = _el('div', { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' });
      r.appendChild(_el('label', { fontSize: '12px', color: '#bbb', minWidth: '80px', flexShrink: '0' }, { text: lbl }));
      if (inp) r.appendChild(inp);
      return r;
    }
    function numInput(ph) {
      const inp = _el('input', { flex: '1', background: '#12122a', color: '#fff', border: '1px solid #444', borderRadius: '4px', padding: '5px 8px', fontSize: '12px', outline: 'none' }, { type: 'number', placeholder: ph, min: '0' });
      inp.onfocus = function () { this.style.borderColor = '#4a9eff'; };
      inp.onblur = function () { this.style.borderColor = '#444'; };
      return inp;
    }
    function dateIn() {
      return _el('input', { flex: '1', background: '#12122a', color: '#fff', border: '1px solid #444', borderRadius: '4px', padding: '5px 8px', fontSize: '12px', outline: 'none', colorScheme: 'dark' }, { type: 'date' });
    }
    function fmtCount(n) {
      if (n >= 10000) return (n / 10000).toFixed(1) + '萬';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
      return String(n);
    }

    // ═══════════════════════════════════════════════════════════
    // State 1: 設定條件
    // ═══════════════════════════════════════════════════════════

    // Location + 重新偵測按鈕
    const locRow = _el('div', { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' });
    const locEl = _el('div', { flex: '1', background: '#12122a', padding: '8px 12px', borderRadius: '8px', fontSize: '12px', color: '#aaa' });
    function refreshLocation() {
      const name = getPageDisplayName() || window.location.pathname.replace(/^\//, '') || '未知';
      locEl.innerHTML = '📍 目前位置：<strong style="color:#4a9eff">' + name + '</strong>';
      // 同步更新第一列 URL
      const firstUrlInput = urlListEl?.querySelector('input[type="text"]');
      if (firstUrlInput && urlListEl.children.length === 1) {
        firstUrlInput.value = window.location.href;
      }
    }
    refreshLocation();
    const refreshBtn = _el('button', { background: 'none', border: '1px solid #444', color: '#aaa', padding: '4px 8px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: '0' }, { text: '🔄 重新偵測' });
    refreshBtn.onclick = () => { refreshLocation(); refreshBtn.style.color = '#22c55e'; setTimeout(() => { refreshBtn.style.color = '#aaa'; }, 1000); };
    locRow.append(locEl, refreshBtn);
    s1.appendChild(locRow);

    // ── URL Input Area ──
    const inputArea = _el('div', { background: '#12122a', border: '1px solid #333', borderRadius: '8px', padding: '10px 12px', marginBottom: '14px' });
    const ihdr = _el('div', { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' });
    const batchBadge = _el('span', { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', fontWeight: '700', color: '#555', background: 'transparent', border: '1px solid #333', borderRadius: '4px', padding: '2px 8px' });
    const batchChk = _el('input', { accentColor: '#f59e0b', width: '14px', height: '14px', pointerEvents: 'none' }, { type: 'checkbox', disabled: true });
    batchBadge.append(batchChk, _el('span', {}, { text: 'BATCH' }));
    ihdr.appendChild(batchBadge);
    ihdr.appendChild(_el('span', { fontSize: '11px', color: '#666' }, { text: '目標網址' }));
    const importBtn = _el('button', { marginLeft: 'auto', background: 'none', border: '1px solid #444', color: '#aaa', padding: '3px 10px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer' }, { text: '📂 Import' });
    const fileIn = _el('input', { display: 'none' }, { type: 'file' });
    fileIn.accept = '.json,.txt,.csv';
    importBtn.onclick = () => fileIn.click();
    fileIn.onchange = handleImport;
    ihdr.append(importBtn, fileIn);
    inputArea.appendChild(ihdr);

    urlListEl = _el('div', {});
    function addUrlRow(url, count) {
      const r = _el('div', { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' });
      const ui = _el('input', { flex: '1', background: '#0d0d1a', color: '#fff', border: '1px solid #444', borderRadius: '4px', padding: '6px 8px', fontSize: '12px', minWidth: '0', outline: 'none' }, { type: 'text', placeholder: '粉專名稱 或 完整 URL', value: url || '' });
      ui.onfocus = function () { this.select(); this.style.borderColor = '#4a9eff'; };
      ui.onblur = function () { this.style.borderColor = '#444'; };
      const ci = _el('input', { width: '55px', background: '#0d0d1a', color: '#fff', border: '1px solid #444', borderRadius: '4px', padding: '6px 4px', fontSize: '12px', textAlign: 'center' }, { type: 'number', value: String(count || 50), min: '1', max: '500' });
      ci.onchange = updateEstimate;
      const rb = _el('button', { background: 'none', border: 'none', color: '#555', fontSize: '14px', cursor: 'pointer', padding: '0 4px' }, { text: '✕' });
      rb.onmouseover = () => { rb.style.color = '#ff4444'; };
      rb.onmouseout = () => { rb.style.color = '#555'; };
      rb.onclick = () => { if (urlListEl.children.length > 1) { r.remove(); updateBatch(); } };
      r.append(ui, ci, _el('span', { fontSize: '10px', color: '#666', whiteSpace: 'nowrap' }, { text: '篇' }), rb);
      urlListEl.appendChild(r);
      updateBatch();
    }
    addUrlRow(window.location.href, 50);
    inputArea.appendChild(urlListEl);
    const addUrlBtn = _el('button', { background: 'none', border: '1px dashed #444', color: '#666', padding: '5px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer', width: '100%', textAlign: 'center', marginTop: '4px' }, { text: '+ 新增網址' });
    addUrlBtn.onclick = () => { addUrlRow('', 50); const last = urlListEl.lastElementChild; if (last) last.querySelector('input[type="text"]').focus(); };
    inputArea.appendChild(addUrlBtn);
    s1.appendChild(inputArea);

    function updateBatch() {
      const on = urlListEl.children.length >= 2;
      Object.assign(batchBadge.style, on ? { color: '#f59e0b', background: 'rgba(245,158,11,0.12)', borderColor: 'rgba(245,158,11,0.3)' } : { color: '#555', background: 'transparent', borderColor: '#333' });
      batchChk.checked = on;
      updateEstimate();
    }

    // ── Filters ──
    s1.appendChild(sectionLabel('篩選條件'));
    s1.appendChild(formRow('日期範圍'));
    const drow = _el('div', { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' });
    dateFromInput = dateIn(); dateToInput = dateIn();
    // T2: 日期 smart default — 觸碰才填預設值
    dateFromInput.addEventListener('focus', function () { if (!this.value) this.value = new Date().toISOString().slice(0, 10); });
    dateToInput.addEventListener('focus', function () { if (!this.value) this.value = dateFromInput.value || new Date().toISOString().slice(0, 10); });
    const dateResetBtn = _el('button', { background: 'none', border: 'none', color: '#666', fontSize: '13px', cursor: 'pointer', padding: '2px 4px', flexShrink: '0' }, { text: '🔄' });
    dateResetBtn.title = '重設日期';
    dateResetBtn.onclick = () => { dateFromInput.value = ''; dateToInput.value = ''; };
    drow.append(dateFromInput, _el('span', { color: '#666', fontSize: '12px' }, { text: '~' }), dateToInput, dateResetBtn);
    s1.appendChild(drow);
    // T3: 各篩選欄位獨立重設鈕
    function numInputWithReset(ph) {
      const inp = numInput(ph);
      const btn = _el('button', { background: 'none', border: 'none', color: '#666', fontSize: '13px', cursor: 'pointer', padding: '2px 4px', flexShrink: '0' }, { text: '🔄' });
      btn.title = '清空';
      btn.onclick = () => { inp.value = ''; };
      return { inp, btn };
    }
    const likesW = numInputWithReset('不限'); minLikesInput = likesW.inp;
    const likesRow = formRow('最低讚數', minLikesInput); likesRow.appendChild(likesW.btn); s1.appendChild(likesRow);
    const commentsW = numInputWithReset('不限'); minCommentsInput = commentsW.inp;
    const commentsRow = formRow('最低評論數', minCommentsInput); commentsRow.appendChild(commentsW.btn); s1.appendChild(commentsRow);
    const sharesW = numInputWithReset('不限'); minSharesInput = sharesW.inp;
    const sharesRow = formRow('最低分享數', minSharesInput); sharesRow.appendChild(sharesW.btn); s1.appendChild(sharesRow);

    // ── Output ──
    s1.appendChild(sectionLabel('輸出設定'));
    const rlW = numInputWithReset('不限'); resultLimitInput = rlW.inp;
    const rlRow = formRow('結果上限', resultLimitInput);
    rlRow.appendChild(_el('span', { fontSize: '11px', color: '#666' }, { text: '篇' }));
    rlRow.appendChild(rlW.btn);
    s1.appendChild(rlRow);
    s1.appendChild(formRow('存檔格式'));
    const fmtRow = _el('div', { display: 'flex', gap: '12px', marginBottom: '8px', flexWrap: 'wrap' });
    ['json', 'html', 'csv', 'txt'].forEach(fmt => {
      const lbl = _el('label', { display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: '#bbb', cursor: 'pointer' });
      const cb = _el('input', { accentColor: '#4a9eff', width: '15px', height: '15px' }, { type: 'checkbox', checked: fmt === 'json' });
      formatChecks[fmt] = cb;
      lbl.append(cb, _el('span', {}, { text: fmt.toUpperCase() }));
      fmtRow.appendChild(lbl);
    });
    const fmtResetBtn = _el('button', { background: 'none', border: 'none', color: '#666', fontSize: '13px', cursor: 'pointer', padding: '2px 4px', flexShrink: '0' }, { text: '🔄' });
    fmtResetBtn.title = '重設格式（只勾 JSON）';
    fmtResetBtn.onclick = () => { Object.entries(formatChecks).forEach(([f, cb]) => { cb.checked = f === 'json'; }); };
    fmtRow.appendChild(fmtResetBtn);
    s1.appendChild(fmtRow);

    // ── Personalize ──
    const prow = _el('div', { display: 'flex', gap: '6px', marginTop: '10px', marginBottom: '6px' });
    const ps = { flex: '1', background: '#12122a', border: '1px solid #333', color: '#888', padding: '5px 4px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer' };
    const svBtn = _el('button', { ...ps }, { text: '💾 儲存預設' }); svBtn.onclick = saveSettings;
    const ldBtn = _el('button', { ...ps }, { text: '📂 載入預設' }); ldBtn.onclick = loadSettings;
    const rsBtn = _el('button', { ...ps }, { text: '🔄 恢復原廠' }); rsBtn.onclick = resetToDefaults;
    prow.append(svBtn, ldBtn, rsBtn);
    s1.appendChild(prow);

    // ── Start scan ──
    const startBtn = _el('button', { width: '100%', padding: '10px', borderRadius: '8px', border: 'none', fontWeight: '700', fontSize: '14px', cursor: 'pointer', background: '#4a9eff', color: '#fff', marginTop: '12px' }, { text: '🚀 開始掃描' });
    startBtn.onclick = startScan;
    s1.appendChild(startBtn);
    estEl = _el('div', { textAlign: 'center', fontSize: '11px', color: '#666', marginTop: '6px' });
    s1.appendChild(estEl);

    // ── Privacy disclosure (CWS prominent disclosure requirement) ──
    const disclosureEl = _el('div', {
      textAlign: 'center', fontSize: '10px', color: '#555',
      marginTop: '14px', paddingTop: '10px', borderTop: '1px solid #2a2a3e'
    }, { text: 'All data is processed locally in your browser. Nothing is uploaded to any server.' });
    s1.appendChild(disclosureEl);

    // ═══════════════════════════════════════════════════════════
    // State 2: 掃描中
    // ═══════════════════════════════════════════════════════════
    const progSec = _el('div', { textAlign: 'center', padding: '16px 0' });
    pctEl = _el('div', { fontSize: '32px', fontWeight: 'bold', color: '#4a9eff' }, { text: '0%' });
    const barOuter = _el('div', { width: '100%', height: '8px', background: '#12122a', borderRadius: '4px', margin: '12px 0', overflow: 'hidden' });
    barEl = _el('div', { height: '100%', background: 'linear-gradient(90deg,#4a9eff,#22c55e)', borderRadius: '4px', transition: 'width 0.3s', width: '0%' });
    barOuter.appendChild(barEl);
    detailEl = _el('div', { fontSize: '12px', color: '#aaa', marginTop: '4px' }, { text: '準備中...' });
    subEl = _el('div', { fontSize: '11px', color: '#666', marginTop: '6px' });
    matchEl = _el('div', { fontSize: '14px', color: '#22c55e', marginTop: '10px', fontWeight: '600' }, { text: '符合條件：0 篇' });
    // Phase 8e: Heartbeat 脈搏指示器
    const heartbeatEl = _el('div', { fontSize: '11px', color: '#888', marginTop: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' });
    const pulseEl = _el('span', { display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: '#22c55e' });
    const hbTextEl = _el('span', {}, { text: '' });
    heartbeatEl.append(pulseEl, hbTextEl);
    let _hbInterval = null, _hbStart = null, _hbPhase = '';
    // State 3 heartbeat 元素（稍後建立，先宣告讓 start/stop 不炸）
    let hb3El = null, pulse3 = null, hb3Text = null;
    function startHeartbeat(phase) {
      _hbPhase = phase; _hbStart = Date.now();
      // 確保 CSS 動畫存在
      if (!document.getElementById('fbt-pulse-css')) {
        const css = document.createElement('style');
        css.id = 'fbt-pulse-css';
        css.textContent = '@keyframes fbt-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.3;transform:scale(0.6)}}';
        document.head.appendChild(css);
      }
      // 同時啟動 State 2 + State 3 的 heartbeat（hb3El 可能尚未建立）
      [heartbeatEl, hb3El].forEach(el => { if (el) el.style.display = 'flex'; });
      [pulseEl, pulse3].forEach(p => { if (p) { p.style.animation = 'none'; p.offsetHeight; p.style.animation = 'fbt-pulse 1.5s ease-in-out infinite'; } });
      clearInterval(_hbInterval);
      _hbInterval = setInterval(() => {
        const secs = Math.round((Date.now() - _hbStart) / 1000);
        const mm = Math.floor(secs / 60), ss = secs % 60;
        const txt = `${_hbPhase} · 已經過 ${mm}:${String(ss).padStart(2, '0')}`;
        hbTextEl.textContent = txt;
        if (hb3Text) hb3Text.textContent = txt;
      }, 1000);
    }
    function stopHeartbeat() {
      clearInterval(_hbInterval); _hbInterval = null;
      [heartbeatEl, hb3El].forEach(el => { if (el) el.style.display = 'none'; });
      [pulseEl, pulse3].forEach(p => { if (p) p.style.animation = 'none'; });
    }
    stopHeartbeat(); // 初始隱藏

    progSec.append(pctEl, barOuter, detailEl, subEl, matchEl, heartbeatEl);
    s2.appendChild(progSec);
    s2.appendChild(_el('div', { fontSize: '11px', color: '#f59e0b', marginTop: '8px', textAlign: 'center' }, { text: '⚠️ 掃描進行中，請勿離開此頁面' }));
    const stopBtn = _el('button', { width: '100%', padding: '10px', borderRadius: '8px', border: 'none', fontWeight: '700', fontSize: '14px', cursor: 'pointer', background: '#ff4444', color: '#fff', marginTop: '12px' }, { text: '🛑 停止掃描' });
    stopBtn.onclick = stopScan;
    s2.appendChild(stopBtn);

    // ═══════════════════════════════════════════════════════════
    // State 3: 結果勾選
    // ═══════════════════════════════════════════════════════════
    const resHdr = _el('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' });
    const resCount = _el('div', { fontSize: '13px', color: '#22c55e', fontWeight: '600' }, { text: '✅ 掃描完成' });
    const rescanBtn = _el('button', { background: 'none', border: '1px solid #444', color: '#aaa', padding: '4px 10px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer' }, { text: '↩ 重新掃描' });
    rescanBtn.onclick = () => switchState(0);
    resHdr.append(resCount, rescanBtn);
    s3.appendChild(resHdr);

    // Batch select header
    const batchHdr = _el('div', { background: '#16162b', border: '1px solid #333', borderRadius: '8px 8px 0 0', padding: '8px 10px', display: 'grid', gridTemplateColumns: '1fr repeat(4, 44px)', alignItems: 'center', gap: '2px', position: 'sticky', top: '0', zIndex: '10' });
    batchHdr.appendChild(_el('div', { fontSize: '11px', color: '#aaa', fontWeight: '600' }, { text: '批量全選' }));
    const selAllCbs = [];
    ['貼文', '貼文\n+媒體', '評論', '評論\n+媒體'].forEach((label, ci) => {
      const col = _el('div', { textAlign: 'center' });
      const cb = _el('input', { width: '15px', height: '15px', cursor: 'pointer', margin: '0 auto', display: 'block', accentColor: '#4a9eff' }, { type: 'checkbox' });
      cb.onchange = () => toggleAllCol(ci, cb.checked);
      selAllCbs.push(cb);
      col.append(cb, _el('div', { fontSize: '9px', color: '#888', textAlign: 'center', lineHeight: '1.2', whiteSpace: 'pre-line' }, { text: label }));
      batchHdr.appendChild(col);
    });
    s3.appendChild(batchHdr);

    treeEl = _el('div', { maxHeight: '300px', overflowY: 'auto', border: '1px solid #333', borderTop: 'none', borderRadius: '0 0 8px 8px', scrollbarWidth: 'thin', scrollbarColor: '#444 #12122a' });
    s3.appendChild(treeEl);

    const exFooter = _el('div', { marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #333' });
    statsEl = _el('div', { fontSize: '11px', color: '#aaa', marginBottom: '8px', lineHeight: '1.6' }, { text: '已勾選：0 篇' });
    const execBtn = _el('button', { width: '100%', padding: '10px', borderRadius: '8px', border: 'none', fontWeight: '700', fontSize: '14px', cursor: 'pointer', background: '#22c55e', color: '#fff' }, { text: '✅ 確認執行' });
    execBtn.onclick = executeSelected;
    // 批量下載提示 + 設定引導
    const dlTip = _el('div', { fontSize: '10px', color: '#f59e0b', marginTop: '8px', lineHeight: '1.6', background: 'rgba(245,158,11,0.08)', padding: '8px', borderRadius: '6px', border: '1px solid rgba(245,158,11,0.2)' });
    dlTip.innerHTML = '⚠️ 批量下載前，請先<b>關閉</b> Chrome 的「下載前詢問儲存位置」設定，否則每個檔案都會跳出對話框。<br>關閉後，檔案會自動存入 <b>下載/{粉專名}/{日期}/</b> 目錄。';
    const dlSettingsBtn = _el('button', { background: 'none', border: '1px solid rgba(245,158,11,0.4)', color: '#f59e0b', padding: '4px 10px', borderRadius: '4px', fontSize: '10px', cursor: 'pointer', marginTop: '6px' }, { text: '⚙️ 開啟 Chrome 下載設定' });
    dlSettingsBtn.onclick = () => { chrome.runtime.sendMessage({ action: 'openDownloadSettings' }); };
    dlTip.appendChild(dlSettingsBtn);
    // Phase 8e: State 3 也放 heartbeat（確認執行時可見）— 變數已在上方 let 宣告
    hb3El = _el('div', { fontSize: '11px', color: '#888', marginTop: '8px', display: 'none', alignItems: 'center', justifyContent: 'center', gap: '6px' });
    pulse3 = _el('span', { display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: '#22c55e' });
    hb3Text = _el('span', {}, { text: '' });
    hb3El.append(pulse3, hb3Text);

    exFooter.append(statsEl, execBtn, hb3El, dlTip);
    s3.appendChild(exFooter);

    // ═══════════════════════════════════════════════════════════
    // Logic
    // ═══════════════════════════════════════════════════════════

    function switchState(idx) {
      sc.forEach((c, i) => { c.style.display = i === idx ? 'block' : 'none'; });
      navBtns.forEach((b, i) => {
        Object.assign(b.style, i === idx ? { background: '#4a9eff', color: '#fff', borderColor: '#4a9eff' } : { background: '#12122a', color: '#888', borderColor: '#333' });
      });
    }

    function collectTargets() {
      const out = [];
      for (const row of urlListEl.children) {
        const u = row.querySelector('input[type="text"]');
        const c = row.querySelector('input[type="number"]');
        const url = normalizeUrl(u?.value);
        if (url) out.push({ url, count: parseInt(c?.value, 10) || 50 });
      }
      return out;
    }

    function collectSettings() {
      return {
        dateFrom: dateFromInput.value || null,
        dateTo: dateToInput.value || null,
        minLikes: parseInt(minLikesInput.value, 10) || 0,
        minComments: parseInt(minCommentsInput.value, 10) || 0,
        minShares: parseInt(minSharesInput.value, 10) || 0,
        filterMode: 'and',
        resultLimit: parseInt(resultLimitInput.value, 10) || 0,
        formats: Object.entries(formatChecks).filter(([, cb]) => cb.checked).map(([f]) => f)
      };
    }

    function updateEstimate() {
      const targets = collectTargets();
      const total = targets.reduce((s, t) => s + t.count, 0);
      // 預估：每篇 ~5.5s 平均延遲 + 來源切換 ~10s + 20% buffer
      const secs = Math.round((total * 5.5 + targets.length * 10) * 1.2);
      if (estEl) estEl.textContent = total > 0
        ? '預估時間：約 ' + Math.floor(secs / 60) + ' 分 ' + (secs % 60) + ' 秒（' + targets.length + ' 來源 × 共 ' + total + ' 篇）'
        : '';
    }

    async function startScan() {
      const targets = collectTargets();
      if (!targets.length) { alert('請輸入至少一個有效的 Facebook URL'); return; }
      const settings = collectSettings();
      scanAbort = false;
      scanRateLimiter.reset(); // T8-lite: 重設節流器
      // Phase 8e: 建立 ScanLogger（跨 startScan→executeSelected 存活）
      _activeScanLogger = new ScanLogger(new Date());
      switchState(1);
      startHeartbeat('掃描貼文中');
      _statusStartTime = Date.now();
      _emitStatus('scanning', '掃描貼文中');
      try {
      pctEl.textContent = '0%'; barEl.style.width = '0%';
      detailEl.textContent = '準備中...'; subEl.textContent = ''; matchEl.textContent = '符合條件：0 篇';

      const onBU = (e) => { e.preventDefault(); e.returnValue = ''; };
      window.addEventListener('beforeunload', onBU);

      // T6: Batch 模式下隨機打亂來源順序
      if (targets.length >= 2) {
        for (let j = targets.length - 1; j > 0; j--) {
          const k = Math.floor(Math.random() * (j + 1));
          [targets[j], targets[k]] = [targets[k], targets[j]];
        }
        console.log('[FB Catch] 🔀 來源順序已隨機打亂:', targets.map(t => t.url));
      }

      const allResults = [];
      let totalScanned = 0;
      const grandTotal = targets.reduce((s, t) => s + t.count, 0);

      for (let i = 0; i < targets.length; i++) {
        if (scanAbort) break;
        const target = targets[i];
        subEl.textContent = '📍 解析目標：' + target.url;
        const resolved = await resolveTargetId(target.url);
        console.log('[FB Catch] resolveTargetId:', target.url, '→', JSON.stringify(resolved));
        if (!resolved.id) {
          allResults.push({ url: target.url, name: resolved.name || target.url, type: '未知', posts: [], error: resolved.error || '無法偵測 ID' });
          continue;
        }
        // Phase 8e fix: 不用 getPageDisplayName()（batch mode 下它讀的是當前頁面 DOM，不是目標）
        // 單一目標且用戶就在該頁時，resolved.name 從 fetch og:title 取得；多目標一律靠 URL username
        let tName = resolved.name;
        if (!tName || _isGenericFbName(tName)) {
          tName = (targets.length === 1 ? getPageDisplayName() : '') || _usernameFromUrl(target.url) || target.url;
        }
        if (_isGenericFbName(tName)) tName = _usernameFromUrl(target.url) || target.url;
        subEl.textContent = '📍 ' + tName + ' (' + (i + 1) + '/' + targets.length + ')';

        // T8-lite: 掃描前用 Token Bucket 節流
        await scanRateLimiter.acquire();

        // 重試機制：軟性限速（空回應）時最多重試 2 次，間隔遞增
        const SCAN_MAX_RETRIES = 3;
        let scanSuccess = false;
        for (let attempt = 0; attempt < SCAN_MAX_RETRIES && !scanAbort; attempt++) {
          try {
            const t0 = performance.now();
            const result = await postsPipeline.scanGraphQL({
              userId: resolved.id, feedContext: resolved.context,
              count: target.count, targetCount: target.count,
              afterTime: settings.dateFrom ? Math.floor(new Date(settings.dateFrom).getTime() / 1000) : null,
              beforeTime: settings.dateTo ? Math.floor(new Date(settings.dateTo + 'T23:59:59').getTime() / 1000) : null,
              onProgress: (p) => {
                if (scanAbort) return;
                const done = totalScanned + p.scanned;
                const pct = Math.min(100, Math.round(done / grandTotal * 100));
                pctEl.textContent = pct + '%'; barEl.style.width = pct + '%';
                detailEl.textContent = '掃描中... ' + done + ' / ' + grandTotal + ' 篇';
                _emitStatus('scanning', '掃描貼文中', { posts: { current: done, total: grandTotal, pct }, comments: null, media: null });
              }
            });
            const latencyMs = Math.round(performance.now() - t0);
            const isEmpty = !(result.posts?.length);
            // T7: AutoThrottle 回饋
            const backoffMs = scanRateLimiter.onResponse(latencyMs, isEmpty);
            if (backoffMs > 0 && attempt < SCAN_MAX_RETRIES - 1 && !scanAbort) {
              subEl.textContent = `⚠️ ${tName} 空回應，退避 ${(backoffMs / 1000).toFixed(0)}s (${attempt + 2}/${SCAN_MAX_RETRIES})...`;
              await sleep(backoffMs);
              continue; // 重試
            }
            const filtered = filterPosts(result.posts || [], settings);
            totalScanned += (result.posts || []).length;
            allResults.push({ url: target.url, name: tName, type: resolved.context === 'group' ? '社團' : '粉專', posts: filtered });
            scanSuccess = true;
            break;
          } catch (e) {
            if (attempt < SCAN_MAX_RETRIES - 1 && !scanAbort) {
              // T7: 錯誤也回饋給 AutoThrottle
              const backoffMs = scanRateLimiter.onResponse(0, true);
              const waitMs = Math.max(backoffMs, (attempt + 1) * 8000);
              subEl.textContent = `⚠️ ${tName} 回應異常，${(waitMs / 1000).toFixed(0)}s 後重試 (${attempt + 2}/${SCAN_MAX_RETRIES})...`;
              await sleep(waitMs);
            } else {
              console.error('[FB Catch] scan error after retries:', e);
              if (_activeScanLogger) _activeScanLogger.emit('RETRY_FAIL', { target: target.url, attempt: attempt + 1, error: e.message });
              allResults.push({ url: target.url, name: tName, type: '未知', posts: [], error: e.message });
            }
          }
        }
        if (scanSuccess && !scanAbort) {
          const totalMatched = allResults.reduce((s, r) => s + r.posts.length, 0);
          matchEl.textContent = '符合條件：' + totalMatched + ' 篇';
        }
        // T8-lite: 來源切換用 scanRateLimiter 的隨機延遲（取代固定 randomSleep(3000)）
        if (i < targets.length - 1 && !scanAbort) {
          subEl.textContent = '⏳ 來源切換冷卻中...'; await scanRateLimiter.switchDelay();
        }
      }

      window.removeEventListener('beforeunload', onBU);
      stopHeartbeat();
      if (scanAbort) return;

      // 掃描完畢過渡（State 2 → 顯示完成 → 1.5s 後切 State 3）
      const totalPosts = allResults.reduce((s, r) => s + r.posts.length, 0);
      panelResults = allResults;
      // Phase 9 T5: profile.php 名稱回填 — 從第一篇貼文的 actorName 更新粉專名稱
      if (panelResults) {
        for (const pr of panelResults) {
          if (/^id_\d+$/.test(pr.name) && pr.posts?.length > 0) {
            const actorName = pr.posts[0]?.author?.name;
            if (actorName && !_isGenericFbName(actorName)) {
              pr.name = actorName;
            }
          }
        }
      }
      _emitStatus('done', '掃描完畢', { posts: { current: totalPosts, total: totalPosts, pct: 100 }, comments: null, media: null });
      try { await safeStorageSet({ [STORAGE_KEY.results]: { timestamp: Date.now(), targets: allResults, settings } }); } catch (e) { console.warn('[FB Catch] save results failed:', e); }

      // 先寫 storage 再更新 UI（確保 DOM 變更不被 await 阻擋）
      pctEl.textContent = '100%'; barEl.style.width = '100%';
      detailEl.textContent = '✅ 掃描完畢！共 ' + totalPosts + ' 篇符合';
      matchEl.textContent = '符合條件：' + totalPosts + ' 篇';
      subEl.textContent = '';
      stopBtn.textContent = '📋 前往結果';
      Object.assign(stopBtn.style, { background: '#22c55e', color: '#fff' });
      stopBtn.onclick = () => switchState(2);
      // 隱藏警告文字
      const warnEl = s2.querySelector('div[style*="f59e0b"]');
      if (warnEl) warnEl.textContent = '';

      // 強制渲染 + 1.5s 可見
      await new Promise(r => requestAnimationFrame(() => setTimeout(r, 1500)));
      try {
        buildTree(allResults);
        resCount.textContent = '✅ 掃描完成：' + allResults.length + ' 來源 · ' + totalPosts + ' 篇符合';
        switchState(2);
        // 還原 stopBtn 狀態（下次掃描用）
        stopBtn.textContent = '🛑 停止掃描';
        stopBtn.style.background = '#ff4444';
        stopBtn.onclick = stopScan;
      } catch (e) {
        console.error('[FB Catch] buildTree/switchState error:', e);
        switchState(0);
        alert('結果顯示失敗：' + e.message);
      }
      } catch (e) {
        console.error('[FB Catch] startScan unexpected error:', e);
        stopHeartbeat();
        _emitStatus('error', e.message);
        switchState(0);
        alert('❌ 掃描失敗：' + e.message);
      }
    }

    function stopScan() {
      scanAbort = true;
      stopHeartbeat();
      _emitStatus('idle', '已停止');
      // 立即回到設定頁（掃描 loop 會在下個 await 自然結束）
      switchState(0);
      detailEl.textContent = '已停止';
    }

    function buildTree(data) {
      treeEl.innerHTML = '';
      panelResults = data;
      data.forEach((page, pi) => {
        // 粉專/社團列
        const pr = _el('div', { display: 'grid', gridTemplateColumns: '1fr repeat(4, 44px)', alignItems: 'center', gap: '2px', padding: '8px 10px', background: '#16162b', borderBottom: '1px solid #2a2a3e', cursor: 'pointer' });
        const pinfo = _el('div', { display: 'flex', alignItems: 'center', gap: '6px', minWidth: '0', overflow: 'hidden' });
        const togIcon = _el('span', { fontSize: '10px', color: '#666', transition: 'transform 0.2s', flexShrink: '0', width: '14px', textAlign: 'center', transform: 'rotate(90deg)' }, { text: '▶' });
        pinfo.append(togIcon,
          _el('span', { fontSize: '13px', color: '#4a9eff', fontWeight: '600', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, { text: page.name }),
          _el('span', { fontSize: '10px', color: '#666', background: '#0d0d1a', padding: '1px 6px', borderRadius: '3px', flexShrink: '0' }, { text: page.type }),
          _el('span', { fontSize: '10px', color: '#888', flexShrink: '0' }, { text: page.posts.length + ' 篇' })
        );
        pr.appendChild(pinfo);
        for (let ci = 0; ci < 4; ci++) {
          const cb = _el('input', { width: '15px', height: '15px', cursor: 'pointer', margin: '0 auto', display: 'block', accentColor: '#4a9eff' }, { type: 'checkbox' });
          cb.className = 'fbt-page-cb'; cb.dataset.page = pi; cb.dataset.col = ci;
          cb.onchange = () => { childC.querySelectorAll('.fbt-post-cb[data-col="' + ci + '"]').forEach(pcb => { pcb.checked = cb.checked; }); updateStats(); };
          pr.appendChild(cb);
        }
        treeEl.appendChild(pr);

        // 展開區
        const childC = _el('div', {});
        let expanded = true;
        pinfo.onclick = () => { expanded = !expanded; childC.style.display = expanded ? 'block' : 'none'; togIcon.style.transform = expanded ? 'rotate(90deg)' : 'rotate(0deg)'; };
        if (page.error) childC.appendChild(_el('div', { padding: '8px 10px 8px 32px', fontSize: '12px', color: '#ff4444' }, { text: '⚠️ ' + page.error }));

        // 貼文列
        page.posts.forEach((post, posti) => {
          const postr = _el('div', { display: 'grid', gridTemplateColumns: '1fr repeat(4, 44px)', alignItems: 'center', gap: '2px', padding: '8px 10px 8px 32px', borderBottom: '1px solid #1e1e36' });
          postr.onmouseover = () => { postr.style.background = '#1a1a30'; };
          postr.onmouseout = () => { postr.style.background = ''; };
          const pi2 = _el('div', { minWidth: '0' });
          pi2.appendChild(_el('div', { fontSize: '12px', color: '#ddd', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: '2px' }, { text: (posti + 1) + '. ' + (post.text || '(無文字)') }));
          const met = _el('div', { fontSize: '10px', color: '#888', display: 'flex', gap: '8px' });
          met.textContent = '❤️ ' + fmtCount(post.likes || 0) + '  💬 ' + fmtCount(post.commentCount || 0) + '  🔄 ' + fmtCount(post.shares || 0);
          pi2.appendChild(met);
          postr.appendChild(pi2);
          for (let ci = 0; ci < 4; ci++) {
            const cb = _el('input', { width: '15px', height: '15px', cursor: 'pointer', margin: '0 auto', display: 'block', accentColor: '#4a9eff' }, { type: 'checkbox' });
            cb.className = 'fbt-post-cb'; cb.dataset.page = pi; cb.dataset.post = posti; cb.dataset.col = ci;
            cb.onchange = updateStats;
            postr.appendChild(cb);
          }
          childC.appendChild(postr);
        });
        treeEl.appendChild(childC);
      });
    }

    function toggleAllCol(ci, checked) {
      treeEl.querySelectorAll('.fbt-post-cb[data-col="' + ci + '"]').forEach(cb => { cb.checked = checked; });
      treeEl.querySelectorAll('.fbt-page-cb[data-col="' + ci + '"]').forEach(cb => { cb.checked = checked; });
      updateStats();
    }

    function updateStats() {
      const counts = [0, 0, 0, 0];
      for (let ci = 0; ci < 4; ci++) treeEl.querySelectorAll('.fbt-post-cb[data-col="' + ci + '"]').forEach(cb => { if (cb.checked) counts[ci]++; });
      const labels = ['貼文', '貼文+媒體', '評論', '評論+媒體'];
      statsEl.textContent = '已勾選：' + counts.map((c, i) => c + ' 篇' + labels[i]).join(' · ');
    }

    async function executeSelected() {
      console.log('[FB Catch] executeSelected called, panelResults:', !!panelResults, panelResults?.length);
      if (!panelResults) return;
      const settings = collectSettings();
      const fmts = settings.formats.length ? settings.formats : ['json'];

      // Phase 8e: 統一 ScanContext + 按粉專分組
      const isBatch = panelResults && panelResults.length >= 2;
      const scanCtx = createScanContext(isBatch);

      // 按粉專分組勾選項目（每粉專分開存，不合併）
      const pageSelections = new Map();
      treeEl.querySelectorAll('.fbt-post-cb').forEach(cb => {
        if (!cb.checked) return;
        const pi = +cb.dataset.page, posti = +cb.dataset.post, ci = +cb.dataset.col;
        const post = panelResults[pi]?.posts?.[posti];
        if (!post) return;
        if (!pageSelections.has(pi)) {
          pageSelections.set(pi, { posts: [], postsMedia: [], comments: [], commentsMedia: [] });
        }
        const sel = pageSelections.get(pi);
        const key = ['posts', 'postsMedia', 'comments', 'commentsMedia'][ci];
        if (!sel[key].includes(post)) sel[key].push(post);
      });

      console.log('[FB Catch] executeSelected pages:', pageSelections.size, 'isBatch:', isBatch);
      startHeartbeat('匯出下載中');
      _statusStartTime = Date.now();
      _emitStatus('downloading', '匯出下載中');

      try {
        for (const [pi, sel] of pageSelections) {
          const page = panelResults[pi];
          let pageName = page?.name || getPageDisplayName();
          // Phase 8e fix: "Facebook" 不是有效粉專名，fallback 到 URL username
          if (_isGenericFbName(pageName)) {
            pageName = _usernameFromUrl(page?.url || '') || pageName || 'unknown';
          }
          const naming = { pageName, isBatch, scanContext: scanCtx };

          // 1. 匯出貼文
          if (sel.posts.length) {
            for (const fmt of fmts) await exportData(sel.posts, fmt, 'fb_posts', { ...naming, type: 'posts' });
          }
          // 2. 下載貼文+媒體
          if (sel.postsMedia.length) {
            for (const fmt of fmts) await exportData(sel.postsMedia, fmt, 'fb_posts', { ...naming, type: 'posts_media' });
            await downloadPostsMedia(sel.postsMedia, 'unknown', { pageName, isBatch, scanContext: scanCtx });
          }
          // 3. 抓評論
          if (sel.comments.length) {
            for (const post of sel.comments) {
              const fbId = post.feedbackId || post.id;
              if (!fbId) { console.warn('[FB Catch] skip comments: no feedbackId for post', post.id); continue; }
              const r = await commentsPipeline.scrape({ feedbackId: fbId, sortOrder: 'all' });
              if (r.comments) for (const fmt of fmts) await exportData(r.comments, fmt, 'fb_comments', { ...naming, type: 'comments' });
            }
          }
          // 4. 抓評論+媒體
          if (sel.commentsMedia.length) {
            for (const post of sel.commentsMedia) {
              const fbId = post.feedbackId || post.id;
              if (!fbId) { console.warn('[FB Catch] skip commentsMedia: no feedbackId for post', post.id); continue; }
              const r = await commentsPipeline.scrape({ feedbackId: fbId, sortOrder: 'all' });
              if (r.comments) {
                for (const fmt of fmts) await exportData(r.comments, fmt, 'fb_comments', { ...naming, type: 'comments_media' });
                const mediaOpts = { pageName, isBatch, scanContext: scanCtx };
                await downloadAllMedia(r.comments, post.id || 'unknown', 'comments', mediaOpts);
              }
            }
          }
        }
      } catch (e) {
        console.error('[FB Catch] executeSelected error:', e);
        stopHeartbeat();
        _emitStatus('error', e.message);
        alert('❌ 執行失敗：' + e.message);
        return;
      }

      // ── Phase 8e: 產出 log.md / index.md / top_index.md ──
      try {
        for (const [pi, sel] of pageSelections) {
          const page = panelResults[pi];
          let pageName = page?.name || getPageDisplayName();
          if (_isGenericFbName(pageName)) {
            pageName = _usernameFromUrl(page?.url || '') || pageName || 'unknown';
          }
          const safeName = _safeFilename(pageName);
          const naming = { pageName, isBatch, scanContext: scanCtx };

          // 彙整本頁產出檔案清單
          const files = [];
          const mediaMap = [];
          let totalMedia = 0;
          if (sel.posts.length) files.push({ filename: `${safeName}_${scanCtx.ts}_posts.json`, type: 'posts', count: sel.posts.length, mediaCount: 0 });
          if (sel.postsMedia.length) {
            const mc = sel.postsMedia.reduce((s, p) => s + (p.attachments?.length || 0), 0);
            files.push({ filename: `${safeName}_${scanCtx.ts}_posts_media.json`, type: 'posts_media', count: sel.postsMedia.length, mediaCount: mc });
            totalMedia += mc;
            sel.postsMedia.forEach(p => (p.attachments || []).forEach((a, i) => {
              if (a.localFile) mediaMap.push({ mediaFile: a.localFile, sourceJson: `${safeName}_${scanCtx.ts}_posts_media.json`, id: p.id });
            }));
          }
          if (sel.comments.length) files.push({ filename: `${safeName}_${scanCtx.ts}_comments.json`, type: 'comments', count: sel.comments.length, mediaCount: 0 });
          if (sel.commentsMedia.length) files.push({ filename: `${safeName}_${scanCtx.ts}_comments_media.json`, type: 'comments_media', count: sel.commentsMedia.length, mediaCount: 0 });

          // T3: _log.md
          if (_activeScanLogger) {
            const logMd = generateLogMd(_activeScanLogger, {
              targets: panelResults.map(r => ({ name: r.name, url: r.url })),
              isBatch,
            });
            await exportData(logMd, 'md_raw', `${safeName}_${scanCtx.ts}_log`, { ...naming, type: 'log' });
          }

          // T4: _index.md
          const indexMd = generateIndexMd({ ...scanCtx, safeName }, files, mediaMap);
          await exportData(indexMd, 'md_raw', `${safeName}_${scanCtx.ts}_index`, { ...naming, type: 'index' });

          // T5: _top_index.md（累積到 storage，每頁各自一份）
          try {
            const history = await appendTopIndexEntry(safeName, {
              ts: scanCtx.ts,
              mode: isBatch ? 'Batch' : '單一',
              postsCount: sel.posts.length + sel.postsMedia.length,
              commentsCount: sel.comments.length + sel.commentsMedia.length,
              mediaCount: totalMedia,
            });
            const topMd = generateTopIndexMd(safeName, history);
            // top_index 放在粉專根目錄（不含時間戳子目錄）
            const topFilename = isBatch
              ? `FBToolKit_batch_mode/${safeName}/${safeName}_top_index.md`
              : `${safeName}/${safeName}_top_index.md`;
            await new Promise((resolve, reject) => {
              chrome.runtime.sendMessage(
                { action: 'downloadContent', content: topMd, mimeType: 'text/markdown;charset=utf-8', filename: topFilename },
                (resp) => resp?.ok ? resolve(resp) : reject(new Error(resp?.error || 'download failed'))
              );
            });
          } catch (e) { console.warn('[FB Catch] top_index generation failed:', e.message); }
        }

        // logger cleanup
        if (_activeScanLogger) {
          await _activeScanLogger.flush();
          await _activeScanLogger.cleanup();
          _activeScanLogger = null;
        }
      } catch (e) {
        console.warn('[FB Catch] log/index generation failed (data export OK):', e.message);
      }

      stopHeartbeat();
      _emitStatus('done', '執行完成');
      setTimeout(() => _emitStatus('idle', ''), 3000);
      alert('✅ 執行完成！');
      switchState(0);
    }

    // ── Persistence ──
    async function saveSettings() {
      const s = collectSettings(); s.targets = collectTargets();
      try { await safeStorageSet({ [STORAGE_KEY.settings]: s }); alert('✅ 設定已儲存'); } catch (e) { alert('❌ 儲存失敗：' + e.message); }
    }
    async function loadSettings() {
      try {
        const d = await safeStorageGet(STORAGE_KEY.settings);
        const s = d[STORAGE_KEY.settings]; if (!s) return;
        if (s.dateFrom) dateFromInput.value = s.dateFrom;
        if (s.dateTo) dateToInput.value = s.dateTo;
        if (s.minLikes) minLikesInput.value = s.minLikes;
        if (s.minComments) minCommentsInput.value = s.minComments;
        if (s.minShares) minSharesInput.value = s.minShares;
        if (s.resultLimit) resultLimitInput.value = s.resultLimit;
        if (s.formats) for (const [f, cb] of Object.entries(formatChecks)) cb.checked = s.formats.includes(f);
        if (s.targets?.length) { urlListEl.innerHTML = ''; s.targets.forEach(t => addUrlRow(t.url, t.count)); }
        updateBatch();
      } catch {}
    }
    async function resetToDefaults() {
      // 檢查是否有歷史結果（記憶體或 storage）
      let hasHistory = !!panelResults;
      if (!hasHistory) {
        try {
          const d = await safeStorageGet(STORAGE_KEY.results);
          hasHistory = !!(d[STORAGE_KEY.results]?.targets?.length);
        } catch {}
      }
      if (hasHistory && !confirm('有之前掃描的歷史結果，確認清空？')) return;
      // 設定條件歸零
      dateFromInput.value = ''; dateToInput.value = '';
      minLikesInput.value = ''; minCommentsInput.value = ''; minSharesInput.value = '';
      resultLimitInput.value = '';
      for (const [f, cb] of Object.entries(formatChecks)) cb.checked = f === 'json';
      urlListEl.innerHTML = ''; addUrlRow(window.location.href, 50);
      // 掃描進度歸零
      scanAbort = false;
      pctEl.textContent = '0%'; barEl.style.width = '0%';
      detailEl.textContent = '準備中...'; subEl.textContent = '';
      matchEl.textContent = '符合條件：0 篇';
      // 結果樹 + storage 歸零
      treeEl.innerHTML = '';
      statsEl.textContent = '已勾選：0 篇';
      panelResults = null;
      try { await safeStorageSet({ [STORAGE_KEY.results]: null }); } catch {}
      // 切回設定頁
      switchState(0);
    }
    async function handleImport() {
      if (!fileIn.files[0]) return;
      try {
        const r = await parseImportFile(fileIn.files[0]);
        urlListEl.innerHTML = ''; r.targets.forEach(t => addUrlRow(t.url, t.count));
        const g = r.global;
        if (g.dateFrom) dateFromInput.value = g.dateFrom;
        if (g.dateTo) dateToInput.value = g.dateTo;
        if (g.minLikes) minLikesInput.value = g.minLikes;
        if (g.minComments) minCommentsInput.value = g.minComments;
        if (g.minShares) minSharesInput.value = g.minShares;
        if (g.resultLimit) resultLimitInput.value = g.resultLimit;
        if (g.formats) for (const [f, cb] of Object.entries(formatChecks)) cb.checked = g.formats.includes(f);
        updateBatch();
      } catch (e) { alert('❌ Import 失敗：' + e.message); }
      fileIn.value = '';
    }
    async function checkHistory() {
      try {
        const d = await safeStorageGet(STORAGE_KEY.results);
        const s = d[STORAGE_KEY.results];
        if (s?.targets?.length) {
          const mins = Math.round((Date.now() - s.timestamp) / 60000);
          if (mins < 60 && confirm('發現 ' + mins + ' 分鐘前的掃描結果（' + s.targets.reduce((a, t) => a + t.posts.length, 0) + ' 篇）。要載入嗎？')) {
            panelResults = s.targets;
            buildTree(s.targets);
            resCount.textContent = '📦 歷史結果：' + s.targets.length + ' 來源 · ' + s.targets.reduce((a, t) => a + t.posts.length, 0) + ' 篇';
            switchState(2);
          }
        }
      } catch {}
    }

    // ── Init ──
    updateEstimate();
    loadSettings().then(checkHistory);

    document.body.appendChild(panel);
  }

  // 初始化浮動面板（延遲等 DOM ready）
  setTimeout(() => {
    createFloatingBall();
    createFloatingPanel();
  }, 2000);

  // ─── Ping-Pong 就緒通知（解法 A）─────────────────────
  // content script 載入後主動通知 service worker「我好了」
  try {
    chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY', url: window.location.href });
  } catch (_) { /* 初次載入時 service worker 可能沒在聽 */ }

  // ─── SPA 路由監聽（Facebook History API）──────────────
  // Facebook 用 pushState 切換頁面，不觸發 document_idle
  // 監聽 URL 變化，重新通知 service worker
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // 重設 dtsg 快取（新頁面可能需要新的）
      cachedDtsg = null;
      dtsgTimestamp = 0;
      try {
        chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY', url: lastUrl });
      } catch (_) {}
    }
  }).observe(document, { subtree: true, childList: true });

  console.log(`[FB Catch v${VERSION}] loaded on ${currentPlatform.name}`);
})();
