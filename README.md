# Binsight - Hardware Register, Struct & Protocol Binary Inspector (`v0.1.0`)

**Binsight** is a zero-dependency, offline-first VS Code extension for inspecting, decoding, and patching **Register Maps, Struct Lists, 64MB+ Paged Repeat Structs, and Communication Protocol Diagrams (e.g., UFS UPIU)**.

## Supported Parsing Modes

1. **Register Map (`mode: "register-map"`)**
   - Multi-segment non-contiguous IP inspection with `*.binsight-layout.json` profiles.
   - Dual addressing: **Hardware Base Address** (`HW 0x40000000`) + **File Offset** (`@0x0000`).
   - Supports `count`/`stride` arrays, repeating `groups` (e.g., `CH[0..3]`), LE/BE switching, Reset/Baseline `.bin` diffing, Read-Only default, and optional Edit Mode + Save As New `.bin`.
2. **Struct List (`mode: "struct-list"`)**
   - Parses fixed binary headers or structs into a clean tabular member list.
3. **Repeat Struct (`mode: "repeat-struct"`)**
   - Designed for large files (64 MB+) with block/page padding (e.g., `72-byte` entries inside `8 KB` blocks, automatically skipping the `56-byte` remainder padding per block).
   - Supports polymorphic entry types via a `discriminator` field, type filtering, `Block #` jumping, and an on-demand resizable side detail pane.
4. **Protocol Diagram (`mode: "protocol"`)**
   - Scans multi-packet streams (e.g., **UFS UPIU** with variable `Data Segment Length`) with pagination and Entry `#` stepping.
   - Renders a resizable **32-bit-wide JEDEC/RFC Specification Diagram** (`Byte +0..+3` / `Bit 31..0`) with proportional field boxes and an optional decoded fields table.
5. **Hex Dump**
   - Paged 4 KB on-demand hex viewer with byte-category color coding (`0x00` Null, Printable ASCII, Control Chars, High Bytes), single-point Data Inspector, and SHA-256 / MD5 checksums.

## VS Code Integration

- **Activity Bar Sidebar (`[0x] Binsight`)**: Browse and open workspace `.bin` / `.raw` / `.dat` files, `*.binsight.json` schemas, and `*.binsight-layout.json` profiles.
- **Direct Binary Open**: Left-clicking any `.bin` / `.raw` / `.dat` file opens directly in Binsight (`CustomReadonlyEditorProvider`).
- **Schema Hot-Reload**: Clicking **`Edit JSON`** opens `*.binsight.json` in a side editor with offline IntelliSense; saving (`Ctrl+S`) automatically hot-reloads the Binsight view.

## Offline Packaging & Installation

```bash
./scripts/install-vsix.sh
```
