# cto-flow SPEC

Status: approved

## Interface

別的 feature 和宿主 agent 可以依賴的部分。

### 目錄：`docs/cto_jev/`

```
docs/cto_jev/
  INDEX.md                 cto 產生，不手改
  PRODUCT.md               CTO 寫，使用者簽核
  ARCHITECTURE.md          CTO 寫，使用者簽核
  decisions/NNNN-<slug>.md 只新增不修改
  features/<slug>/
    CONCEPT.md             為什麼做：目的、動機、商業規則、不做的事
    SPEC.md                怎麼做：Interface、Constraints、Internals
    TASKS.md               父子 task、依賴、驗收
    REVIEW.md              金魚審查：審了什麼、發現幾項、對應哪些 task
  archive/<YYYYMM>-<name>/ 從 cto_jev 以外收進來的舊文件，agent 不讀
```

檔名固定，數量固定：頂層 3 個檔，每個 feature 4 個檔。`features/platform/` 是常設 feature，收 CI、建置、部署、依賴升級等基礎設施工作。

### 簽核

CONCEPT.md、SPEC.md、PRODUCT.md、ARCHITECTURE.md 第一個非標題行固定是 `Status: draft` 或 `Status: approved`。只有使用者能改成 approved；CTO 寫完就停，等使用者看。

### SPEC.md 的三段

| 段 | 誰讀 | 用途 |
|---|---|---|
| `## Interface` | 其他 feature 的工程師 | 對外的函式、API、事件、資料表 |
| `## Constraints` | Jev 漂移檢查 | 商業規則硬約束，一條一行 |
| `## Internals` | 自己 feature 的工程師 | 實作細節 |

跨 feature 只讀對方的 Interface。

### TASKS.md 語法

```md
- [ ] FLOW-1 父項說明
  - [ ] FLOW-1.1 子項說明 (after: PERM-2) (files: src/x/)
        驗收: npm test -- x
```

- ID：`<FEATURE 前綴>-<n>`，子項 `<n>.<m>`。前綴大寫，全 repo 不重複。
- 父子用縮排。父項不寫 `(files:)` 和驗收；子項全勾父項才算完成（`turn.ts` 的 `nested()` 已實作，上限 15 個子項）。
- `(after: ID[, ID])`：必須先完成的 task。跨 feature 的 `after` 就是 feature 依賴。
- `(files: path/[, path/])`：這個 task 會改的目錄或檔案。寫到 feature 自己的目錄那層，不寫 `src/`。
- `驗收:` 一行可執行指令，或 `manual`。`manual` 的 task 由使用者在對話中確認後 CTO 才打勾，打勾時說明是人工驗收。
- `(P1)` / `(P2)` / `(P3)`：任何 task 都能標。P1 先做、有未勾的 P1 不能 release；P2 一般，沒標就是 P2；P3 最後。brief 的 Ready 依 P1 → P2 → P3 排。
- `(seq)`：這個 task 一定單獨跑，不管 `(files:)` 重不重疊。migration、共用 types、routes 表用它。沒標的 task，`(files:)` 不重疊就可以和別的 Ready task 同時跑，brief 算出來顯示為 run together。

### 分支與 review

- release 的定義看 repo 有什麼分支，`cto-jev release` 第一次跑時判斷一次、告訴使用者、之後固定：

  | repo 有 | 工作在 | release 是 | review 範圍 |
  |---|---|---|---|
  | 只有 `main`、一個人 | `main`（每波 commit 前照樣 review） | 打 tag 或從 main 部署 | `git diff <上個 tag>..HEAD` |
  | `main` + feature 分支 | 每個 feature／每波一個分支 | 進 `main` 的 PR | PR 的 diff，`cto check --base main` |
  | `main` + 整合分支（`review`、`develop`、`staging`） | 整合分支 | 合進 `main` | `git diff main...<整合分支>` |
  | `staging` + `live`／`production` | `staging` | staging 升到 live | `git diff live...staging`，第二次較輕的 release review |

  不變的一條：會到使用者手上的那個分支，沒有 release review 不收任何東西；它就是 `.cto.json` 的 `protected_branches`。
- **每一波 commit 之前先 code review**：零上下文 reviewer 讀該波 diff 和 feature 的 SPEC；P1 發現修掉再 commit，P2 發現寫成 `(P2)` task。
- **release 之前 review 全部**：把 review 分支對 main 的整個 diff（所有還沒發的 commit）一次 review，發現分 P1／P2 進 TASKS.md；P1 全勾、`cto check --base main` 過，才合進 main。
- REVIEW.md 每筆記：日期、範圍（哪一波或哪次 release）、發現數、對應 task ID 與優先度。

