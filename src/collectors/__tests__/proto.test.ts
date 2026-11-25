import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { MAX_PROTO_BLOB_BYTES, parseGenMetadataBlob, parseKvStepIdx } from '../proto.ts';
import { loadSessionTelemetry } from '../telemetry.ts';

function encodeVarint(value: bigint): number[] {
  const out: number[] = [];
  let v = value;
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}

function encodeFieldBytes(fieldNum: number, payload: number[]): number[] {
  return [...encodeVarint(BigInt((fieldNum << 3) | 2)), ...encodeVarint(BigInt(payload.length)), ...payload];
}

function encodeFieldVarint(fieldNum: number, value: bigint): number[] {
  return [...encodeVarint(BigInt((fieldNum << 3) | 0)), ...encodeVarint(value)];
}

void describe('protobuf wire decoding bounds', () => {
  void it('rejects overlong varints in constant time without unbounded BigInt growth', () => {
    const huge = new Uint8Array(200_000).fill(0x80);
    const start = performance.now();
    assert.equal(parseGenMetadataBlob(huge), null);
    assert.equal(parseKvStepIdx(huge), null);
    assert.ok(performance.now() - start < 100, 'overlong varint rejection must stay bounded');
  });

  void it('rejects truncated varints at EOF inside gen_metadata usage fields', () => {
    // Field 2 (input tokens) with unterminated continuation byte 0x80 at EOF.
    const truncatedUsage = new Uint8Array([0x10, 0x80]);
    const chatModel = encodeFieldBytes(4, [...truncatedUsage]);
    const outer = new Uint8Array(encodeFieldBytes(1, chatModel));
    const decoded = parseGenMetadataBlob(outer);
    assert.ok(decoded !== null);
    assert.equal(decoded.in, 0);
  });

  void it('skips valid 10-byte 64-bit unknown varint fields and decodes subsequent telemetry', () => {
    // Unknown field 99 with two's-complement -1 (10-byte uint64 max), followed by usage input tokens = 42.
    const negOne64 = (1n << 64n) - 1n;
    const usage = [...encodeFieldVarint(99, negOne64), ...encodeFieldVarint(2, 42n)];
    const chatModel = encodeFieldBytes(4, usage);
    const outer = new Uint8Array(encodeFieldBytes(1, chatModel));
    const decoded = parseGenMetadataBlob(outer);
    assert.ok(decoded !== null);
    assert.equal(decoded.in, 42);
  });

  void it('rejects protobuf tags exceeding 32 bits instead of aliasing low field numbers', () => {
    const aliasedTag = (1n << 32n) | BigInt((1 << 3) | 2);
    const chatModel = encodeFieldBytes(4, encodeFieldVarint(2, 99n));
    const outer = new Uint8Array([
      ...encodeVarint(aliasedTag),
      ...encodeVarint(BigInt(chatModel.length)),
      ...chatModel,
    ]);
    assert.equal(parseGenMetadataBlob(outer), null);
  });

  void it('rejects protobuf blobs exceeding the maximum byte cap', () => {
    const valid = encodeFieldBytes(1, encodeFieldBytes(4, encodeFieldVarint(2, 42n)));
    const oversized = new Uint8Array(1024 * 1024 + 1);
    oversized.set(valid, 0);
    assert.equal(parseGenMetadataBlob(oversized), null);

    const kvKey = [...Buffer.from('last_step_index', 'utf8')];
    const kvVal = [...Buffer.from('7', 'utf8')];
    const validKv = [...encodeFieldBytes(1, kvKey), ...encodeFieldBytes(2, kvVal)];
    const oversizedKv = new Uint8Array(1024 * 1024 + 1);
    oversizedKv.set(validKv, 0);
    assert.equal(parseKvStepIdx(oversizedKv), null);
  });

  void it('skips oversized gen_metadata blobs at SQL projection level while decoding valid rows', () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-proto-sql-'));
    try {
      const cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
      const convDir = path.join(cliHome, 'conversations');
      mkdirSync(convDir, { recursive: true });
      const convId = 'proto-sql-oversized';
      const db = new DatabaseSync(path.join(convDir, `${convId}.db`));
      try {
        db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
        const validBlob = new Uint8Array(encodeFieldBytes(1, encodeFieldBytes(4, encodeFieldVarint(2, 123n))));
        const oversizedBlob = new Uint8Array(MAX_PROTO_BLOB_BYTES + 16);
        oversizedBlob.set(validBlob, 0);
        const stmt = db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)');
        stmt.run(1, oversizedBlob);
        stmt.run(2, validBlob);
      } finally {
        db.close();
      }

      const telemetry = loadSessionTelemetry(cliHome, { conversation_id: convId });
      assert.equal(telemetry.genCount, 1);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  void it('removes stale cached row when an existing gen_metadata blob becomes oversized', () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-proto-null-'));
    try {
      const cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
      const convDir = path.join(cliHome, 'conversations');
      mkdirSync(convDir, { recursive: true });
      const convId = 'proto-sql-stale-null';
      const dbPath = path.join(convDir, `${convId}.db`);
      const validBlob1 = new Uint8Array(encodeFieldBytes(1, encodeFieldBytes(4, encodeFieldVarint(2, 100n))));
      const validBlob2 = new Uint8Array(encodeFieldBytes(1, encodeFieldBytes(4, encodeFieldVarint(2, 200n))));
      const db = new DatabaseSync(dbPath);
      try {
        db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
        const stmt = db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)');
        stmt.run(1, validBlob1);
        stmt.run(2, validBlob2);
      } finally {
        db.close();
      }

      assert.equal(loadSessionTelemetry(cliHome, { conversation_id: convId }).genCount, 2);

      const dbUpdate = new DatabaseSync(dbPath);
      try {
        const oversizedBlob = new Uint8Array(MAX_PROTO_BLOB_BYTES + 16);
        dbUpdate.prepare('UPDATE gen_metadata SET data = ? WHERE idx = ?').run(oversizedBlob, 2);
      } finally {
        dbUpdate.close();
      }

      assert.equal(loadSessionTelemetry(cliHome, { conversation_id: convId }).genCount, 1);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
