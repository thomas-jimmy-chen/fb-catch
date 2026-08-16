<p align="center">
  <img src="icons/icon128.png" width="96" alt="FB Catch icon" />
</p>

<h1 align="center">FB Catch</h1>

<p align="center">
  <strong>Backup your Facebook fan pages locally — posts, comments, images, videos.</strong><br/>
  <strong>備份你的 Facebook 粉專 — 貼文、留言、圖片、影片，全部存到你的電腦。</strong>
</p>

<p align="center">
  <a href="#installation--安裝">Install</a> ·
  <a href="#features--功能">Features</a> ·
  <a href="#usage--使用方式">Usage</a> ·
  <a href="#batch-backup--批次備份">Batch</a> ·
  <a href="#api-reference--api-參考">API</a> ·
  <a href="#privacy--隱私">Privacy</a> ·
  <a href="#license--授權">License</a>
</p>

---

## Why FB Catch? | 為什麼需要 FB Catch？

Facebook doesn't offer a "download your fan page" button. Years of content with no backup plan:

Facebook 沒有「打包下載粉專」的功能。你經營了多年的粉絲專頁，但：

- Account suspended → all content gone | 帳號被停權 → 所有內容消失
- Post removed by report → no backup, no recovery | 貼文被檢舉移除 → 沒有備份就找不回來
- Want to migrate platforms → no export tool | 想轉移到其他平台 → 沒有匯出工具
- Want to analyze past performance → no structured data | 想分析過去的貼文表現 → 沒有結構化資料

**FB Catch** fills this gap. Backup posts, comments, images and videos locally in your browser. Your data never leaves your computer.

**FB Catch** 填補這個缺口。在瀏覽器本機備份粉專的貼文、留言、圖片與影片，所有資料從不離開你的電腦。

---

## Features | 功能

| Feature | Description |
|---------|-------------|
| **Page Backup / 粉專備份** | Full backup of post content, timestamps, likes/shares/comments count |
| **Comment Archival / 留言保存** | 3-level nested comments (comment → reply → reply-to-reply), preserving full conversation context |
| **Media Download / 媒體封存** | One-click download of images & videos at original resolution |
| **Batch Backup / 批次備份** | Import multiple page URLs, auto-backup with pause/resume support |
| **Multi-format Export / 多格式匯出** | JSON, CSV, Markdown — pick the format that fits your workflow |
| **Smart Pacing / 智慧節奏** | Adaptive rate control that mimics natural browsing rhythm |

### Privacy by Architecture | 隱私即架構

- **Zero servers** — no infrastructure to collect data | 零伺服器 — 不存在收集資料的基礎設施
- **Zero accounts** — no login or signup required | 零帳號 — 不需要登入或註冊
- **Zero tracking** — no analytics, no telemetry, no callbacks | 零追蹤 — 沒有遙測、沒有任何回傳
- **Source available** — audit every line of code yourself | 原始碼公開 — 你可以自行審計每一行程式碼

---

## Installation | 安裝

### Option 1: Chrome Web Store (Recommended) | 方式一：Chrome Web Store（推薦）

> *Coming soon. 上架準備中，敬請期待。*

### Option 2: Developer Mode | 方式二：開發者模式載入

1. Clone this repo | 下載或 clone 此 repo：
   ```bash
   git clone https://github.com/thomas-jimmy-chen/fb-catch.git
   ```

2. Open Chrome → `chrome://extensions/`

3. Enable **Developer mode** (top right) | 右上角開啟 **開發者模式**

4. Click **Load unpacked** → select the `fb-catch` folder | 點擊 **載入未封裝項目** → 選擇 `fb-catch` 資料夾

5. Done! FB Catch icon appears in the toolbar. | 完成！工具列出現 FB Catch 圖示。

---

## Usage | 使用方式

### Basic Backup | 基本備份

1. **Navigate to a Facebook fan page** (e.g., `facebook.com/YourPage`) | 前往你要備份的 Facebook 粉專頁面

2. **FB Catch activates automatically** — a floating ball appears at the bottom-right | FB Catch 自動啟動 — 頁面右下角出現浮動球

3. **Click the floating ball** to open the control panel | 點擊浮動球，開啟控制面板

4. **Configure backup scope** | 設定備份範圍：
   - Number of posts (default: 50) | 貼文數量（預設 50 篇）
   - Date range filter (optional) | 日期範圍篩選（選填）
   - Minimum engagement filter (optional) | 最低互動數篩選（選填）

