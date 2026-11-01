# your-cto-jev PRODUCT

Status: approved

## 一句話

一個嘴很壞的 CTO，審查 coding agent 將要做的事，然後說不。(from: README.md)

## 使用者角色

- 用 coding agent 寫大部分程式碼的獨立開發者 (asked)
- 小團隊的 tech lead：設一次規則，commit 進 repo，所有人的 agent 都遵守 (asked)
- 企業平台團隊：統一多個 repo 的 agent 行為 (asked)

## 怎麼賺錢

不賺錢。MIT、npm 免費；Jev 的費用由使用者自己的 provider 帳號付（OpenRouter、TypeSafe、Cloudflare）。(asked)

## 方案與限制

無付費方案，不適用。(asked)

## 不做的事

- 不產生內容：文件、程式碼、修正都由宿主 agent 寫，cto 只讀、算、檢查、擋。(asked)
- 不做會阻擋的主觀判斷：架構、複雜度只警告。(asked)
- 沒有伺服器或雲端元件：一切在本機和 git 裡，Jev 只收到遮罩過的 state。(asked)
- 不自動搬刪檔案：`cto docs` 只建議。(asked)

## 設計約束

- 終端機輸出一個畫面內放得下。(from: README.md)
- 訊息依 locale 出 English 或繁體中文。(from: README.md)
- 沒事就不出聲：沒跨過門檻時什麼都不印。(from: README.md)
- 永遠 fail open：provider 全掛、沒 key、請求格式錯，都放行。(from: README.md)
