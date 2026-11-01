# cto-flow

Status: approved

## 目的

讓宿主 agent（Claude Code、Codex、Gemini CLI、Cursor）扮演專案的 CTO：拆解、派工、驗收，不親自寫 code。cto CLI 守關卡，Jev API 做判斷。

## 動機

- cto 現在只在事後擋：commit、shell 指令、宣稱完成。事前的「為什麼做、做什麼、誰先做」沒有結構，agent 每次自己編。
- 既有流程框架（EGM、GSD、spec-kit）太肥：多個指令、多份模板、每個欄位都填。用兩週就被繞過。
- 文件沒有固定位置和檔名，agent 搜尋靠猜；INDEX 類的地圖手寫就過期。

## 商業規則

- cto 不產生內容。所有文字由宿主 agent 寫，所有狀態用 markdown 打勾。cto 只讀、算、檢查、擋。
- 商業決定是使用者的：CONCEPT 和 SPEC 沒有使用者簽核，不能開工。
- 一次 Jev 呼叫約 $0.00002。能用規則算的，不呼叫 Jev。
- 不是每個改動都是 feature。既有 feature 範圍內的改動只加 task。
- `unknown` 是合法欄位值；沒有證據、沒有回答的欄位不准猜。

## 不做的事

- 不派 sub-agent、不跑 review agent（宿主 agent 的事）。
- 不產生 CONCEPT、SPEC、TASKS 的內容。
- 不自動搬、刪任何文件；`cto docs` 只建議。
- 不讀 sub-agent 的 transcript；驗收靠 CTO 自己跑驗證指令。

## 使用者

- 獨立開發者或小團隊，用 coding agent 寫大部分程式碼。
- 已裝 cto 的 repo；流程是 `cto setup` 的選項，不強迫。