5. **Click "Start"** to begin backup | 點擊「Start」開始備份

6. **After completion**, choose export format | 備份完成後，選擇匯出格式：
   - **JSON** — structured data for programmatic analysis | 結構化資料，適合程式分析
   - **CSV** — tabular format for Excel / Google Sheets | 表格格式，適合試算表
   - **Markdown** — human-readable, ideal for archival | 人類可讀，適合歸檔

7. Files download automatically to your computer. | 檔案自動下載到你的電腦。

### Comment Backup | 備份留言

After post backup, you can further backup comments: | 貼文備份完成後，可以進一步備份留言：

1. Select posts to backup comments for | 選取要備份留言的貼文
2. Set comment depth (up to 3 levels) | 設定留言深度（最多 3 層巢狀）
3. Execute — comments are exported alongside posts | 點擊執行，留言會連同貼文一起匯出

### Media Backup (Images & Videos) | 備份媒體（圖片 & 影片）

1. Enable "Download media" option | 勾選「下載媒體」選項
2. Images & videos download at original resolution | 圖片與影片以原始解析度下載
3. Automatically organized into `FBToolKit_batch_mode/{page_name}/media/` | 自動整理到對應資料夾

---

## Batch Backup | 批次備份

Backup multiple fan pages at once. Two import formats supported: | 一次備份多個粉專，支援兩種匯入格式：

### Plain Text (.txt)

One URL per line, optionally specify post count: | 每行一個 URL，可選擇性指定篇數：

```
# My backup list
https://www.facebook.com/PageA    20
https://www.facebook.com/PageB    10
PageC
```

- `#` lines are comments | `#` 開頭為註解
- No count specified → default 50 | 沒寫篇數 → 預設 50 篇
- Short names work too (auto-prefixed) | 只寫名稱也行（自動補前綴）

### JSON (.json) — Full Filtering | 完整篩選

```json
{
  "global": {
    "dateFrom": "2026-01-01",
    "dateTo": "2026-07-31",
    "minLikes": 10,
    "minComments": 5,
    "formats": ["json", "csv"]
  },
  "targets": [
    { "url": "PageA", "count": 20 },
    { "url": "PageB", "count": 10 }
  ]
}
```

### Filter Parameters | 篩選參數

| Parameter | Description | Default |
|-----------|-------------|---------|
| `dateFrom` | Start date (YYYY-MM-DD) / 起始日期 | No limit / 不限 |
| `dateTo` | End date (YYYY-MM-DD) / 結束日期 | No limit / 不限 |
| `minLikes` | Minimum likes / 最少按讚數 | 0 |
| `minComments` | Minimum comments / 最少留言數 | 0 |
| `minShares` | Minimum shares / 最少分享數 | 0 |
| `resultLimit` | Result limit per page / 每頁結果上限 | 0 (unlimited) |
| `formats` | Export formats / 匯出格式 | `["json"]` |

### How to Use | 使用方式

1. Prepare `.txt` or `.json` file | 準備好檔案
2. Click 📂 **Import** in the panel | 在面板中點擊 📂 Import
3. Select file — list loads into panel | 選擇檔案，清單載入面板
4. Click **Start** | 確認後點擊 Start
5. FB Catch auto-navigates each page and backs up | 自動依序瀏覽每個粉專並備份
6. Supports **pause / resume / cancel** | 支援暫停 / 續傳 / 取消

---

## Export Formats | 匯出格式

### JSON

```json
{
  "meta": {
    "source": "facebook.com/YourPage",
    "exportDate": "2026-08-16T12:00:00Z",
    "tool": "FB Catch v0.1.0",
    "postCount": 50
  },
  "posts": [
    {
      "id": "pfbid0...",
      "text": "Post content...",
      "timestamp": "2026-08-15T09:30:00Z",
      "likes": 42,
      "comments": 7,
      "shares": 3,
      "images": ["https://..."],
      "feedbackId": "..."
    }
  ]
}
```

### CSV

| id | text | timestamp | likes | comments | shares |
|----|------|-----------|-------|----------|--------|
| pfbid0... | Post content... | 2026-08-15T09:30:00Z | 42 | 7 | 3 |

### Markdown

Generates a summary report per page with post statistics, timeline, and engagement rankings.

每個粉專產生一份摘要報告，包含貼文統計、時間軸、互動排名。

---

## API Reference | API 參考

FB Catch exposes a full API at `window.__FB_TOOLKIT__` on Facebook pages, usable from DevTools Console.

