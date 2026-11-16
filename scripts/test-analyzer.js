/**
 * Binsight v2.0 All-Modes Sample Generator & Automated Test Suite
 * Modes tested:
 *  1. Register Map (Multi-Segment + Diff + Bitfields)
 *  2. Struct List (Fixed Firmware Header Struct)
 *  3. Repeat Struct List (72B Entries in 8KB Blocks with 56B Padding & Polymorphic Types)
 *  4. Protocol Diagram (UFS UPIU Packet Stream + 32-bit/row Spec Diagram)
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 /usr/share/code/code scripts/test-analyzer.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {
  analyzeFile,
  queryRepeatEntries,
  scanProtocolPackets
} = require('../src/analyzer');
const { getBuiltinSchemas } = require('../src/registerParser');

const ROOT = path.resolve(__dirname, '..');
const SAMPLE_DIR = path.join(ROOT, 'samples');

function generateAllSamples() {
  if (fs.existsSync(SAMPLE_DIR)) {
    for (const f of fs.readdirSync(SAMPLE_DIR)) {
      const p = path.join(SAMPLE_DIR, f);
      if (fs.statSync(p).isFile()) fs.unlinkSync(p);
    }
  } else {
    fs.mkdirSync(SAMPLE_DIR, { recursive: true });
  }

  const builtins = getBuiltinSchemas();
  const findBuiltin = (id) => builtins.find((s) => s.id === id);

  // Write canonical *.binsight.json schemas for all modes
  fs.writeFileSync(path.join(SAMPLE_DIR, 'sys_ctrl.binsight.json'), findBuiltin('builtin-sys-ctrl').sourceText, 'utf8');
  fs.writeFileSync(path.join(SAMPLE_DIR, 'pcie_phy.binsight.json'), findBuiltin('builtin-pcie-phy').sourceText, 'utf8');
  fs.writeFileSync(path.join(SAMPLE_DIR, 'dma_engine.binsight.json'), findBuiltin('builtin-dma-engine').sourceText, 'utf8');
  fs.writeFileSync(path.join(SAMPLE_DIR, 'fw_header.binsight.json'), findBuiltin('builtin-struct-fw-header').sourceText, 'utf8');
  fs.writeFileSync(path.join(SAMPLE_DIR, 'repeat_trace_72b_8k.binsight.json'), findBuiltin('builtin-repeat-72b-8k').sourceText, 'utf8');
  fs.writeFileSync(path.join(SAMPLE_DIR, 'ufs_upiu.binsight.json'), findBuiltin('builtin-protocol-ufs-upiu').sourceText, 'utf8');

  // ============================================================================
  // MODE 4 (Existing): Register Map Multi-IP SoC Crash vs Golden
  // ============================================================================
  const goldenBuf = Buffer.alloc(4096, 0);
  const crashBuf = Buffer.alloc(4096, 0);
  goldenBuf.writeUInt32LE(0x00180533, 0x0000);
  goldenBuf.writeUInt32LE(0x0410fc43, 0x0004);
  crashBuf.writeUInt32LE(0x80180537, 0x0000);
  crashBuf.writeUInt32LE(0x084cfcfb, 0x0004);

  goldenBuf.writeUInt32LE(0xfa288009, 0x0100);
  crashBuf.writeUInt32LE(0xfa288009, 0x0100);
  goldenBuf.writeUInt32LE(0xfa288009, 0x0140);
  crashBuf.writeUInt32LE(0xec104019, 0x0140);
  crashBuf.writeUInt32LE(0x0005001f, 0x0144);

  function populateDmaBlock(buf, baseOff, ch2Fault = false) {
    buf.writeUInt32LE(0x00000043, baseOff + 0x00);
    buf.writeUInt32LE(0x00000003, baseOff + 0x04);
    buf.writeUInt32LE(ch2Fault ? 0x00040000 : 0x00000000, baseOff + 0x08);
    for (let ch = 0; ch < 4; ch++) {
      const cOff = baseOff + 0x10 + ch * 16;
      const isFaultCh = ch2Fault && ch === 2;
      const xferBytes = (ch + 1) * 512;
      buf.writeUInt32LE((xferBytes << 16) | ((ch + 2) << 3) | (1 << 1) | 1, cOff + 0x00);
      buf.writeUInt32LE(0x20000000 + ch * 0x10000, cOff + 0x04);
      buf.writeUInt32LE(0x80000000 + ch * 0x10000, cOff + 0x08);
      buf.writeUInt32LE(isFaultCh ? (256 << 16) | 0x07 : 0x03, cOff + 0x0c);
    }
  }
  populateDmaBlock(goldenBuf, 0x0200, false);
  populateDmaBlock(crashBuf, 0x0200, true);
  fs.writeFileSync(path.join(SAMPLE_DIR, 'scenario1_soc_golden.bin'), goldenBuf);
  fs.writeFileSync(path.join(SAMPLE_DIR, 'scenario1_soc_crash.bin'), crashBuf);

  const scenario1Layout = {
    $schema: '../schemas/binsight-layout.schema.json',
    name: 'Scenario 1: SoC Multi-IP Crash Dump Layout (4 Segments)',
    segments: [
      { label: 'SYS_CTRL_MAIN', startOffset: '0x0000', hwBaseAddress: '0x40000000', schema: './sys_ctrl.binsight.json', endianness: 'little' },
      { label: 'PCIE_PHY_LANE0', startOffset: '0x0100', hwBaseAddress: '0x40010000', schema: './pcie_phy.binsight.json', endianness: 'little' },
      { label: 'PCIE_PHY_LANE1', startOffset: '0x0140', hwBaseAddress: '0x40011000', schema: './pcie_phy.binsight.json', endianness: 'little' },
      { label: 'DMA_ENGINE_0', startOffset: '0x0200', hwBaseAddress: '0x40020000', schema: './dma_engine.binsight.json', endianness: 'little' }
    ]
  };
  fs.writeFileSync(path.join(SAMPLE_DIR, 'scenario1_soc.binsight-layout.json'), JSON.stringify(scenario1Layout, null, 2), 'utf8');

  // ============================================================================
  // MODE 1: Struct List (samples/fw_header_struct.bin)
  // ============================================================================
  const fwBuf = Buffer.alloc(64, 0);
  fwBuf.write('FWIM', 0x00, 'ascii');
  fwBuf.writeUInt16LE(0x0201, 0x04);
  fwBuf.writeUInt16LE(0x0003, 0x06);
  fwBuf.writeUInt32LE(0x20000000, 0x08);
  fwBuf.writeUInt32LE(0x20000400, 0x0c);
  fwBuf.writeUInt32LE(131072, 0x10);
  fwBuf.writeUInt32LE(1763310000, 0x14);
  fwBuf.writeUInt32LE(0xdeadbeef, 0x18);
  fwBuf.write('RC1_PROD', 0x1c, 'ascii');
  fs.writeFileSync(path.join(SAMPLE_DIR, 'fw_header_struct.bin'), fwBuf);

  // ============================================================================
  // MODE 2: Repeat Struct List — 72B Entries inside 8KB Blocks (56B Padding/blk)
  // ============================================================================
  const blockSize = 8192;
  const entrySize = 72;
  const entriesPerBlock = Math.floor(blockSize / entrySize); // 113
  const numBlocks = 3; // 24 KB sample (339 slots total, 56B 0xAA padding at end of each 8KB block)
  const repBuf = Buffer.alloc(numBlocks * blockSize, 0xaa);

  let seq = 1000;
  for (let b = 0; b < numBlocks; b++) {
    const blkBase = b * blockSize;
    for (let s = 0; s < entriesPerBlock; s++) {
      const eOff = blkBase + s * entrySize;
      // Put 0xFF empty slots in the last 10 slots of each block
      if (s >= entriesPerBlock - 10) {
        repBuf.fill(0xff, eOff, eOff + entrySize);
        continue;
      }
      if (s % 2 === 0) {
        // 0x01 CMD_SUBMIT
        repBuf[eOff + 0] = 0x01;
        repBuf[eOff + 1] = 0x00;
        repBuf.writeUInt16LE(s, eOff + 2);
        repBuf.writeUInt32LE(seq++, eOff + 4);
        repBuf.writeBigUInt64LE(BigInt(1000000 + b * 50000 + s * 120), eOff + 8);
        repBuf[eOff + 16] = s % 4 === 0 ? 0x28 : 0x2a; // READ_10 or WRITE_10
        repBuf[eOff + 17] = 0; // LUN 0
        repBuf.writeUInt16LE(8 * ((s % 4) + 1), eOff + 18); // XFER_LEN
        repBuf.writeBigUInt64LE(BigInt(0x10000 + s * 64), eOff + 20);
        repBuf.writeBigUInt64LE(BigInt(0x80000000 + s * 4096), eOff + 28);
        repBuf.write(`BLK${b}_SLOT${s}_CMD\0`, eOff + 36, 'ascii');
      } else {
        // 0x02 IO_COMPLETE
        repBuf[eOff + 0] = 0x02;
        repBuf[eOff + 1] = s === 21 && b === 1 ? 0x02 : 0x00; // CHECK_COND fault in Block 1 Slot 21
        repBuf.writeUInt16LE(s - 1, eOff + 2);
        repBuf.writeUInt32LE(seq++, eOff + 4);
        repBuf.writeBigUInt64LE(BigInt(1000050 + b * 50000 + s * 120), eOff + 8);
        repBuf.writeUInt32LE(45 + (s % 15), eOff + 16); // LATENCY_US
        repBuf.writeInt32LE(0, eOff + 20);
        repBuf.writeUInt32LE(s === 21 && b === 1 ? 0x02031100 : 0, eOff + 24);
        repBuf.write(`BLK${b}_SLOT${s}_DONE\0`, eOff + 28, 'ascii');
      }
    }
  }
  fs.writeFileSync(path.join(SAMPLE_DIR, 'repeat_trace_72b_8k.bin'), repBuf);

  // ============================================================================
  // MODE 3: Protocol Diagram — UFS UPIU Packet Stream (samples/ufs_upiu_trace.bin)
  // ============================================================================
  const pktChunks = [];

  // Packet 0: COMMAND UPIU (0x01, 32B) - READ(10) LBA 0x00001000, 8 blocks (4096 B)
  const p0 = Buffer.alloc(32, 0);
  p0[0] = 0x01; // Transaction Type = COMMAND
  p0[1] = 0x40; // Flags: R=1 (Read)
  p0[2] = 0x00; // LUN 0
  p0[3] = 0x1a; // Task Tag 0x1A
  p0[4] = 0x00; // IID=0, CmdSet=SCSI
  p0.writeUInt32BE(4096, 12); // Expected Data Transfer Length
  p0[16] = 0x28; // CDB[0]: READ_10
  p0.writeUInt32BE(0x00001000, 18); // LBA
  p0.writeUInt16BE(8, 23); // Transfer Length = 8 blocks
  pktChunks.push(p0);

  // Packet 1: DATA IN UPIU (0x22, 32B header + 16B payload = 48B)
  const p1 = Buffer.alloc(48, 0);
  p1[0] = 0x22; // Transaction Type = DATA IN
  p1[2] = 0x00; // LUN 0
  p1[3] = 0x1a; // Task Tag 0x1A
  p1.writeUInt16BE(16, 10); // Data Segment Length = 16 bytes
  p1.writeUInt32BE(0x00000000, 12); // Data Buffer Offset
  p1.writeUInt32BE(16, 16); // Data Transfer Count
  Buffer.from('UFS_DATA_PAYLOAD').copy(p1, 32);
  pktChunks.push(p1);

  // Packet 2: RESPONSE UPIU (0x21, 32B) - TARGET_SUCCESS / GOOD
  const p2 = Buffer.alloc(32, 0);
  p2[0] = 0x21; // Transaction Type = RESPONSE
  p2[2] = 0x00; // LUN 0
  p2[3] = 0x1a; // Task Tag 0x1A
  p2[6] = 0x00; // Response = TARGET_SUCCESS
  p2[7] = 0x00; // Status = GOOD
  pktChunks.push(p2);

  // Packet 3: QUERY REQUEST UPIU (0x16, 32B) - READ_DESC Device Descriptor (IDN=0x00)
  const p3 = Buffer.alloc(32, 0);
  p3[0] = 0x16; // Transaction Type = QUERY REQUEST
  p3[3] = 0x1b; // Task Tag 0x1B
  p3[6] = 0x01; // Query Function = STD_READ
  p3[12] = 0x01; // Opcode = READ_DESC
  p3[13] = 0x00; // IDN = 0x00 (Device Descriptor)
  p3.writeUInt16BE(0x0059, 18); // Length = 89 bytes
  pktChunks.push(p3);

  fs.writeFileSync(path.join(SAMPLE_DIR, 'ufs_upiu_trace.bin'), Buffer.concat(pktChunks));
}

async function runTests() {
  console.log('1. Generating All 4 Mode Sample Files in samples/...');
  generateAllSamples();

  console.log('\n2. Testing Mode 1: Struct List (fw_header_struct.bin)...');
  const rStruct = await analyzeFile(path.join(SAMPLE_DIR, 'fw_header_struct.bin'), [ROOT]);
  assert.strictEqual(rStruct.initialMode, 'struct-list');
  console.log('   ✔ Auto-detected struct-list mode:', rStruct.initialSchemaId);

  console.log('\n3. Testing Mode 2: Repeat Struct List with 8KB Padding (repeat_trace_72b_8k.bin)...');
  const rRepeat = await analyzeFile(path.join(SAMPLE_DIR, 'repeat_trace_72b_8k.bin'), [ROOT]);
  assert.strictEqual(rRepeat.initialMode, 'repeat-struct');
  assert.strictEqual(rRepeat.initialRepeatResult.entriesPerBlock, 113);
  assert.strictEqual(rRepeat.initialRepeatResult.paddingPerBlock, 56);
  assert.strictEqual(rRepeat.initialRepeatResult.totalSlots, 339);
  // Check Block 1 Slot 0 starts exactly at 8192 (0x2000), skipping the 56B padding of Block 0!
  const repeatSchema = rRepeat.schemas.find((s) => s.id === rRepeat.initialSchemaId);
  const page2 = queryRepeatEntries(path.join(SAMPLE_DIR, 'repeat_trace_72b_8k.bin'), repeatSchema, {
    page: 0,
    pageSize: 100,
    blockIndex: 1,
    hideSkipped: true
  });
  assert.strictEqual(page2.entries[0].fileOffset, 8192, 'Block 1 entry 0 must start at exact 8KB boundary 0x2000');
  assert.strictEqual(page2.matchedCount, 103, 'Block 1 should have 103 non-empty entries (113 - 10 skipped 0xFF)');
  console.log('   ✔ Verified 8KB block alignment (Block 1 @ 0x2000), 56B padding skipped, and 0xFF filtering');

  console.log('\n4. Testing Mode 3: Protocol Diagram (ufs_upiu_trace.bin)...');
  const rProto = await analyzeFile(path.join(SAMPLE_DIR, 'ufs_upiu_trace.bin'), [ROOT]);
  assert.strictEqual(rProto.initialMode, 'protocol');
  assert.strictEqual(rProto.initialProtocolResult.totalPackets, 4);
  assert.strictEqual(rProto.initialProtocolResult.packets[0].typeHex, '0x01');
  assert.strictEqual(rProto.initialProtocolResult.packets[1].typeHex, '0x22');
  assert.strictEqual(rProto.initialProtocolResult.packets[1].totalLength, 48);
  assert.strictEqual(rProto.initialProtocolResult.packets[2].typeHex, '0x21');
  assert.strictEqual(rProto.initialProtocolResult.packets[3].typeHex, '0x16');
  console.log('   ✔ Verified UFS UPIU 4-packet stream framing (32B CMD, 48B DATA_IN, 32B RESP, 32B QUERY)');

  console.log('\n5. Testing Mode 4: Register Map (scenario1_soc_crash.bin)...');
  const rReg = await analyzeFile(path.join(SAMPLE_DIR, 'scenario1_soc_crash.bin'), [ROOT]);
  assert.strictEqual(rReg.initialMode, 'register-map');
  assert.strictEqual(rReg.initialSegments.length, 4);
  console.log('   ✔ Verified 4-segment SoC Register Map hydration');

  console.log('\n✅ All 4 Binsight v2.0 modes passed!');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
