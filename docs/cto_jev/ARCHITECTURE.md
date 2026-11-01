# your-cto-jev ARCHITECTURE

Status: approved

## 技術棧

| 項目 | 值 | 來源 |
|---|---|---|
| 語言 | TypeScript，ESM，編譯到 `dist/` | package.json, tsconfig.json |
| Runtime | Node.js 22+ | README.md |
| Runtime 相依 | `@clack/core`、`@clack/prompts`（只有互動式 setup 載入） | package.json |
| 測試 | `node:test`，`dist/*.test.js` | package.json |
| 發佈 | npm 套件 `your-cto-jev`，bin 名 `cto` | package.json |

## 目錄地圖

`src/` 是扁平的，一個模組一個檔：

| 檔 | 負責 |
|---|---|
| `index.ts` | CLI 入口與指令分派 |
| `hooks.ts` | git commit / push 與 agent pre/post/stop hook 的檢查流程，Jev 問題定義 |
| `local.ts` | 不呼叫 Jev 的規則檢查（保護分支、衝突標記、.env、大檔、lock 漂移、流程簽核） |
| `api.ts` | Jev provider 呼叫、failover、冷卻 |
| `brain.ts` | `.cto.json` 設定、`.cto-brain.json` 本機狀態、credentials、prefs |
| `masker.ts` | 送出前遮罩 secrets |
| `diff.ts` | diff 過濾與切塊 |
| `turn.ts` | 讀 agent transcript，整理一個 turn 的行動與打勾 |
| `lessons.ts` | 失敗指紋與修法紀錄 |
| `brief.ts` | `cto brief`：開工前該知道的事，含流程的 Ready/Blocked |
| `flow.ts` | `docs/cto_jev/` 的 TASKS 解析、INDEX 產生 |
| `docs.ts` | `cto docs`：過期規劃文件的規則篩與 Jev 判斷 |
| `setup.ts`、`setupui.ts` | `cto setup` 與互動 UI |
| `skill.ts` | 寫給 agent 的 rules block 與 skill 檔 |
| `doctor.ts`、`check.ts`、`report.ts`、`update.ts`、`conflicts.ts`、`agents.ts`、`i18n.ts` | 各自同名的指令或支援 |

其他：`calibration/` Jev 校正案例，`scripts/` 建置腳本，`docs/cto_jev/` 本流程的規劃文件。

## 外部服務與資料

| 對象 | 用途 | 來源 |
|---|---|---|
| OpenRouter、TypeSafe、Cloudflare AI Gateway | Jev provider，依使用者排序 failover | src/api.ts |
| npm registry | 每天最多一次查新版本 | src/update.ts |
| `.cto.json` | 專案設定，進 git | src/brain.ts |
| `.cto-lessons.jsonl` | 失敗與修法紀錄，進 git | src/lessons.ts |
| `.cto-brain.json` | 本機狀態（最近失敗、冷卻、決策 log），gitignore | src/brain.ts |
| 使用者層級 credentials 與 prefs 檔 | API key、provider 順序、語言 | src/brain.ts |

送往 provider 的一切先經 `masker.ts`。沒有資料庫，沒有自己的伺服器。

## 驗證指令

`npm test`（tsc 後跑 `dist/*.test.js`）。(from: package.json)

## 不變的原則

- 單一 npm 套件：hook 只呼叫 `cto`，所有邏輯都在套件裡，更新套件就更新所有 repo。(asked)
- 每個檢查先規則後 Jev：規則能判的不花錢、不送資料。(asked)
- 任何檢查失敗一律 fail open。(asked)
- 不新增 runtime 相依。(asked)