FB Catch 在 Facebook 頁面的 `window.__FB_TOOLKIT__` 暴露完整 API，可在 DevTools Console 使用。

### Quick Example | 快速範例

```javascript
const tk = window.__FB_TOOLKIT__;

// Backup latest 20 posts | 備份最近 20 篇貼文
const result = await tk.posts.scanGraphQL({ targetCount: 20 });
console.log(result.posts.length, 'posts');

// Backup comments with 3-level replies | 備份留言（含 3 層回覆）
const comments = await tk.comments.scrape({
  feedbackId: result.posts[0].feedbackId,
  maxDepth: 3
});

// Download as JSON | 下載為 JSON
await tk.download(comments, 'json', 'my_backup');
```

### Full API | 完整 API

| Category | Method | Description |
|----------|--------|-------------|
| **Posts** | `posts.scan(opts)` | DOM scroll scan / DOM 捲動掃描 |
| | `posts.scanGraphQL(opts)` | GraphQL API scan (recommended) / GraphQL 掃描（推薦） |
| | `posts.download(posts, format)` | Export post data / 匯出貼文 |
| **Comments** | `comments.scrape(opts)` | Nested comment backup / 巢狀留言備份 |
| | `comments.scrapeFlat(opts)` | Flat comment backup / 扁平留言備份 |
| | `comments.scrapeWithMedia(opts)` | Comments + attachments / 留言 + 附件 |
| **Batch** | `batch.scrapeFromProfile(opts)` | One-click full backup / 一鍵完整備份 |
| | `batch.status()` | Query progress / 查詢進度 |
| | `batch.pause()` / `resume()` / `cancel()` | Control batch / 控制批次 |
| **Media** | `media.downloadAll(comments, postId)` | Download attachments / 下載附件 |
| | `media.downloadPostsMedia(posts, username)` | Download post media / 下載貼文媒體 |
| **Utility** | `status()` | Extension status / 擴充狀態 |
| | `refreshDtsg()` | Refresh token / 重新取得 token |
| | `togglePanel()` | Toggle floating panel / 切換面板 |

> Full API docs: [API.md](API.md) | 完整 API 文件：[API.md](API.md)

---

## File Structure | 檔案結構

```
fb-catch/
├── manifest.json          # Chrome Extension MV3 config / 設定檔
├── content.js             # Main logic (scan, GraphQL, batch, UI) / 主邏輯
├── background.js          # Service Worker (downloads, icon state) / 背景服務
├── injected.js            # MAIN world injection (fb_dtsg + API) / 注入層
├── offscreen.html/.js     # Offscreen document (media ops) / 離屏文件
├── icons/                 # Extension icons (16/48/128 px) / 圖示
├── LICENSE                # Source Available License v1.0
├── CONTRIBUTING.md        # Contribution guide + DCO / 貢獻指南
├── DMCA_TEMPLATE.md       # Takedown notice template / 侵權通知範本
├── privacy-policy.html    # Privacy policy (CWS compliant) / 隱私政策
├── API.md                 # API reference / API 參考
└── IMPORT_FORMAT.md       # Batch import format docs / 匯入格式說明
```

---

## Technical Details | 技術細節

### Architecture | 架構

- **Manifest V3** — latest Chrome Extension standard | 最新標準
- **Three-layer injection | 三層注入**:
  - `content.js` (ISOLATED world) — main logic, UI, data processing | 主邏輯
  - `injected.js` (MAIN world) — `fb_dtsg` token acquisition, API proxy | Token 取得
  - `background.js` (Service Worker) — download management, icon updates | 下載管理
- **GraphQL** — deep nested comment retrieval via Facebook's GraphQL API | 深度留言取得
- **DOM scanning** — automatic page scrolling and post parsing (fallback) | 自動捲動解析（備援）

### Rate Control | 速率控制

Built-in smart rate control to avoid triggering Facebook's limits: | 內建智慧速率控制：

- **200-point weighted budget** — different operations cost different points | 加權預算系統
- **Adaptive delay** — auto-adjusts request intervals based on response time | 自適應延遲
- **Soft-block detection** — auto-pauses when throttling signals detected | 軟封鎖偵測
- **Reading simulation** — random pauses between requests mimicking human browsing | 閱讀模擬

### Security | 安全

- All data processing happens locally in your browser | 所有處理在瀏覽器本機完成
- No external APIs or servers used | 不使用外部 API 或伺服器
- No user data collected, transmitted, or stored externally | 不收集、傳送或儲存使用者資料
- `fb_dtsg` token used locally only, never sent externally | Token 僅本機使用

