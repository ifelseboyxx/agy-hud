import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { HARD_MAX_MCP_RESPONSE_BYTES } from '../hud-mcp-cap.ts';
import { handleMcpMessage, runMcpStdioServer } from '../hud-mcp-entry.ts';

void describe('hud-mcp-entry stdio framing and argument bounds hardening', () => {
  let tmpRoot = '';
  let geminiRoot = '';
  let cliHome = '';
  let wsDir = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-mcp-harden-'));
    geminiRoot = path.join(tmpRoot, '.gemini');
    cliHome = path.join(geminiRoot, 'antigravity-cli');
    wsDir = path.join(tmpRoot, 'ws');
    mkdirSync(cliHome, { recursive: true });
    mkdirSync(wsDir, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) rmSync(tmpRoot, { recursive: true, force: true });
  });

  void it('catches output.write errors when emitting oversized frame replies on stdio', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.write = ((): boolean => {
      throw new Error('simulated EPIPE');
    }) as typeof output.write;

    const done = runMcpStdioServer(input, output, { cliHome, geminiRoot, cwd: wsDir });
    assert.doesNotThrow(() => {
      input.write('x'.repeat(HARD_MAX_MCP_RESPONSE_BYTES + 128));
      input.write('\n');
      input.end();
    });
    await done;
  });

  void it('treats a sub-1-MiB raw frame with invalid UTF-8 bytes as -32700 parse error instead of oversized -32600', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (buf: Buffer) => {
      chunks.push(buf.toString('utf8'));
    });

    const done = runMcpStdioServer(input, output, { cliHome, geminiRoot, cwd: wsDir });
    const rawFrame = Buffer.alloc(HARD_MAX_MCP_RESPONSE_BYTES - 16, 0xff);
    rawFrame[0] = 0x7b; // '{'
    input.write(rawFrame);
    input.write('\n');
    input.end();
    await done;

    const reply = JSON.parse(chunks.join('').trim()) as { error?: { code?: number } };
    assert.equal(reply.error?.code, -32700);
  });

  void it('rejects etag arguments exceeding 64 UTF-8 bytes on hud_poll_snapshot', () => {
    const ctx = { cliHome, geminiRoot, cwd: wsDir };
    const res = handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 41,
        method: 'tools/call',
        params: { name: 'hud_poll_snapshot', arguments: { etag: 'a'.repeat(65) } },
      },
      ctx,
    );
    assert.ok(res !== null && 'result' in res);
    const result = res.result as { isError?: boolean; structuredContent: { error: string } };
    assert.equal(result.isError, true);
    assert.ok(result.structuredContent.error.includes('64'));
  });
});
