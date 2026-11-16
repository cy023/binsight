# Binsight 產品與格式規格書 (Product & Schema Specification)

> **版本**：v0.1.0  
> **定位**：離線版 VS Code 多模式硬體暫存器、結構清單、大檔分頁與通訊協定二進位檢測工具

---

## 1. 系統目標與四大解析模式 (Core Modes)

**Binsight** 採用單一標準格式 **`*.binsight.json`** 驅動所有解析邏輯（搭配 VS Code 原生離線 JSON Schema 驗證與自動補全），支援以下 **4 種解析模式** 及 **Paged Hex Dump**：

| 模式 (`mode`) | 適用場景 | 核心能力與互動設計 | 範例檔案 (`samples/`) |
| :--- | :--- | :--- | :--- |
| **`register-map`**<br/>(預設) | SoC 多 IP 暫存器傾印、PMIC、感測器 Struct | • 支援多區段 (`*.binsight-layout.json`)、雙軌位址 (`HW Base` + `File Offset`)<br/>• `count`/`stride` 陣列與 `groups` 通道篩選<br/>• 偏離 `resetValue` 與 `Baseline .bin` 雙檔 Diff 高亮<br/>• 預設 Read-Only，可選開啟 Edit Mode 並另存修補後的 `.bin` | [scenario1_soc_crash.bin](file:///home/cy023/project/binsight/samples/scenario1_soc_crash.bin)<br/>[scenario1_soc_golden.bin](file:///home/cy023/project/binsight/samples/scenario1_soc_golden.bin) |
| **`struct-list`** | 固定大小韌體標頭、Boot Descriptor、設定檔 | • 將二進位結構解析為精簡的單行條列清單 (`Offset`, `Member`, `Size/Type`, `Value`, `Raw Hex`, `Description`) | [fw_header_struct.bin](file:///home/cy023/project/binsight/samples/fw_header_struct.bin) |
| **`repeat-struct`** | 64 MB+ 大型 Trace / Event Log（含 Block Padding 與多型別 Entry） | • 支援 `blockSize` 與 `entrySize`（例如 `8192 B` 區塊內含 `72 B` Entry，自動跳過每塊尾端 `56 B` Padding）<br/>• 支援 `discriminator` 多型別切換（如 `0x01 CMD_SUBMIT`, `0x02 IO_COMPLETE`, `0xFF EMPTY_SLOT`）<br/>• 後端分頁讀取 (`100` 筆/頁)、Type 過濾、`Hide Empty/Skip`、`Block #` 跳轉<br/>• 預設全寬緊湊清單，點擊 Entry 才展開可調中線的側邊明細欄 | [repeat_trace_72b_8k.bin](file:///home/cy023/project/binsight/samples/repeat_trace_72b_8k.bin) |
| **`protocol`** | 多封包通訊協定 Trace（如 **UFS UPIU**） | • 支援掃描最多 50,000 筆連續封包（支援變動 `Data Segment Length` 框架與分頁）<br/>• 工具列支援 **`Entry #`** 直接輸入/步進跳轉、封包類型篩選<br/>• 右側以 **32-bit 寬度規格方塊圖**（`Compact S` / `Medium M` / `Large L` 可調尺寸 + 可拖曳寬度 + 可調整左右中線）呈現，並可勾選顯示下方明細表 | [ufs_upiu_trace.bin](file:///home/cy023/project/binsight/samples/ufs_upiu_trace.bin) |
| **Hex Dump** | 原始記憶體位元組檢視 | • 4 KB 按需分頁讀取、Byte 類別著色（`0x00` Null / ASCII / Control / High Bytes）、單點 Data Inspector、SHA-256 / MD5 校驗 | 所有二進位檔皆支援 |

---

## 2. VS Code 整合功能規格

1. **左側活動列 (Activity Bar) 側邊欄視圖**：
   * 使用單色向量 `[0x]` 圖示 ([sidebar-icon.svg](file:///home/cy023/project/binsight/resources/sidebar-icon.svg))，自動列出工作區內的 `.bin`/`.raw`/`.dat`、`**/*.binsight.json` 與 `**/*.binsight-layout.json`，點擊即可直接開啟檢視或編輯。
2. **直接左鍵開啟二進位檔 (`CustomReadonlyEditorProvider`)**：
   * 點擊任意 `.bin` / `.raw` / `.dat` 檔案即自動以 Binsight 面板開啟，並依檔名與工作區設定智慧匹配對應的模式與 Schema。
3. **原生 Schema 編輯與熱重載 (`Edit JSON`)**：
   * 點擊 `Edit JSON` 於側邊分頁開啟 `*.binsight.json`（享離線語法補全），存檔 (`Ctrl+S`) 時面板自動熱重載並即時刷新解碼結果。

---

## 3. `*.binsight.json` 核心結構摘要

* **Common Root**: `mode` (`"register-map" | "struct-list" | "repeat-struct" | "protocol"`), `name`, `description`, `endianness` (`"little" | "big"`), `baseAddress`
* **Mode `register-map`**: `registers[]` (`offset`, `size`, `count`, `stride`, `access`, `resetValue`, `fields[]`), `groups[]` (`offset`, `count`, `stride`, `registers[]`)
* **Mode `struct-list`**: `fields[]` (`name`, `offset`, `size`, `type`, `unit`, `enums`, `scale`, `qFormat`, `description`)
* **Mode `repeat-struct`**: `blockSize`, `entrySize`, `discriminator` (`offset`, `size`, `mask`), `variants` (`"0x01": { name, skip, summaryFields, rules[], fields[] }`), `defaultVariant`
* **Mode `protocol`**: `wordWidth`, `packetFraming` (`headerSize`, `ehsLenOffset`, `dataSegLenOffset`), `discriminator`, `variants` (`"0x01": { name, rules[], rows: [{ row, fields: [{ name, bits, type, enums, reserved }] }] }`)
* **異常檢查規則 (`rules[]`, 適用於 `repeat-struct` 與 `protocol`)**: `{ field?, offset?, size?, msb?, lsb?, op: "eq"|"ne"|"gt"|"gte"|"lt"|"lte"|"bitmask_any"|"bitmask_all", value, severity: "error"|"warn"|"info", message }`，命中時自動於列表與明細面板標色顯示
