# cto-flow TASKS

- [ ] FLOW-1 文件結構與 skill
  - [x] FLOW-1.1 cto-flow skill 草稿 (files: src/skill.ts, .agents/skills/cto-flow/)
        驗收: npm test
  - [x] FLOW-1.2 setup 多一個「啟用開發流程」選項，選了才寫 cto-flow skill 和 docs/cto_jev/ 骨架 (after: FLOW-1.1) (files: src/setup.ts, src/setupui.ts)
        驗收: npm test
  - [x] FLOW-1.3 setup 偵測 mkdocs.yml、docusaurus.config.* 時提醒排除 docs/cto_jev/ (after: FLOW-1.2) (files: src/setup.ts)
        驗收: npm test

- [ ] FLOW-2 INDEX 與 brief
  - [x] FLOW-2.1 TASKS.md 解析：ID、父子、after、files、驗收 (files: src/flow.ts)
        驗收: npm test
  - [x] FLOW-2.2 產生 INDEX.md；`cto index` 指令 (after: FLOW-2.1) (files: src/flow.ts, src/index.ts)
        驗收: npm test
  - [x] FLOW-2.3 brief 列 Ready、Blocked、unknown 欄位數，並重新產生 INDEX (after: FLOW-2.2) (files: src/brief.ts)
        驗收: npm test
  - [x] FLOW-2.4 brief / doctor 的一致性檢查：缺檔、files 路徑不存在、src 目錄沒歸屬、固定標題缺失 (after: FLOW-2.2) (files: src/doctor.ts, src/brief.ts)
        驗收: npm test

- [ ] FLOW-3 pre-commit 規則檢查
  - [x] FLOW-3.1 TASKS 存在但 SPEC 未 approved → 擋 (after: FLOW-2.1) (files: src/local.ts)
        驗收: npm test
  - [x] FLOW-3.2 INDEX 過期警告、after 指到不存在 ID 警告 (after: FLOW-2.2) (files: src/local.ts)
        驗收: npm test
  - [ ] FLOW-3.3 Interface 段被改 → 警告並列出依賴它的 feature (after: FLOW-2.2) (files: src/local.ts)
        驗收: npm test

- [ ] FLOW-4 Jev 漂移檢查
  - [x] FLOW-4.1 diff 路徑對 INDEX 找 feature；architecture_violation 改用該 feature Constraints + PRODUCT 不做的事 (after: FLOW-2.2) (files: src/hooks.ts)
        驗收: npm test
  - [ ] FLOW-4.2 新題：改架構卻沒新增 decisions/ (after: FLOW-4.1) (files: src/hooks.ts, src/i18n.ts)
        驗收: npm test
  - [ ] FLOW-4.3 用 calibration/ 的方式驗 FLOW-4.1 準確度 (after: FLOW-4.1) (files: calibration/)
        驗收: manual

- [ ] FLOW-5 cto docs
  - [x] FLOW-5.1 規則篩：排除清單、已知工具路徑、全勾、30 天 (files: src/docs.ts, src/index.ts)
        驗收: npm test
  - [x] FLOW-5.2 Jev 三題，輸出 併入 / 封存 / 刪除 建議 (after: FLOW-5.1) (files: src/docs.ts, src/hooks.ts)
        驗收: npm test

- [ ] FLOW-6 自己身上用
  - [x] FLOW-6.1 寫這個 repo 的 PRODUCT.md、ARCHITECTURE.md，照 SPEC 的初始化流程 (after: FLOW-1.1) (files: docs/cto_jev/)
        驗收: manual
  - [ ] FLOW-6.2 README 加「開發流程」一節 (after: FLOW-2.3, FLOW-3.1) (files: README.md)
        驗收: manual
