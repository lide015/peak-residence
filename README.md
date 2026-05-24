# PEAK RESIDENCE CRM

繁體中文房仲管理系統 · React + Supabase + Vercel

---

## 部署流程（Step 2-4）

### Step 2：把專案放上 GitHub

#### 2-1. 註冊 / 登入 GitHub

到 [github.com](https://github.com) 註冊一個帳號（如果還沒有）。

#### 2-2. 安裝 GitHub Desktop（GUI 工具，免 terminal）

到 [desktop.github.com](https://desktop.github.com) 下載並安裝。打開後用你的 GitHub 帳號登入。

#### 2-3. 建立新 Repository

在 GitHub Desktop：

1. **File → New repository**
2. 填寫：
   - Name: `peak-residence`
   - Description: `房仲 CRM 系統`
   - Local path: 選一個你電腦上的位置（記住這個位置！）
   - **不要勾** Initialize with README
3. 按 **Create repository**

#### 2-4. 把專案檔案放進去

打開你剛才選的 Local path 那個資料夾——應該是空的（或只有一個隱藏的 `.git` 資料夾）。

**把這份解壓縮後 peak-residence 資料夾裡的所有東西**（package.json, src/, index.html, .gitignore 等）**複製進去**。

> ⚠️ 注意：`.env.example` 要複製，但**不要**建立 `.env.local`（這個檔案會包含你的 Supabase 金鑰，不能上 GitHub。等部署到 Vercel 時才填）

#### 2-5. Push 到 GitHub

回到 GitHub Desktop，你應該會看到所有檔案被列出來（左側欄顯示「30+ changed files」之類）。

1. 左下角 Summary 填：`初始版本`
2. 按 **Commit to main**
3. 上方按 **Publish repository**
4. 取消勾選「Keep this code private」（除非你要付費的私有 repo；公開不要緊，你的 secret 不在裡面）
5. 按 **Publish Repository**

完成！打開 [github.com](https://github.com) 應該能看到你的 `peak-residence` repo。

---

### Step 3：連 Vercel 部署

#### 3-1. 註冊 Vercel

到 [vercel.com](https://vercel.com) → **Sign Up** → 用 **GitHub 帳號**登入（這樣它能讀取你的 repo）。

#### 3-2. 匯入專案

登入後，點 **Add New** → **Project**。

你會看到 GitHub repo 列表，找到 `peak-residence`，按 **Import**。

#### 3-3. 設定環境變數（最重要的一步）

Vercel 的 Import 頁面下方有 **Environment Variables** 區塊，把 Step 1 拿到的 Supabase 兩個值填進去：

| Name | Value |
|---|---|
| `VITE_SUPABASE_URL` | （你的 Project URL，例如 `https://abcdefgh.supabase.co`）|
| `VITE_SUPABASE_ANON_KEY` | （你的 anon public key，那串以 `eyJ` 開頭的）|

> ⚠️ 變數名稱**一字不能錯**，前面的 `VITE_` 也必須有，否則前端讀不到。

#### 3-4. Deploy！

下方按 **Deploy**。Vercel 會跑 build（約 1-2 分鐘），完成後你會看到一個慶祝畫面跟一個網址。

點那個網址，**你的房仲網站就上線了**！

---

### Step 4：第一次使用

打開你的 `xxx.vercel.app` 網址：

1. 看到前台（PEAK RESIDENCE 樣板）但所有物件是 demo 資料
2. 按 `Ctrl/Cmd + .`（句號）或頁尾品牌名連點 3 次進入登入頁
3. 點 **「第一次來？建立新帳號」**
4. 用你的 email 註冊（密碼至少 6 字元）
5. **去信箱收驗證信、點裡面的連結**
6. 回到網站，用剛註冊的 email 登入
7. 進入後台後，所有改動會即時同步到 Supabase 雲端

---

## 開發備忘（進階）

如果你之後要修改程式碼，或在本地測試：

### 需要 Node.js

到 [nodejs.org](https://nodejs.org) 下載 LTS 版本安裝。

### 本地跑

開啟 terminal/命令提示字元，進到 peak-residence 資料夾：

```bash
npm install         # 第一次需要，下載依賴
cp .env.example .env.local   # 複製範本
# 編輯 .env.local，填入你的 Supabase URL 和 anon key
npm run dev         # 啟動，會在 http://localhost:5173 開啟
```

修改 `src/App.jsx`，瀏覽器會自動 reload。

### Push 改動 = 自動部署

任何 commit 並 push 到 GitHub 的 main branch，Vercel 都會**自動重新 build 並部署**。你完全不用做任何事，網站就更新了。

---

## 架構說明

```
peak-residence/
├── src/
│   ├── App.jsx              # 主應用（前台+後台+所有功能）
│   ├── lib/supabase.js      # Supabase client 初始化
│   ├── main.jsx             # React 入口
│   └── index.css            # Tailwind 樣式
├── index.html               # HTML 入口
├── package.json             # 依賴定義
├── vite.config.js           # Vite 設定
├── tailwind.config.js       # Tailwind 設定
└── .env.example             # 環境變數範本
```

### 資料流

```
使用者改資料
   ↓
React setData
   ↓
useEffect 偵測到變化
   ↓
debounce 0.8 秒（避免每打一字就送一次）
   ↓
supabase.from('app_data').upsert(...)
   ↓
寫入 PostgreSQL
   ↓
其他裝置下次開啟時 fetch 到最新資料
```

### 安全性

- 前端永遠不會接觸到 service_role key（管理員金鑰）
- anon key 即使外洩也沒關係——Row Level Security 限制只有登入後的使用者可以寫自己的 row
- 訪客（未登入）只能讀，無法新增/修改/刪除任何資料
- 密碼由 Supabase Auth 用 bcrypt 雜湊存放，前後端都看不到明文

---

## 後續可加強

當系統穩定後可以考慮：

- **自訂網域**：把 `xxx.vercel.app` 換成 `peakresidence.tw`（年費約 NT$500-800）
- **圖片儲存升級**：目前圖片用 base64 存在 JSONB，量大會慢。可改用 Supabase Storage（free tier 1GB 夠用很久）
- **密碼重設 email**：Supabase 已內建，只要做個「忘記密碼」按鈕呼叫 `supabase.auth.resetPasswordForEmail()`
- **物件分享連結**：每個物件給一個 `/property/[id]` 路由，傳給客戶直接看單一物件
- **手機 RWD 調整**：目前後台 desktop-first，手機看略擠

---

有問題隨時回到 Claude 對話繼續討論。
