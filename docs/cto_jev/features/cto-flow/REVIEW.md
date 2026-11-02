# cto-flow REVIEW

## 2026-11-02 · release review `f49677c..HEAD`（FLOW-1 到 FLOW-6）

兩位零上下文 reviewer，各看一半的檔案，對照 CONCEPT.md / SPEC.md。

- P1: 2，已修（同一個 commit）
  - `flow_signoff` 用 `startsWith` 比對 `(files:)`：`src/auth` 會擋到 `src/authz/`；`Status: Approved` 大寫被當未簽核。改成目錄邊界比對、大小寫不分（local.ts、flow.ts）。
  - `architecture_undocumented` 的題目把「加一個外部相依」當成要決策紀錄，裝個套件就警告。題目改成「產品新依賴的外部系統或 SDK」，明說套件匯入與版本升級不算。
- P2: 12 → FLOW-7.1 ~ FLOW-7.7
- P3: 6，未立 task：`overlaps` 在 flow.ts 與 brief.ts 各一份；`flowInterface` 迴圈內重複 `featureIndex`；`cto index` 在沒有 features/ 的 repo 說 up to date；`驗收:` 會黏到前一個有 ID 的 task；`cto docs` 的 EXCLUDED 用 basename 比對會多排除子目錄的 README；README rules table 那行和寫進 CLAUDE.md 的 FLOW_RULE 用字不同（併入 FLOW-7.5）。
- 結論：P1 修完可發；FLOW-7 在發版前做完 7.1 ~ 7.6。

## 2026-11-02 · wave FLOW-7.1 ~ 7.5, 7.7

- P1: 0
- P2: 3，當場修掉（小）：SPEC Constraints 只寫 `unknown` 時不再退回 sprint_goal（本次引進的回歸）；`(files:)` 的反斜線與 `./` 沒正規化；`SOURCE` 少了 sh/lua/zig 等副檔名
- P3: 2，未立 task：Status 取的是檔案裡第一個 `Status:` 行，不一定是開頭那行；（skill 測試缺 `cto index`/`cto docs` 已補）

## 2026-11-02 · skill 改名 cto-jev、Claude Code 的 /cto-jev

- P1: 0
- P2: 1，當場修掉：同名但沒有 cto 標記的 `.claude/commands/cto-jev.md` 會被覆寫；改成有檔無標記就不寫，並補測試
- P3: 2：skill description 說每個 agent 都能打 `/cto-jev`（已改成分 agent 寫）；`cto doctor` 不檢查 flow skill 和 `/cto-jev` 是否存在或被 git 忽略（未立 task，0.9.x 就有的缺口）

## 2026-11-02 · skill 加入 EGM 借來的 review 規則（文件 review、發現處理、self-review）

- P1: 1，當場修掉：文件 review 的 re-review 會叫 agent 在 SPEC 簽核前寫 TASKS（規則矛盾）；改成文件 review 的剩餘發現改文件或在逐段說明時提出
- P2: 13，小的當場修：文件 review 的 P2 當場改、記 REVIEW.md；嚴重度反駁也要證據；交給使用者的項目停在那裡；re-review 的 P1 當場修；release 的修正經 work 的 wave review 算 re-review；無 sub-agent 時所有 review 標 self-review；migration/rollback 寫在 Internals；改既有 SPEC 也跑文件 review；README 兩列補齊
- Re-review（只看修正）：P1 1，既有的矛盾，當場修掉：只有 main 的 repo，work 說不能直接 commit 到 release 分支、release 表說直接 commit 到 main；改成這一列是例外，main 不放 protected_branches
- 未處理：code review 裡「看不懂」能不能反駁（目前規則寫的是文件）
