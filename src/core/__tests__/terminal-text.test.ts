import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sanitizeTerminalText } from '../terminal-text.ts';

void describe('sanitizeTerminalText', () => {
  void it('strips terminated CSI sequences while preserving plain text', () => {
    assert.equal(sanitizeTerminalText('safe\x1b[31mred\x1b[0mend'), 'saferedend');
  });

  void it('strips terminated OSC sequences with BEL or ST terminators', () => {
    assert.equal(
      sanitizeTerminalText('a\x1b]52;c;SGVsbG8=\x07b\x1b]8;;https://evil.test\x1b\\link\x1b]8;;\x1b\\c'),
      'ablinkc',
    );
  });

  void it('strips terminated DCS sequences', () => {
    assert.equal(sanitizeTerminalText('before\x1bPq#0\x1b\\after'), 'beforeafter');
  });

  void it('strips unterminated OSC payloads through end of string', () => {
    assert.equal(sanitizeTerminalText('x\x1b]52;c;SGVsbG8= no terminator'), 'x');
  });

  void it('strips unterminated DCS payloads through end of string', () => {
    assert.equal(sanitizeTerminalText('a\x1bPdcs payload'), 'a');
  });

  void it('strips unterminated SOS payloads through end of string', () => {
    assert.equal(sanitizeTerminalText('b\x1bXsos payload'), 'b');
  });

  void it('strips unterminated PM payloads through end of string', () => {
    assert.equal(sanitizeTerminalText('c\x1b^pm payload'), 'c');
  });

  void it('strips unterminated APC payloads through end of string', () => {
    assert.equal(sanitizeTerminalText('d\x1b_apc payload'), 'd');
  });

  void it('strips unterminated CSI parameters without leaving trailing digits', () => {
    assert.equal(sanitizeTerminalText('clean\x1b[1;2'), 'clean');
  });

  void it('strips 8-bit C1 CSI sequences', () => {
    assert.equal(sanitizeTerminalText('ok\x9b2J!'), 'ok!');
  });

  void it('strips terminated 8-bit C1 OSC sequences', () => {
    assert.equal(sanitizeTerminalText('ok\x9d52;c;abc\x9c!'), 'ok!');
  });

  void it('strips terminated 8-bit C1 DCS sequences', () => {
    assert.equal(sanitizeTerminalText('ok\x90dcs\x9c!'), 'ok!');
  });

  void it('strips unterminated 8-bit C1 OSC payloads through end of string', () => {
    assert.equal(sanitizeTerminalText('ok\x9d52;c;unterminated'), 'ok');
  });

  void it('strips Unicode bidi format controls', () => {
    assert.equal(sanitizeTerminalText('\u202Eevil\u202C\u2066iso\u2069\u200E\u200F\u061C'), 'eviliso');
  });

  void it('strips deprecated Unicode directional format controls U+206A through U+206F', () => {
    assert.equal(sanitizeTerminalText('\u206Aevil\u206B\u206C\u206D\u206E\u206F'), 'evil');
  });

  void it('folds ASCII whitespace controls and Unicode line or paragraph separators into single spaces', () => {
    assert.equal(sanitizeTerminalText('a\t\r\nb\u2028c\u2029\u2029d  e'), 'a b c d  e');
  });
});
