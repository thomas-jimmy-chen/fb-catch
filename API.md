# FB Catch — `window.__FB_TOOLKIT__` API 參考

> 本文件描述 MAIN world（injected.js）暴露的 `window.__FB_TOOLKIT__` 物件。
> 所有方法透過 RPC bridge 呼叫 content.js 的 `handleAction()`，回傳 Promise。

## 屬性

| 屬性 | 型別 | 說明 |
|------|------|------|
| `platform` | `string` | 固定 `'facebook'` |
| `version` | `string` | 擴充版本號 |

## Posts

| 方法 | 參數 | 說明 |
|------|------|------|
| `posts.scan(opts)` | `{ targetCount }` | DOM 捲動掃描貼文 |
| `posts.scanGraphQL(opts)` | `{ targetCount, afterTime?, beforeTime?, userId? }` | GraphQL API 掃描貼文（推薦） |
| `posts.download(posts, format)` | `posts[]`, `'json'\|'csv'` | 下載貼文資料 |

## Comments

| 方法 | 參數 | 說明 |
|------|------|------|
| `comments.scrape(opts)` | `{ postUrl?, feedbackId?, maxDepth?, sortOrder? }` | 抓取巢狀留言 |
| `comments.scrapeFlat(opts)` | 同上 | 抓取扁平留言 |
| `comments.scrapeWithMedia(opts)` | 同上 + `{ postId? }` | 抓留言並同步下載附件 |

## Batch

| 方法 | 參數 | 說明 |
|------|------|------|
| `batch.scrapeComments(opts)` | `{ posts: [{url, feedbackId, title}] }` | 批次抓多篇貼文留言 |
| `batch.scrapeFromProfile(opts)` | `{ userId, postsCount?, maxDepth?, downloadMedia? }` | 一鍵流程：掃貼文→抓留言→下載媒體 |
| `batch.status()` | — | 取得批次進度 |
| `batch.pause()` | — | 暫停批次 |
| `batch.resume()` | — | 恢復批次 |
| `batch.cancel()` | — | 取消批次 |

## Media

| 方法 | 參數 | 說明 |
|------|------|------|
| `media.downloadAll(comments, postId)` | `comments[]`, `string` | 下載留言中所有附件 |
| `media.downloadAndEnrich(comments, postId)` | 同上 | 下載附件並回填 `localFile` 欄位 |
| `media.downloadPostsMedia(posts, username)` | `posts[]`, `string` | 下載貼文中的圖片/影片 |

## Utility

| 方法 | 參數 | 說明 |
|------|------|------|
| `download(data, format, filename)` | `any`, `string`, `string` | 匯出資料為檔案 |
| `status()` | — | 取得擴充狀態（platform/version/hasDtsg/batch） |
| `refreshDtsg()` | — | 強制重新取得 fb_dtsg token |
| `resetCounter()` | — | 重設請求計數器 |
| `togglePanel()` | — | 切換浮動面板顯示/隱藏 |
| `getToolkitStatus()` | — | 取得目前狀態快照（phase/action/progress/error） |

## 使用範例

```javascript
// DevTools Console（在 Facebook 頁面）
const tk = window.__FB_TOOLKIT__;

// 掃描最近 20 篇貼文
const result = await tk.posts.scanGraphQL({ targetCount: 20 });
console.log(result.posts.length, '篇');

// 抓某篇貼文留言
const comments = await tk.comments.scrape({
  feedbackId: result.posts[0].feedbackId,
  maxDepth: 3
});

// 下載為 JSON
await tk.download(comments, 'json', 'my_comments');
```