---

## Privacy | 隱私

FB Catch's privacy is enforced by architecture, not promises: | 隱私靠架構，不靠承諾：

| Item | Status |
|------|--------|
| Data collection / 資料收集 | **None** — no server exists to collect anything / 無 — 沒有伺服器 |
| Tracking / telemetry / 追蹤 | **None** — no analytics, no callbacks / 無 — 沒有回傳 |
| Account system / 帳號系統 | **None** — no login required / 無 — 不需登入 |
| External connections / 外部連線 | **None** — only connects to Facebook (pages you browse) / 無 — 僅連線 Facebook |
| Data storage / 資料儲存 | `chrome.storage.local` only (settings & progress), deleted on uninstall / 移除即刪除 |

> Full privacy policy: [privacy-policy.html](privacy-policy.html) | 完整隱私政策：[privacy-policy.html](privacy-policy.html)

---

## FAQ | 常見問題

### Can FB Catch backup private groups? | 可以備份私人群組嗎？

FB Catch can only access content **you can already see** in your browser. If you're a group member, you can backup posts visible to you. It cannot access content you don't have permission to view.

FB Catch 只能存取你在瀏覽器中**已經看得到的內容**。如果你是群組成員，可以備份你能看到的貼文。無法存取你沒有權限查看的內容。

### Will backup trigger Facebook blocking? | 備份會觸發封鎖嗎？

FB Catch has built-in smart rate control that mimics natural browsing. Normal use won't trigger blocks. However, backing up very large amounts (thousands of posts) in a short time may temporarily limit API requests. FB Catch will automatically pause and wait.

FB Catch 內建智慧速率控制，模擬正常瀏覽節奏。正常使用不會觸發封鎖。但短時間備份大量內容可能暫時被限制，FB Catch 會自動暫停等待。

### Can I import the backup data into other tools? | 備份資料可以匯入其他工具嗎？

Yes. JSON works with Python (pandas), R, Node.js. CSV opens in Excel or Google Sheets.

可以。JSON 可匯入 Python / R / Node.js 分析。CSV 可用 Excel 或 Google Sheets 開啟。

### How is this different from Facebook's "Download Your Information"? | 和 Facebook 官方「下載你的資訊」有什麼不同？

Facebook's tool only downloads **your own account's** data (personal posts, messages). FB Catch can backup **any public fan page or group** — a feature Facebook doesn't provide.

Facebook 官方只能下載**你自己帳號**的資料。FB Catch 可以備份**任何公開粉專或社團** — 這是 Facebook 不提供的功能。

### Is this legal? | 這是合法的嗎？

FB Catch only accesses publicly visible content you can already see in your browser. It does not bypass any access controls. Users are responsible for ensuring compliance with Facebook's Terms of Service and local laws.

FB Catch 只存取你已經看得到的公開內容，不繞過任何存取控制。使用者有責任確保符合 Facebook 服務條款和當地法規。

---

## Contributing | 貢獻

Bug reports, feature requests, and pull requests are welcome! | 歡迎提交 Bug 回報、功能建議和 PR！

- Read [CONTRIBUTING.md](CONTRIBUTING.md) first | 貢獻前請閱讀 [CONTRIBUTING.md](CONTRIBUTING.md)
- All commits require DCO sign-off (`git commit -s`) | 每個 commit 需要 DCO 簽署
- Security issues: report privately, do not open public issues | 安全漏洞請私下回報

---

## License | 授權

**FB Catch Source Available License v1.0**

- ✅ View, study, personal use | 查看、學習、個人使用
- ✅ Fork & modify for personal use (no publishing) | Fork 修改自用（不發布）
- ✅ Submit Issues / PRs | 提交 Issue / PR
- ❌ Publish to any store or platform | 發布到任何商店或平台
- ❌ Commercial use (requires written permission) | 商業使用（需書面許可）

Full license: [LICENSE](LICENSE) | 完整授權：[LICENSE](LICENSE)

---

## Disclaimer | 免責聲明

FB Catch is an independently developed tool, not affiliated with Meta Platforms, Inc. Users are responsible for ensuring their use complies with Facebook's Terms of Service and applicable laws.

FB Catch 是獨立開發的工具，與 Meta Platforms, Inc. 無任何關聯。使用者有責任確保使用方式符合 Facebook 服務條款及當地法律法規。

---

<p align="center">
  <sub>Made with care by <a href="https://github.com/thomas-jimmy-chen">Thomas Chen</a></sub>
</p>
