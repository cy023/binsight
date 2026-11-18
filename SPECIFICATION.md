# Binsight 產品與格式規格書 (Product & Schema Specification)

> **版本**：v0.1.0  
> **定位**：離線版 VS Code 多模式硬體暫存器、結構清單、大檔分頁與通訊協定二進位檢測工具

---

## 1. 系統目標與四大解析模式 (Core Modes)

**Binsight** 採用單一標準格式 **`*.binsight.json`** 驅動所有解析邏輯（搭配 VS Code 原生離線 JSON Schema 驗證與自動補全），支援以下 **4 種 Schema 解析模式** 及 **Hex Editor**：

| 模式 (`mode`) | 適用場景 | 核心能力與互動設計 | 範例檔案 (`samples/`) |
| :--- | :--- | :--- | :--- |
| **Hex Editor** | 原始記憶體位元組檢視與修補 | • 可調任意每行長度 (`1–128 B`) 與每頁大小 (`16–65536 B`) 之按需分頁檢視、可收合 SHA-256 / MD5 校驗<br/>• 支援 **Find Hex / Text** 搜尋、拖曳／`Shift+Click` 多位元組選取、一鍵複製 (`c`) 與 `↩ Back` (`Alt+←`) 返回<br/>• 支援 **Edit Mode**（`Hex` Nibble / `Text` ASCII 雙輸入模式 + `Ctrl+V` 貼上覆寫），並透過後端工作複本即時同步至其餘 4 個解析分頁<br/>• 支援全域 **Compare**（可選檔案或貼上 Hex/Text 作為 Baseline），提供差異計數、`◀ Diff / Diff ▶` 跨頁跳轉與原值 Tooltip | 二進位檔 (`.bin`/`.raw`/`.dat`) 與文字 Hex 檔 (`.hex`/`.txt`) |
| **Struct View** (`struct-view`) | 固定大小韌體標頭、Boot Descriptor、設定檔 | • 將二進位結構解析為精簡的單行條列清單 (`Offset`, `Member`, `Size/Type`, `Value`, `Raw Hex`, `Description`)<br/>• 支援 **Baseline Diff** 欄位級差異標色與前後值對照 | [fw_header_struct.bin](file:///home/cy023/project/binsight/samples/fw_header_struct.bin)<br/>[fw_header_modified.hex](file:///home/cy023/project/binsight/samples/fw_header_modified.hex) |
| **Record Trace** (`record-trace`) | 64 MB+ 大型 Trace / Event Log（含 Block Padding 與多型別 Entry） | • 支援 `blockSize` 與 `entrySize`（例如 `8192 B` 區塊內含 `72 B` Entry，自動跳過每塊尾端 `56 B` Padding）<br/>• 支援 `discriminator` 多型別切換（如 `0x01 CMD_SUBMIT`, `0x02 IO_COMPLETE`, `0xFF EMPTY_SLOT`）<br/>• 後端分頁讀取 (`100` 筆/頁)、Type 過濾、`Hide Empty`、`Anomalies`、異常計數與 `◀ Err / Err ▶` 跳轉、`Block` 跳轉<br/>• 預設全寬緊湊清單，點擊 Entry 才展開可調中線的側邊明細欄 | [repeat_trace_72b_8k.bin](file:///home/cy023/project/binsight/samples/repeat_trace_72b_8k.bin) |
| **Protocol Analyze** (`protocol-analyze`) | 多封包通訊協定 Trace（如 **UFS UPIU + SCSI CDB**） | • 支援掃描最多 50,000 筆連續封包（支援變動 `Data Segment Length` 框架與分頁）<br/>• 工具列支援 **`Packet #`** 跳轉、封包類型與 `Anomalies` 篩選、異常計數與 `◀ Err / Err ▶` 跨頁跳轉、欄位名稱搜尋<br/>• 預設 50/50 置中分割，右側以 **32-bit 寬度規格方塊圖**呈現；支援 `subVariants`（如 `COMMAND UPIU` 依 `CDB[0]` 展開 15 種 SCSI CDB）與宣告式 `payloadSchemas`（`Sense Data` / `UFS Descriptors` 結構化解析 + 可摺疊 Raw Hex/ASCII） | [ufs_upiu_trace.bin](file:///home/cy023/project/binsight/samples/ufs_upiu_trace.bin)<br/>[ufs_upiu_full_trace.bin](file:///home/cy023/project/binsight/samples/ufs_upiu_full_trace.bin) |
| **Registers** (`registers`, 預設) | SoC 多 IP 暫存器傾印、PMIC、感測器 Struct | • 支援多區段 (`*.binsight-layout.json`)、雙軌位址 (`HW Base` + `File Offset`)<br/>• `count`/`stride` 陣列、`groups` 通道篩選與 **Pin 常用暫存器置頂 / Pinned Only**<br/>• 偏離 `resetValue` 與 `Baseline` 雙檔 Diff 高亮<br/>• 預設 Read-Only，可選開啟 Edit Mode 並透過 Save As... 另存修補後的檔案 | [scenario1_soc_crash.bin](file:///home/cy023/project/binsight/samples/scenario1_soc_crash.bin)<br/>[scenario1_soc_golden.bin](file:///home/cy023/project/binsight/samples/scenario1_soc_golden.bin) |

---

## 2. VS Code 整合功能規格

1. **左側活動列 (Activity Bar) 側邊欄視圖**：
   * 使用單色向量 `[0x]` 圖示 ([sidebar-icon.svg](file:///home/cy023/project/binsight/resources/sidebar-icon.svg))，自動列出工作區內的 `.bin`/`.raw`/`.dat`、`**/*.binsight.json` 與 `**/*.binsight-layout.json`，點擊即可直接開啟檢視或編輯。
2. **直接左鍵開啟二進位檔 (`CustomReadonlyEditorProvider`)**：
   * 點擊任意 `.bin` / `.raw` / `.dat` 檔案即自動以 Binsight 面板開啟，並依檔名與工作區設定智慧匹配對應的模式與 Schema。
3. **原生 Schema 編輯與熱重載 (`Edit JSON`)**：
   * 點擊 `Edit JSON` 於側邊分頁開啟 `*.binsight.json`（享離線語法補全），存檔 (`Ctrl+S`) 時面板自動熱重載並即時刷新解碼結果。
4. **跨視圖聯動、鍵盤導覽與狀態持久化**：
   * **Jump to Hex Editor**：點擊 `Registers`、`Struct View`、`Record Trace` 或 `Protocol Analyze` 中的 Offset 標記，即可切換至 `Hex Editor` 並高亮對應位元組範圍。
   * **快捷鍵**：`1`–`5` 切換分頁、`/` 或 `Ctrl/Cmd+F` 聚焦搜尋/跳轉框、`Esc` 關閉選單或失焦；`↑`/`↓` 瀏覽 `Record Trace` 與 `Protocol Analyze` 清單；方向鍵移動 `Hex Editor` 游標（自動跨頁）。
   * **狀態持久化**：透過 `vscode.setState()` 記憶當前分頁、Split 寬度、介面縮放比例 (`90%–140%`) 與各模式 Schema/Offset/篩選條件。
5. **免開檔貼上解析 (`Paste Hex / Text` & `Inspect Pasted Hex / Text`)**：
   * 可直接貼上多行 Hex Dump、Intel HEX 或純文字 (UTF-8) 載入全 5 個分頁解析，無須先建立實體檔案。

---

## 3. `*.binsight.json` 核心結構摘要

* **Common Root**: `mode` (`"registers" | "struct-view" | "record-trace" | "protocol-analyze"`), `name`, `description`, `endianness` (`"little" | "big"`), `baseAddress`
* **Mode `registers`**: `registers[]` (`offset`, `size`, `count`, `stride`, `access`, `resetValue`, `fields[]`), `groups[]` (`offset`, `count`, `stride`, `registers[]`)
* **Mode `struct-view`**: `fields[]` (`name`, `offset`, `size`, `endianness?`, `type`, `unit`, `enums`, `scale`, `qFormat`, `formula?`, `description`)
* **Mode `record-trace`**: `blockSize`, `entrySize`, `discriminator` (`offset`, `size`, `mask`), `variants` (`"0x01": { name, skip, summaryFields, embeddedProtocol?, rules[], fields[] }`), `defaultVariant`
* **Mode `protocol-analyze`**: `wordWidth`, `packetFraming` (`headerSize`, `ehsLenOffset`, `dataSegLenOffset`), `discriminator`, `payloadSchemas` (`{ [key]: { name, endianness?, fields[] } }`), `variants` (`"0x01": { name, rules[], payloadRef?, subVariants?, rows: [{ row, fields: [{ name, bits, type, enums, reserved }] }] }`)
* **異常檢查規則 (`rules[]`, 適用於 `record-trace` 與 `protocol-analyze`)**: `{ field?, offset?, size?, msb?, lsb?, op: "eq"|"ne"|"gt"|"gte"|"lt"|"lte"|"bitmask_any"|"bitmask_all", value, severity: "error"|"warn"|"info", message }`，命中時自動於列表與明細面板標色顯示
