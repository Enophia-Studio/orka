// The system dialogs' helpers on their own (src/native.ts, bundled here): telling a cancelled
// dialog from one that could not be shown, and where the macOS save dialog starts.
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

describe('Orka desktop system dialogs', () => {
  let dir;
  let native;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orka-native-test-'));
    const outfile = path.join(dir, 'native.cjs');
    await esbuild.build({ entryPoints: [path.join(here, '..', 'src', 'native.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'warning' });
    native = require(outfile);
  });
  after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it('tells a cancelled dialog from one that could not be shown', () => {
    const { dialogAnswer } = native;
    const ok = (stdout) => ({ failed: false, code: undefined, stdout, stderr: '' });
    const failed = (code, stderr = '') => ({ failed: true, code, stdout: '', stderr });
    for (const platform of ['win32', 'darwin', 'linux']) {
      assert.equal(dialogAnswer(platform, undefined), null, `${platform}: not installed`);
      assert.equal(dialogAnswer(platform, ok(' /a/b.md\n')), '/a/b.md');
      assert.equal(dialogAnswer(platform, ok('\n')), undefined, `${platform}: no answer is a cancel`);
    }
    assert.equal(dialogAnswer('darwin', failed(1, 'execution error: User canceled. (-128)')), undefined);
    assert.equal(dialogAnswer('darwin', failed(1, 'execution error: Can’t get POSIX file. (-1728)')), null);
    assert.equal(dialogAnswer('linux', failed(1)), undefined, 'zenity: cancelled');
    assert.equal(dialogAnswer('linux', failed(255)), null, 'zenity: failed');
    assert.equal(dialogAnswer('win32', failed(1, 'Add-Type: ...')), null, 'PowerShell exits with 0 on a cancel');
  });

  it('starts the macOS save dialog in the folder of the suggested file, with its name', () => {
    const suggested = path.join(dir, 'radar', 'notes', 'radar-report-2026-11-06.md');
    const args = native.macSaveDialogArgs('Save', suggested);
    assert.match(args[3], /default name \(item 2 of argv\) default location \(POSIX file \(item 3 of argv\)\)/);
    assert.deepEqual(args.slice(-3), ['Save', 'radar-report-2026-11-06.md', path.dirname(suggested)]);
  });
});
