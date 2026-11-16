# Binsight 系統架構與詳細設計書 (System Architecture & Detailed Design)

> **版本**：v0.1.0  
> **關聯文件**：[SPECIFICATION.md](file:///home/cy023/project/binsight/SPECIFICATION.md) | [README.md](file:///home/cy023/project/binsight/README.md)

---

## 1. 系統分層架構 (Layered Architecture)

Binsight 採用 **Extension Host (Node.js 後端)** 與 **Webview (瀏覽器沙盒前端)** 雙層分離架構，全程 **零外部執行期依賴 (Zero Runtime Dependencies)**，確保可在完全離線的環境運作。

```mermaid
flowchart TB
    subgraph Disk["1. 儲存層 (Local File System)"]
        BIN["Target Binary (*.bin)<br/>支援 64MB+ 按需切片 I/O"]
        BASE_BIN["Baseline Binary (*.bin)<br/>(選配，用於雙檔 Diff)"]
        SCH["IP Schema (*.binsight.json)<br/>+ schemas/*.binsight.json (內建範本)"]
        LAY["Layout Profile (*.binsight-layout.json)"]
    end

    subgraph ExtHost["2. VS Code Extension Host (Node.js Backend)"]
        EXT["src/extension.js<br/>• CustomReadonlyEditorProvider & BinsightSidebarProvider<br/>• 載入 media/webview.html 樣板與單一 IPC 路由<br/>• onDidSaveTextDocument 熱重載監聽"]
        ANA["src/analyzer.js & src/rules.js<br/>• readFileChunk() 隨機存取切片 I/O<br/>• queryRepeatEntries() 8KB Block 對齊分頁與 1MB Chunk 掃描<br/>• scanProtocolPackets() 256KB Read-Ahead 封包掃描<br/>• evaluateEntryRules() 共用異常規則評估引擎"]
        PAR["src/registerParser.js<br/>• parseBinsightSchema() (4 種 Mode 正規化與陣列展開)<br/>• getBuiltinSchemas() (讀取 schemas/*.binsight.json)"]
    end

    subgraph Webview["3. Offline Webview Workbench (media/core.js + modes/*.js)"]
        STATE["Core & Mode Registry (media/core.js + main.js)<br/>• 64-bit BigInt 位元運算 & 2補數/IEEE754/Q-Format<br/>• 共用分頁、Split Resizer、規則命中渲染與訊息分派"]
        VIEWS["5 大獨立視圖模組 (media/modes/*.js)<br/>1. registerMap.js (多區段/Bit Grid/Diff/Edit)<br/>2. structList.js (條列清單)<br/>3. repeatStruct.js (分頁清單 + 異常標色 + 可調明細)<br/>4. protocol.js (封包清單 + 異常標色 + 32-bit 規格圖)<br/>5. hexOverview.js (4KB 分頁 + Data Inspector + Hashes)"]
    end

    BIN & BASE_BIN <== "Buffered Sync I/O" ==> ANA
    SCH & LAY --> PAR
    ANA <--> EXT
    PAR <--> EXT
    EXT <== "postMessage (JSON)" ==> STATE
    STATE <--> VIEWS
```

---

## 2. 效能與記憶體設計重點 (Performance & Memory Safeguards)

1. **零全檔載入 (Zero Full-File Memory Load)**：
   * 開啟 64 MB 甚至更大的 `.bin` 檔時，後端僅使用 `fs.statSync` 取得檔案大小，並依各模式按需切取當前視窗所需的位元組。
   * 檔案雜湊 (`computeFileHashes`) 採用 `fs.createReadStream` 串流計算（常數記憶體），且超過 64 MB 自動略過以避免開啟延遲。
2. **Repeat Struct 的 O(1) 定位與 1 MB 區塊串流掃描 (`queryRepeatEntries`)**：
   * 未套用過濾器時，直接依 `blockIdx = Math.floor(N / entriesPerBlock)` 與 `fileOffset = blockIdx * blockSize + slotIdx * entrySize` 做 O(1) 定位讀取，瞬間完成分頁。
   * 套用 `Type` 或 `Hide Empty` 過濾時，以 **1 MB Block 對齊緩衝區**循序掃描並跳過每塊尾端 Padding，僅將當前頁面的 100 筆 Entry 傳給 Webview。
3. **Protocol Scanner 的 256 KB Read-Ahead Window (`scanProtocolPackets`)**：
   * 掃描多達 50,000 筆 UPIU 封包時，透過單一重複使用的 **256 KB 預讀視窗 (`winBuf`)** 進行記憶體內解析，將原本數萬次的 `fs.readSync` 系統呼叫大幅縮減為數十次，避免 I/O 瓶頸。
4. **側邊欄單次掃描快取 (`BinsightSidebarProvider._scanAllWorkspaceFiles`)**：
   * 每次展開或重新整理側邊欄時，僅對工作區執行一次目錄遍歷（深度上限 3 層），同時分類收集 `.bin`、`*.binsight.json` 與 `*.binsight-layout.json` 並快取結果。

---

## 3. 檔案結構一覽

| 檔案路徑 | 核心職責 |
| :--- | :--- |
| [package.json](file:///home/cy023/project/binsight/package.json) | 註冊指令、Custom Editor、Activity Bar 側邊欄視圖與 JSON Schema 驗證 |
| [src/extension.js](file:///home/cy023/project/binsight/src/extension.js) | Extension 入口、載入 `webview.html`、Sidebar TreeView 與 IPC 訊息處理 |
| [src/analyzer.js](file:///home/cy023/project/binsight/src/analyzer.js) | 切片讀取、Repeat Struct / Protocol 分頁掃描、`walkWorkspaceFiles` 與 `loadSchemaFromFile` |
| [src/rules.js](file:///home/cy023/project/binsight/src/rules.js) | 共用異常規則檢查引擎 (`evaluateEntryRules`)，支援欄位與 bitfield 條件標色 |
| [src/registerParser.js](file:///home/cy023/project/binsight/src/registerParser.js) | 4 種模式的 `*.binsight.json` 與 `*.binsight-layout.json` 解析正規化 |
| [schemas/](file:///home/cy023/project/binsight/schemas) | JSON Schema 驗證定義與 8 份內建 `*.binsight.json` 範本 |
| [media/webview.html](file:///home/cy023/project/binsight/media/webview.html) | Webview 靜態 HTML 樣板 |
| [media/core.js](file:///home/cy023/project/binsight/media/core.js) | 共用 BigInt 位元運算、Hex/位址工具、分頁控制、Split Resizer 與 Mode 註冊表 |
| [media/modes/](file:///home/cy023/project/binsight/media/modes) | `registerMap.js`、`structList.js`、`repeatStruct.js`、`protocol.js`、`hexOverview.js` 獨立視圖模組 |
| [media/main.js](file:///home/cy023/project/binsight/media/main.js) | Webview 啟動協調器與 `postMessage` 分派入口 |
| [media/main.css](file:///home/cy023/project/binsight/media/main.css) | 基於 VS Code 原生主題變數的簡潔樣式、32-bit Protocol 圖示與異常嚴重度標色 |
| [scripts/package-vsix.py](file:///home/cy023/project/binsight/scripts/package-vsix.py) | 離線產生 `[0x]` `resources/icon.png` 並封裝為 `binsight-0.1.0.vsix` |
| [scripts/test-analyzer.js](file:///home/cy023/project/binsight/scripts/test-analyzer.js) | 產生 4 種模式的真實測試 `.bin` 樣本並執行端對端驗證 |