### INDEX.md（產生）

| 欄 | 來源 |
|---|---|
| Feature | `features/` 底下的資料夾 |
| 目的 | CONCEPT.md `## 目的` 第一行 |
| 狀態 | TASKS.md 打勾比例：無 task = planned、部分 = active、全部 = done |
| 程式碼 | TASKS.md 所有 `(files:)` 的聯集 |
| 依賴 | 跨 feature 的 `(after:)` |
| 簽核 | CONCEPT/SPEC 的 Status |

### 指令

| 指令 | 行為 |
|---|---|
| `cto brief` | 既有輸出之外：重新產生 INDEX.md；列出 Ready task（依賴全勾、`(files:)` 和其他 Ready task 不重疊）；列出 Blocked task 和卡在誰；PRODUCT/ARCHITECTURE 的 `unknown` 欄位數 |
| `cto index` | 只重新產生 INDEX.md |
| `cto docs` | 掃 `docs/cto_jev/` 以外的 markdown，輸出 併入 / 封存 / 刪除 建議，不動檔 |

## Constraints

- cto 不寫 CONCEPT、SPEC、TASKS、REVIEW、PRODUCT、ARCHITECTURE 的內容；只寫 INDEX.md。例外：`setup --flow` 建空骨架（欄位填 `unknown`），`features/platform/` 的骨架直接是 `Status: approved`，因為它沒有內容要簽。
- `(files:)` 不存在不算問題：任務做完前檔案本來就不在，做完的任務也可能刪掉它。
- 任何檢查先規則後 Jev；規則能判的不呼叫 Jev。
- 封存和刪除只建議，執行由 CTO 在使用者同意後做。
- `(files:)` 聯集就是 feature 的程式碼範圍；沒有別的來源。
- 簽核狀態只有使用者能改；skill 禁止 CTO 自己改成 approved。
- 檢查失敗時 fail open，和現有所有檢查一致。

## Internals

### 規則檢查（不呼叫 Jev）

pre-commit（加進 `local.ts` 的 `localCommitChecks`）：

| 檢查 | 結果 |
|---|---|
| diff 碰到 feature x（它的資料夾，或任一 task 的 `(files:)` 範圍，以目錄邊界比對），x 的 TASKS.md 有任務 ID，但 `features/x/SPEC.md` 不是 `Status: approved`（大小寫不分） | 擋 |
| 同一個任務 ID 在 TASKS.md 出現不只一次（只看 diff 碰到的 TASKS.md） | 警告 |
| INDEX.md 和 TASKS.md 不一致（TASKS 改了、INDEX 沒重新產生） | 警告，提示 `cto index` |
| `(after:)` 指到不存在的 ID | 警告 |
| diff 改到某 feature 的 `## Interface` 段 | 警告，列出 INDEX 上依賴它的 feature |

brief / doctor：

| 檢查 | 結果 |
|---|---|
| `features/x/` 缺檔 | 列出 |
| 程式碼目錄（`src/*` 第一層）不屬於任何 feature；沒有 `src/` 的 repo 不檢查 | 列出 |
| 固定標題缺失（PRODUCT、ARCHITECTURE、SPEC 三段） | 列出 |

### Jev 判斷

| 問題 | 時機 | 輸入 | 結果 |
|---|---|---|---|
| diff 是否違反對應 feature 的 Constraints | commit，取代 `architecture_violation` 現在的 `sprint_goal` 問法 | diff + 該 feature `## Constraints` + PRODUCT `## 不做的事` | 警告 |
| diff 是否改變架構卻沒新增 `decisions/` | commit，diff 碰到 `src/` 且沒碰 `decisions/` | diff + ARCHITECTURE `## 不變的原則` | 警告 |
| 這份 markdown 是規劃／筆記，不是使用者文件？內容已做完或已在 cto_jev？和現行 SPEC 矛盾？ | `cto docs`，規則篩不掉的檔 | 檔案內容 + INDEX | 建議 |

對應 feature 的找法：diff 檔案路徑對 INDEX 的程式碼欄最長前綴比對。`sprint_goal` 為空、INDEX 也沒命中時，`architecture_violation` 不檢查，和現狀一樣。

### `cto docs` 的規則篩

