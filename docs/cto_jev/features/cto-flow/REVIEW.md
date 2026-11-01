# cto-flow REVIEW

## 2026-11-02 · release review `f49677c..HEAD`（FLOW-1 到 FLOW-6）

兩位零上下文 reviewer，各看一半的檔案，對照 CONCEPT.md / SPEC.md。

- P1: 2，已修（同一個 commit）
  - `flow_signoff` 用 `startsWith` 比對 `(files:)`：`src/auth` 會擋到 `src/authz/`；`Status: Approved` 大寫被當未簽核。改成目錄邊界比對、大小寫不分（local.ts、flow.ts）。
  - `architecture_undocumented` 的題目把「加一個外部相依」當成要決策紀錄，裝個套件就警告。題目改成「產品新依賴的外部系統或 SDK」，明說套件匯入與版本升級不算。
- P2: 12 → FLOW-7.1 ~ FLOW-7.7
- P3: 6，未立 task：`overlaps` 在 flow.ts 與 brief.ts 各一份；`flowInterface` 迴圈內重複 `featureIndex`；`cto index` 在沒有 features/ 的 repo 說 up to date；`驗收:` 會黏到前一個有 ID 的 task；`cto docs` 的 EXCLUDED 用 basename 比對會多排除子目錄的 README；README rules table 那行和寫進 CLAUDE.md 的 FLOW_RULE 用字不同（併入 FLOW-7.5）。
- 結論：P1 修完可發；FLOW-7 在發版前做完 7.1 ~ 7.6。
