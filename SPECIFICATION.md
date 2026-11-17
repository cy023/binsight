# Binsight 產品與格式規格書 (Product & Schema Specification)

> **版本**：v0.1.0  
> **定位**：離線版 VS Code 多模式硬體暫存器、結構清單、大檔分頁與通訊協定二進位檢測工具

---

## 1. 系統目標與四大解析模式 (Core Modes)

**Binsight** 採用單一標準格式 **`*.binsight.json`** 驅動所有解析邏輯（搭配 VS Code 原生離線 JSON Schema 驗證與自動補全），支援以下 **4 種解析模式** 及 **Paged Hex Dump**：

| 模式 (`mode`) | 適用場景 | 核心能力與互動設計 | 範例檔案 (`samples/`) |
| :--- | :--- | :--- | :--- |
| **Registers** (`register-map`, 預設) | SoC 多 IP 暫存器傾印、PMIC、感測器 Struct | • 支援多區段 (`*.binsight-layout.json`)、雙軌位址 (`HW Base` + `File Offset`)<br/>• `count`/`stride` 陣列、`groups` 通道篩選與 **Pin 常用暫存器置頂 / Pinned Only**<br/>• 偏離 `resetValue` 與 `Baseline .bin` 雙檔 Diff 高亮<br/>• 預設 Read-Only，可選開啟 Edit Mode 並另存修補後的 `.bin` | [scenario1_soc_crash.bin](file:///home/cy023/project/binsight/samples/scenario1_soc_crash.bin)<br/>[scenario1_soc_golden.bin](file:///home/cy023/project/binsight/samples/scenario1_soc_golden.bin) |
| **Struct View** (`struct-list`) | 固定大小韌體標頭、Boot Descriptor、設定檔 | • 將二進位結構解析為精簡的單行條列清單 (`Offset`, `Member`, `Size/Type`, `Value`, `Raw Hex`, `Description`) | [fw_header_struct.bin](file:///home/cy023/project/binsight/samples/fw_header_struct.bin) |
| **Record Trace** (`repeat-struct`) | 64 MB+ 大型 Trace / Event Log（含 Block Padding 與多型別 Entry） | • 支援 `blockSize` 與 `entrySize`（例如 `8192 B` 區塊內含 `72 B` Entry，自動跳過每塊尾端 `56 B` Padding）<br/>• 支援 `discriminator` 多型別切換（如 `0x01 CMD_SUBMIT`, `0x02 IO_COMPLETE`, `0xFF EMPTY_SLOT`）<br/>• 後端分頁讀取 (`100` 筆/頁)、Type 過濾、`Hide Empty`、`Anomalies`、異常計數與 `◀ Err / Err ▶` 跳轉、`Block` 跳轉<br/>• 預設全寬緊湊清單，點擊 Entry 才展開可調中線的側邊明細欄 | [repeat_trace_72b_8k.bin](file:///home/cy023/project/binsight/samples/repeat_trace_72b_8k.bin) |
| **Packet Stream** (`protocol`) | 多封包通訊協定 Trace（如 **UFS UPIU**） | • 支援掃描最多 50,000 筆連續封包（支援變動 `Data Segment Length` 框架與分頁）<br/>• 工具列支援 **`Entry #`** 跳轉、封包類型與 `Anomalies` 篩選、異常計數與 `◀ Err / Err ▶` 跨頁跳轉、欄位名稱搜尋<br/>• 預設 50/50 置中分割，右側以 **32-bit 寬度規格方塊圖**呈現並支援與明細表雙向點擊同步高亮 | [ufs_upiu_trace.bin](file:///home/cy023/project/binsight/samples/ufs_upiu_trace.bin) |
| **Hex Editor** | 原始記憶體位元組檢視與修補 | • 可調任意每行長度 (`1–128 B`) 與每頁大小 (`16–65536 B`) 之按需分頁檢視、可收合 SHA-256 / MD5 校驗<br/>• 支援 **Find Hex / Text** 搜尋、拖曳／`Shift+Click` 多位元組選取、一鍵複製 (`c`) 與 `↩ Back` (`Alt+←`) 返回<br/>• 支援 **Edit 模式**（直接鍵入 Hex Nibble 修補並另存 `.bin`）與全域 **Baseline `.bin` 差異標示** | 二進位檔 (`.bin`/`.raw`/`.dat`) 與文字 Hex 檔 (`.hex`/`.txt`) |

---

## 2. VS Code 整合功能規格

1. **左側活動列 (Activity Bar) 側邊欄視圖**：
   * 使用單色向量 `[0x]` 圖示 ([sidebar-icon.svg](file:///home/cy023/project/binsight/resources/sidebar-icon.svg))，自動列出工作區內的 `.bin`/`.raw`/`.dat`、`**/*.binsight.json` 與 `**/*.binsight-layout.json`，點擊即可直接開啟檢視或編輯。
2. **直接左鍵開啟二進位檔 (`CustomReadonlyEditorProvider`)**：
   * 點擊任意 `.bin` / `.raw` / `.dat` 檔案即自動以 Binsight 面板開啟，並依檔名與工作區設定智慧匹配對應的模式與 Schema。
3. **原生 Schema 編輯與熱重載 (`Edit JSON`)**：
   * 點擊 `Edit JSON` 於側邊分頁開啟 `*.binsight.json`（享離線語法補全），存檔 (`Ctrl+S`) 時面板自動熱重載並即時刷新解碼結果。
4. **跨視圖聯動、鍵盤導覽與狀態持久化**：
   * **Jump to Hex**：點擊 `Register Map`、`Struct List`、`Repeat Struct` 或 `Protocol Diagram` 中的 Offset 標記，即可切換至 `Hex Dump` 並高亮對應位元組範圍。
   * **快捷鍵**：`1`–`5` 切換分頁、`/` 或 `Ctrl/Cmd+F` 聚焦搜尋/跳轉框、`Esc` 關閉選單或失焦；`↑`/`↓` 瀏覽 `Repeat Struct` 與 `Protocol` 清單；方向鍵移動 `Hex Dump` 游標（自動跨頁）。
   * **狀態持久化**：透過 `vscode.setState()` 記憶當前分頁、Split 寬度、各模式 Schema/Offset/篩選條件與 Data Inspector Endianness。

---

## 3. `*.binsight.json` 核心結構摘要

* **Common Root**: `mode` (`"register-map" | "struct-list" | "repeat-struct" | "protocol"`), `name`, `description`, `endianness` (`"little" | "big"`), `baseAddress`
* **Mode `register-map`**: `registers[]` (`offset`, `size`, `count`, `stride`, `access`, `resetValue`, `fields[]`), `groups[]` (`offset`, `count`, `stride`, `registers[]`)
* **Mode `struct-list`**: `fields[]` (`name`, `offset`, `size`, `type`, `unit`, `enums`, `scale`, `qFormat`, `description`)
* **Mode `repeat-struct`**: `blockSize`, `entrySize`, `discriminator` (`offset`, `size`, `mask`), `variants` (`"0x01": { name, skip, summaryFields, rules[], fields[] }`), `defaultVariant`
* **Mode `protocol`**: `wordWidth`, `packetFraming` (`headerSize`, `ehsLenOffset`, `dataSegLenOffset`), `discriminator`, `variants` (`"0x01": { name, rules[], rows: [{ row, fields: [{ name, bits, type, enums, reserved }] }] }`)
* **異常檢查規則 (`rules[]`, 適用於 `repeat-struct` 與 `protocol`)**: `{ field?, offset?, size?, msb?, lsb?, op: "eq"|"ne"|"gt"|"gte"|"lt"|"lte"|"bitmask_any"|"bitmask_all", value, severity: "error"|"warn"|"info", message }`，命中時自動於列表與明細面板標色顯示
