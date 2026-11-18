# Binsight - Hardware Register, Struct & Protocol Binary Inspector (`v0.1.0`)

**Binsight** is a zero-dependency, offline-first VS Code extension for inspecting, decoding, and patching **Register Maps, Struct Lists, 64MB+ Paged Repeat Structs, and Communication Protocol Diagrams (e.g., UFS UPIU)** from raw binaries (`*.bin` / `*.raw` / `*.dat`) or text hex files (`*.hex` / text-hex `*.txt`, including Intel HEX and free-form hex dumps).

## Supported Parsing Modes

1. **Hex Editor**
   - Configurable on-demand hex viewer (arbitrary `1–128` bytes per row; `16–65536` bytes per page) with **Find Hex / Text**, drag / `Shift+Click` multi-byte range selection, inline **Hex Edit Mode** (`0-9`/`A-F` nibble editing + `Save .bin`), **Baseline `.bin` diff highlighting**, one-click copy (`c`), and collapsible SHA-256 / MD5 checksums.
2. **Struct View (`mode: "struct-view"`)**
   - Parses fixed binary headers or structs into a clean tabular member list.
3. **Record Trace (`mode: "record-trace"`)**
   - Designed for large files (64 MB+) with block/page padding (e.g., `72-byte` entries inside `8 KB` blocks, automatically skipping the `56-byte` remainder padding per block).
   - Supports polymorphic entry types via a `discriminator` field, type filtering, `Hide Empty`, `Anomalies`, anomaly jump bar (`◀ Err` / `Err ▶`), `Block` jumping, and an on-demand resizable side detail pane.
4. **Protocol Analyze (`mode: "protocol-analyze"`)**
   - Scans multi-packet streams (e.g., **UFS UPIU** with variable `Data Segment Length`) with pagination, `Packet #` stepping, packet type & `Anomalies` filtering, and anomaly jump bar (`◀ Err` / `Err ▶`).
   - Renders a centered, resizable **32-bit-wide JEDEC/RFC Specification Diagram** (`Byte +0..+3` / `Bit 31..0`) with field search and bidirectional Diagram ↔ Fields Table highlight sync.
5. **Registers (`mode: "registers"`)**
   - Multi-segment non-contiguous IP inspection with `*.binsight-layout.json` profiles.
   - Dual addressing: **Hardware Base Address** (`HW 0x40000000`) + **File Offset** (`@0x0000`).
   - Supports `count`/`stride` arrays, repeating `groups` (e.g., `CH[0..3]`), LE/BE switching, **Pin Registers** (`Pin` / `Pinned Only`), Reset/Baseline diffing, Read-Only default, and optional Edit Mode + Save As...

## UI/UX & Keyboard Shortcuts

- **Global Baseline Diff**: Click **Compare** in the top bar from any tab to highlight differences across **Registers** and **Hex Editor**.
- **Cross-Tab Jump & Return**: Click any offset badge/link in **Registers**, **Struct View**, **Record Trace**, or **Protocol Analyze** to jump directly to the exact byte range in **Hex Editor**; click **↩ Back** (or press `Alt+←`) to return.
- **State Persistence**: Remembers the active tab, split-pane widths, selected schemas, offsets, and filters across panel switches.
- **Keyboard Navigation**:
  - `1` – `5`: Switch between the 5 inspector tabs.
  - `/` or `Ctrl+F` (`Cmd+F`): Focus the active tab's search or jump input; `Esc` blurs or closes menus.
  - `↑` / `↓`: Step through **Record Trace** entries or **Protocol Analyze** packets (across pages).
  - `←` / `→` / `↑` / `↓`: Move the cursor in **Hex Editor** (seamlessly crossing 4 KB page boundaries).

## VS Code Integration

- **Activity Bar Sidebar (`[0x] Binsight`)**: Browse and open workspace `.bin` / `.raw` / `.dat` files, `*.binsight.json` schemas, and `*.binsight-layout.json` profiles.
- **Direct Binary Open**: Left-clicking any `.bin` / `.raw` / `.dat` file opens directly in Binsight (`CustomReadonlyEditorProvider`).
- **Schema Hot-Reload**: Clicking **`Edit JSON`** opens `*.binsight.json` in a side editor with offline IntelliSense; saving (`Ctrl+S`) automatically hot-reloads the Binsight view.

## Offline Packaging & Installation

Single cross-platform command (packages `.vsix` and installs into VS Code):

```bash
# Windows
python scripts/install-vsix.py

# Linux / macOS
python3 scripts/install-vsix.py
```

Then in VS Code, run **Developer: Reload Window** (`Ctrl+Shift+P`).
