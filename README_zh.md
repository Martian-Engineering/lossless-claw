# lossless-claw（無損上下文管理插件）

> OpenClaw 的 DAG 式對話壓縮插件 — 讓 AI 記住一切，不再遺忘。

## 這是什麼

當對話超過模型的上下文窗口時，傳統做法是截斷舊訊息。lossless-claw 改用 **DAG（有向無環圖）式摘要系統**：

1. **持久化每條訊息** — 寫入 SQLite，按對話分組
2. **階層式摘要** — 將舊訊息壓縮成多層摘要，保留關鍵資訊
3. **智慧重建上下文** — 每次對話從摘要 DAG 中挑選最相關的節點
4. **零遺失** — 原始訊息永遠保留，可隨時展開還原

### 混搭模型支援

lossless-claw 支援**主模型與摘要模型分離**：

| 角色 | 模型範例 | 說明 |
|------|---------|------|
| 主模型 | Claude Opus / Sonnet | 處理對話 |
| LCM 摘要 | MiniMax M2.7 HS | 生成摘要，節省成本 |
| LCM 展開 | MiniMax M2.7 HS | 展開摘要細節 |

## 快速開始

```bash
# 安裝
openclaw plugins install lossless-claw

# 啟用
openclaw plugins enable lossless-claw

# 設為上下文引擎
# 在 openclaw.json 中加入：
# "plugins": { "slots": { "contextEngine": "lossless-claw" } }
```

### 配置範例（混搭 MiniMax M2.7 HS）

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "lossless-claw"
    },
    "entries": {
      "lossless-claw": {
        "config": {
          "summaryModel": "minimax/MiniMax-M2.7-highspeed",
          "summaryProvider": "minimax",
          "expansionModel": "minimax/MiniMax-M2.7-highspeed",
          "expansionProvider": "minimax",
          "contextThreshold": 0.75
        }
      }
    }
  }
}
```

## 本 Fork 的修復

### 1. `getApiKey()` Provider Config Fallback

**分支**: `fix/getApiKey-provider-config-fallback`

**問題**：LCM 的 `getApiKey()` 缺少 `models.providers.*.apiKey` fallback，導致非內建 provider（如 MiniMax）在 launchd 環境下 401。

**修復**：在 `getApiKey()` 和 `requireApiKey()` 中加入第 6 層 fallback，讀取 `models.providers.*.apiKey`。

> ⚠️ v0.5.1 已包含此修復（`findProviderConfigValue`），此分支主要用於舊版本。

### 2. `stripAuthErrors()` 假陽性修復

**分支**: `fix/summarize-strip-auth-false-positive`

**問題**：壓縮包含 "401"/"authentication_error" 等字眼的對話時，`pickAuthInspectionValue()` 會將對話內容誤判為真正的 auth error，產生假的 `[lcm] compaction failed: provider auth error` 日誌。

**根因**：`summarize.ts` 第 390 行，當 regex 沒匹配到 auth-related key 時，fallback 回原始 `value`，導致下游 `extractProviderAuthFailure()` 從對話內容中誤偵測到 auth 失敗。

**修復**：改為回傳空物件 `{}`，避免假陽性。

## 已驗證的部署配置

| 機器 | 主模型 | LCM 模型 | Summaries | 漂移 | Errors |
|------|--------|---------|-----------|------|--------|
| Scott#4 | Claude Opus | M2.7 HS | 200+ | 零 | 零 |
| Scott#2 | Claude Opus | M2.7 HS | 40+ | 零 | 零 |

## 相關倉庫

| 倉庫 | 說明 |
|------|------|
| [Martian-Engineering/lossless-claw](https://github.com/Martian-Engineering/lossless-claw) | 上游原始倉庫 |
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | OpenClaw 主專案 |
| [catgodtwno4/openclaw-five-layer-memory-nas](https://github.com/catgodtwno4/openclaw-five-layer-memory-nas) | 五層記憶棧 NAS 部署指南 |
| [catgodtwno4/openclaw-dashboard](https://github.com/catgodtwno4/openclaw-dashboard) | OpenClaw Dashboard |

## 許可證

MIT
