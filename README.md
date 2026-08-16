<p align="center">
  <img src="icons/icon128.png" width="96" alt="FB Catch icon" />
</p>

<h1 align="center">FB Catch</h1>

<p align="center">
  <strong>備份你的 Facebook 粉專 — 貼文、留言、圖片、影片，全部存到你的電腦。</strong>
</p>

<p align="center">
  <a href="#安裝">安裝</a> ·
  <a href="#功能">功能</a> ·
  <a href="#使用方式">使用方式</a> ·
  <a href="#批次備份">批次備份</a> ·
  <a href="#api-參考">API</a> ·
  <a href="#隱私">隱私</a> ·
  <a href="#授權">授權</a>
</p>

---

## 為什麼需要 FB Catch？

Facebook 沒有「打包下載粉專」的功能。你經營了多年的粉絲專頁，但：

- 帳號被停權 → 所有內容消失
- 貼文被檢舉移除 → 沒有備份就找不回來
- 想轉移到其他平台 → 沒有匯出工具
- 想分析過去的貼文表現 → 沒有結構化資料

**FB Catch** 填補這個缺口。在瀏覽器本機備份粉專的貼文、留言、圖片與影片，所有資料從不離開你的電腦。

---

## 功能

| 功能 | 說明 |
|------|------|
| **粉專備份** | 完整備份貼文內容、時間戳、按讚/分享/留言數 |
| **留言保存** | 三層巢狀留言（留言→回覆→回覆的回覆），完整保留對話脈絡 |
| **媒體封存** | 一鍵下載貼文中的圖片與影片，保留原始解析度 |
| **批次備份** | 匯入多個粉專 URL，排程自動備份，支援暫停/續傳 |
| **多格式匯出** | JSON、CSV、Markdown — 選擇最適合你的格式 |
| **智慧節奏** | 自適應速率控制，模擬正常瀏覽節奏，安全穩定 |

### 隱私設計

- **零伺服器** — 不存在收集資料的基礎設施
- **零帳號** — 不需要登入或註冊
- **零追蹤** — 沒有 Google Analytics、沒有遙測、沒有任何回傳
- **原始碼公開** — 你可以自行審計每一行程式碼

---

## 安裝

### 方式一：Chrome Web Store（推薦）

> *上架準備中，敬請期待。*

### 方式二：開發者模式載入

1. 下載或 clone 此 repo：
   ```bash
   git clone https://github.com/thomas-jimmy-chen/fb-catch.git
   ```

2. 開啟 Chrome，前往 `chrome://extensions/`

3. 右上角開啟 **開發者模式**

4. 點擊 **載入未封裝項目**，選擇 clone 下來的 `fb-catch` 資料夾

5. 完成！你會在工具列看到 FB Catch 的圖示

---

## 使用方式

### 基本備份

1. **前往你要備份的 Facebook 粉專頁面**（例如 `facebook.com/某粉專`）

2. **FB Catch 自動啟動** — 頁面右下角出現浮動球

3. **點擊浮動球**，開啟控制面板

4. **設定備份範圍**：
   - 要備份的貼文數量（預設 50 篇）
   - 日期範圍篩選（選填）
   - 最低互動數篩選（選填）

5. **點擊「Start」** 開始備份

6. **備份完成後**，選擇匯出格式：
   - **JSON** — 結構化資料，適合程式分析
   - **CSV** — 表格格式，適合 Excel / Google Sheets
   - **Markdown** — 人類可讀，適合歸檔

7. 檔案自動下載到你的電腦

### 備份留言

在貼文備份完成後，可以進一步備份留言：

1. 在面板中選取要備份留言的貼文
2. 設定留言深度（最多 3 層巢狀）
3. 點擊執行，留言會連同貼文一起匯出

### 備份媒體（圖片 & 影片）

1. 勾選「下載媒體」選項
2. 圖片與影片會以原始解析度下載
3. 自動整理到 `FBToolKit_batch_mode/{粉專名}/media/` 資料夾

---

## 批次備份

一次備份多個粉專。支援兩種匯入格式：

### 純文字格式（.txt）

每行一個粉專 URL，可選擇性指定貼文數：

```
# 我要備份的粉專清單
https://www.facebook.com/某粉專A    20
https://www.facebook.com/某粉專B    10
某粉專C
```

