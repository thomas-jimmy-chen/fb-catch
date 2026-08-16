# FB Catch — Import 檔案格式說明

> 版本：Phase 8e (2026-07-12)
> 對應：浮動面板 → 📂 Import 按鈕

## 支援格式

### 格式 1：純文字（.txt / .csv）

每行一個 URL，可選用 tab 或逗號分隔篇數：

```
# 這是註解（# 開頭會被忽略）
https://www.facebook.com/WeatherRisk.Co	10
https://www.facebook.com/caterlanse,5
https://www.facebook.com/profile.php?id=100063488689600
https://www.facebook.com/groups/aaronmin	20
```

- 沒寫篇數 → 預設 50 篇
- 支援 vanity URL、profile.php?id=、groups/ 三種格式
- 只需填 `caterlanse` 也行（自動補 `https://www.facebook.com/` 前綴）
- 不支援篩選參數（URL + 篇數 only）

### 格式 2：JSON（.json）— 完整篩選

```json
{
  "global": {
    "dateFrom": "2026-06-01",
    "dateTo": "2026-07-12",
    "minLikes": 10,
    "minComments": 5,
    "minShares": 0,
    "resultLimit": 100,
    "formats": ["json", "csv"]
  },
  "targets": [
    { "url": "https://www.facebook.com/WeatherRisk.Co", "count": 20 },
    { "url": "caterlanse", "count": 10 },
    { "url": "https://www.facebook.com/profile.php?id=100063488689600", "count": 5 },
    { "url": "https://www.facebook.com/groups/aaronmin", "count": 30 }
  ]
}
```

## `global` 欄位說明

| 欄位 | 類型 | 面板對應 | 說明 |
|------|------|---------|------|
| `dateFrom` | string | 日期範圍（起） | `YYYY-MM-DD` 格式，如 `"2026-06-01"` |
| `dateTo` | string | 日期範圍（迄） | `YYYY-MM-DD` 格式 |
| `minLikes` | number | 最少按讚數 | `0` = 不限 |
| `minComments` | number | 最少留言數 | `0` = 不限 |
| `minShares` | number | 最少分享數 | `0` = 不限 |
| `resultLimit` | number | 結果上限 | `0` = 不限；每個來源各自限制 |
| `formats` | string[] | 匯出格式 | `["json"]` / `["csv"]` / `["json", "csv"]` |

- `global` 是選填，省略時用面板上的值
- Import 後這些值會填入面板 UI，可在掃描前手動調整

## `targets` 欄位說明

| 欄位 | 類型 | 必填 | 說明 |
|------|------|------|------|
| `url` | string | ✅ | Facebook 頁面 URL（支援簡寫） |
| `count` | number | 選填 | 要掃描的貼文數，預設 50 |

## URL 簡寫規則

以下寫法等效：
```
https://www.facebook.com/WeatherRisk.Co
http://facebook.com/WeatherRisk.Co
www.facebook.com/WeatherRisk.Co
facebook.com/WeatherRisk.Co
fb.com/WeatherRisk.Co
WeatherRisk.Co                          ← 自動補前綴
```

## 限制

- 檔案大小上限：10 MB
- 編碼：UTF-8（支援 BOM）
- 空行和 `#` 開頭的行會被忽略

## 自動化提示

JSON 格式可由外部腳本（Python / Node.js）動態產生，配合排程自動 import：

```python
import json

config = {
    "global": {
        "dateFrom": "2026-07-01",
        "dateTo": "2026-07-12",
        "minLikes": 5,
        "formats": ["json"]
    },
    "targets": [
        {"url": "WeatherRisk.Co", "count": 20},
        {"url": "caterlanse", "count": 10},
    ]
}

with open("fb_scan_config.json", "w", encoding="utf-8") as f:
    json.dump(config, f, ensure_ascii=False, indent=2)
```

產生的 `fb_scan_config.json` 可直接拖入面板的 📂 Import。