先排除，永不建議：`README.md`、`CONTRIBUTING.md`、`CHANGELOG.md`、`LICENSE*`、`SECURITY.md`、`docs/cto_jev/**`、沒有 checkbox 且不在已知工具路徑的 `docs/**`。

直接建議，不問 Jev：

| 條件 | 建議 |
|---|---|
| 已知工具路徑：`.planning/`、`specs/`、`.kiro/`、`PLAN.md`、`TODO.md`、`NOTES.md`、`*-plan.md` 且 checkbox 全勾 | 刪除 |
| checkbox 全勾、git 最後修改超過 30 天 | 刪除 |
| 已知工具路徑、有未勾項目 | 併入 |

其餘有 checkbox 或在已知工具路徑的檔才問 Jev。

### PRODUCT.md 欄位

| 欄位 | 下游 | 來源 |
|---|---|---|
| 一句話 | 金魚 review | README，否則問 |
| 使用者角色 | SPEC 商業規則 | 問 |
| 怎麼賺錢 | SPEC Constraints | 問；內部工具／開源寫「不賺錢」 |
| 方案與限制 | 付費牆規則 | 只在有付費時問 |
| 不做的事 | 漂移檢查 | 問 |
| 設計約束 | 前端 SPEC | 問，可 unknown |

### ARCHITECTURE.md 欄位

| 欄位 | 下游 | 來源 |
|---|---|---|
| 技術棧 | sub-agent 選型 | `package.json`、lock、`tsconfig` |
| 目錄地圖 | INDEX、feature 劃分 | 目錄樹，問要不要修 |
| 外部服務與資料 | SPEC 資料段 | `.env.example`、依賴 |
| 驗證指令 | 驗收 | `detectTestCommand` |
| 不變的原則 | 漂移檢查 | 問，可空 |

初始化：CTO 掃 repo 先填，每格標 `(from: <檔>)`、`(asked)` 或 `(unknown)`；剩下的每輪最多五題、每題附猜測，使用者可 skip；寫完逐標題帶使用者走一遍，問出的新問題下一輪再問，直到使用者說完整。完成的定義是使用者說完整，不是每格有字。

### Skill：`.agents/skills/cto-flow/SKILL.md`

和現有 `cto` skill 同一層，`cto setup` 選了流程才寫入。七個工作，名字加 `cto-jev` 前綴，避免和別的 skill 的「步驟一」混在一起；使用者在對話裡打這個名字就是在叫它：

| 名字 | 什麼時候 | 做什麼、停在哪 |
|---|---|---|
| `cto-jev init` | 第一次，或 brief 顯示 Unknown fields | 掃 repo 填能證明的；每輪最多五題；寫完逐標題帶使用者走，直到使用者說完整；停在 draft 等簽核 |
| `cto-jev feature` | 比一個 edit 大的需求 | 先跑 `cto-jev docs`；對 INDEX 分類；**先談再寫**，CONCEPT 和 SPEC 各有一張必答清單；寫完逐段過到使用者說完整；停在 draft，不寫 TASKS |
| `cto-jev tasks` | SPEC approved 後 | 拆父子 task，每個子項有 files、after、驗收；共用檔獨立；`cto index` 後 brief 的 Ready 是第一波 |
| `cto-jev work` | 使用者說繼續，或 brief 有 Ready | brief → 派工（最窄讀取集）→ `git status` 對範圍 → 自己跑驗收才打勾 → **該波 review，P1 修掉、P2 進 task → commit** |
| `cto-jev release` | 要把 review 合進 main | review 全部未發的 diff；發現分 P1／P2 進 TASKS；P1 全勾、`cto check --base main` 過才合併；REVIEW.md 記一筆 |
| `cto-jev docs` | 開 feature 前，或使用者要整理 | `cto docs` 的清單給使用者決定，決定後才動 |
| `cto-jev decision` | commit 警告 `architecture_undocumented`，或改了服務／儲存／邊界 | 寫 `decisions/NNNN-<slug>.md`，只增不改 |

禁止：自己改 Status 成 approved；在 TASKS 以外的地方記狀態；手改 INDEX；猜 PRODUCT／ARCHITECTURE 的欄位；讀 archive/。

### 不改的東西

- `done_unverified`、`tickedItems`、`nested()` 原樣沿用。
- 打勾仍然是唯一的狀態來源；不新增 `cto task done` 類指令。
- `sprint_goal` 保留，沒有 INDEX 命中時仍用它。