- `#` 開頭為註解
- 沒寫篇數 → 預設 50 篇
- 只寫名稱也行（自動補 `https://www.facebook.com/` 前綴）

### JSON 格式（.json）— 完整篩選

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
    { "url": "某粉專A", "count": 20 },
    { "url": "某粉專B", "count": 10 }
  ]
}
```

### 篩選參數

| 參數 | 說明 | 預設 |
|------|------|------|
| `dateFrom` | 起始日期（YYYY-MM-DD） | 不限 |
| `dateTo` | 結束日期（YYYY-MM-DD） | 不限 |
| `minLikes` | 最少按讚數 | 0（不限） |
| `minComments` | 最少留言數 | 0（不限） |
| `minShares` | 最少分享數 | 0（不限） |
| `resultLimit` | 每個粉專的結果上限 | 0（不限） |
| `formats` | 匯出格式 | `["json"]` |

### 使用方式

1. 準備好 `.txt` 或 `.json` 檔案
2. 在面板中點擊 📂 **Import** 按鈕
3. 選擇檔案，清單會載入面板
4. 確認無誤後點擊 **Start**
5. FB Catch 會自動依序瀏覽每個粉專並備份
6. 支援 **暫停 / 續傳 / 取消**

---

## 匯出格式

### JSON

```json
{
  "meta": {
    "source": "facebook.com/某粉專",
    "exportDate": "2026-08-16T12:00:00Z",
    "tool": "FB Catch v0.1.0",
    "postCount": 50
  },
  "posts": [
    {
      "id": "pfbid0...",
      "text": "貼文內容...",
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
| pfbid0... | 貼文內容... | 2026-08-15T09:30:00Z | 42 | 7 | 3 |

### Markdown

每個粉專產生一份摘要報告，包含貼文統計、時間軸、互動排名。

---

## API 參考

FB Catch 在 Facebook 頁面的 `window.__FB_TOOLKIT__` 暴露了完整的 API，可在 DevTools Console 中使用。

### 快速範例

```javascript
const tk = window.__FB_TOOLKIT__;

// 備份最近 20 篇貼文
const result = await tk.posts.scanGraphQL({ targetCount: 20 });
console.log(result.posts.length, '篇');

// 備份某篇貼文的留言（含 3 層回覆）
const comments = await tk.comments.scrape({
  feedbackId: result.posts[0].feedbackId,
  maxDepth: 3
});

// 下載為 JSON
await tk.download(comments, 'json', 'my_backup');
```

### 完整 API

| 分類 | 方法 | 說明 |
|------|------|------|
| **Posts** | `posts.scan(opts)` | DOM 捲動掃描貼文 |
| | `posts.scanGraphQL(opts)` | GraphQL API 掃描（推薦） |
| | `posts.download(posts, format)` | 匯出貼文資料 |
| **Comments** | `comments.scrape(opts)` | 巢狀留言備份 |
| | `comments.scrapeFlat(opts)` | 扁平留言備份 |
| | `comments.scrapeWithMedia(opts)` | 留言 + 附件備份 |
| **Batch** | `batch.scrapeFromProfile(opts)` | 一鍵完整備份流程 |
| | `batch.status()` | 查詢備份進度 |
| | `batch.pause()` / `resume()` / `cancel()` | 控制批次作業 |
| **Media** | `media.downloadAll(comments, postId)` | 下載留言附件 |
| | `media.downloadPostsMedia(posts, username)` | 下載貼文圖片/影片 |
| **Utility** | `status()` | 擴充狀態 |
| | `refreshDtsg()` | 重新取得 token |
| | `togglePanel()` | 切換浮動面板 |

> 完整 API 文件請參閱 [API.md](API.md)

---

## 檔案結構

```
fb-catch/
├── manifest.json          # Chrome Extension MV3 設定
├── content.js             # 主要邏輯（DOM 掃描、GraphQL、批次、UI）
├── background.js          # Service Worker（下載管理、icon 狀態）
├── injected.js            # MAIN world 注入（fb_dtsg token + API proxy）
├── offscreen.html/.js     # 離屏文件（媒體處理）
├── icons/                 # 擴充圖示（16/48/128 px）
├── LICENSE                # Source Available License v1.0
├── CONTRIBUTING.md        # 貢獻指南 + DCO
├── DMCA_TEMPLATE.md       # 侵權通知範本
├── privacy-policy.html    # 隱私政策（CWS 合規）
├── API.md                 # API 完整參考
└── IMPORT_FORMAT.md       # 批次匯入格式說明
```

---

## 技術細節

### 架構

- **Manifest V3** — 使用最新的 Chrome Extension 標準
- **三層注入**：
  - `content.js`（ISOLATED world）— 主邏輯、UI、資料處理
  - `injected.js`（MAIN world）— 取得 `fb_dtsg` token、暴露 API
  - `background.js`（Service Worker）— 下載管理、icon 狀態更新
- **GraphQL** — 透過 Facebook 的 GraphQL API 取得留言，支援深度巢狀回覆
- **DOM 掃描** — 自動捲動頁面，解析貼文內容（GraphQL 不可用時的備援）

### 速率控制

FB Catch 內建智慧速率控制，避免觸發 Facebook 的限制機制：

- **200 點加權預算** — 不同操作消耗不同點數
- **自適應延遲** — 根據回應時間自動調整請求間隔
- **軟封鎖偵測** — 偵測到限制信號時自動暫停等待
- **閱讀模擬** — 在請求間插入隨機停頓，模擬人類瀏覽

### 安全

- 所有資料處理在瀏覽器本機完成
- 不使用任何外部 API 或伺服器
- 不收集、傳送或儲存任何使用者資料
- `fb_dtsg` token 僅在本機使用，不對外傳送

---

## 隱私

FB Catch 的隱私設計不是靠承諾，而是靠架構：

| 項目 | 說明 |
|------|------|
| 資料收集 | **無** — 沒有伺服器，物理上無法收集 |
| 追蹤 / 遙測 | **無** — 沒有 Google Analytics、沒有回傳 |
| 帳號系統 | **無** — 不需要登入或註冊 |
| 外部連線 | **無** — 只連線 Facebook（你自己在瀏覽的頁面） |
| 資料儲存 | 僅 `chrome.storage.local`（設定和進度），移除擴充即刪除 |

> 完整隱私政策請參閱 [privacy-policy.html](privacy-policy.html)

---

## 常見問題

### FB Catch 可以備份私人群組嗎？

FB Catch 只能存取你在瀏覽器中**已經看得到的內容**。如果你是群組成員，可以備份你能看到的貼文。無法存取你沒有權限查看的內容。

### 備份會觸發 Facebook 封鎖嗎？

FB Catch 內建智慧速率控制，模擬正常瀏覽節奏。在正常使用下不會觸發封鎖。但如果短時間內備份大量內容（數千篇貼文），Facebook 可能會暫時限制 API 請求。此時 FB Catch 會自動暫停等待。

### 備份的資料格式可以匯入其他工具嗎？

可以。JSON 格式可直接匯入 Python（pandas）、R、Node.js 等程式語言進行分析。CSV 格式可用 Excel 或 Google Sheets 開啟。

### FB Catch 和 Facebook 官方的「下載你的資訊」有什麼不同？

Facebook 的「下載你的資訊」只能下載**你自己帳號**的資料（個人貼文、訊息等）。FB Catch 可以備份**任何公開粉專或社團**的貼文和留言 — 這是 Facebook 不提供的功能。

### 這是合法的嗎？

FB Catch 只存取你在瀏覽器中已經看得到的公開內容，不繞過任何存取控制。使用者有責任確保使用方式符合 Facebook 服務條款和當地法規。

---

## 貢獻

歡迎提交 Bug 回報、功能建議和 Pull Request！

- 貢獻前請閱讀 [CONTRIBUTING.md](CONTRIBUTING.md)
- 每個 commit 需要 DCO 簽署（`git commit -s`）
- 安全漏洞請私下回報，不要開公開 issue

---

## 授權

**FB Catch Source Available License v1.0**

- ✅ 查看、學習、個人使用
- ✅ Fork 修改自用（不發布）
- ✅ 提交 Issue / PR
- ❌ 發布到任何商店或平台
- ❌ 商業使用（需書面許可）

完整授權條款請參閱 [LICENSE](LICENSE)

---

## 免責聲明

FB Catch 是獨立開發的工具，與 Meta Platforms, Inc. 無任何關聯。使用者有責任確保使用方式符合 Facebook 服務條款及當地法律法規。

---

<p align="center">
  <sub>Made with care by <a href="https://github.com/thomas-jimmy-chen">Thomas Chen</a></sub>
</p>
