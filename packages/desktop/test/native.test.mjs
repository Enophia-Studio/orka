// The system dialogs' helpers on their own (src/native.ts, bundled here): telling a cancelled
// dialog from one that could not be shown, and where the macOS save dialog starts.
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

  it("starts Orka's window as an app, without the browser's own features", () => {
    const args = native.appWindowArgs('http://127.0.0.1:5000/start?k=1', path.join(dir, 'window'));
    assert.equal(args[0], '--app=http://127.0.0.1:5000/start?k=1');
    assert.ok(args.includes(`--user-data-dir=${path.join(dir, 'window')}`));
    for (const flag of [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-breakpad',
      '--no-pings',
    ]) {
      assert.ok(args.includes(flag), flag);
    }
    const features = args.filter((a) => a.startsWith('--disable-features='));
    assert.equal(features.length, 1, 'the browser reads only the last --disable-features');
    assert.deepEqual(features[0].slice('--disable-features='.length).split(',').filter((f) => /Translate|Autofill/.test(f)), ['Translate', 'TranslateUI', 'AutofillServerCommunication']);
    assert.ok(!args.some((a) => /gpu|renderer|--headless|--remote-debugging/.test(a)), 'rendering keeps its defaults');
  });

  it("turns off translation, password saving and autofill in the window's profile, keeping what the browser stored", () => {
    const profile = path.join(dir, 'profile');
    native.prepareAppProfile(profile);
    const fresh = JSON.parse(readFileSync(path.join(profile, 'Default', 'Preferences'), 'utf8'));
    assert.equal(fresh.translate.enabled, false);
    assert.equal(fresh.credentials_enable_service, false);
    assert.equal(fresh.profile.password_manager_enabled, false);
    assert.equal(fresh.autofill.profile_enabled, false);
    assert.equal(fresh.autofill.credit_card_enabled, false);
    assert.equal(fresh.browser.check_default_browser, false);

    // The browser's own entries stay; ours win where it turned a feature back on.
    const stored = { browser: { window_placement: { left: 10, top: 20 } }, translate: { enabled: true }, profile: { name: 'Orka', password_manager_enabled: true }, extra: [1, 2] };
    writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify(stored));
    native.prepareAppProfile(profile);
    const merged = JSON.parse(readFileSync(path.join(profile, 'Default', 'Preferences'), 'utf8'));
    assert.deepEqual(merged.browser, { window_placement: { left: 10, top: 20 }, check_default_browser: false });
    assert.equal(merged.translate.enabled, false);
    assert.deepEqual(merged.profile, { name: 'Orka', password_manager_enabled: false });
    assert.deepEqual(merged.extra, [1, 2]);
    assert.deepEqual(readdirSync(path.join(profile, 'Default')), ['Preferences'], 'no temporary file left');

    // A broken file is replaced rather than stopping the start.
    writeFileSync(path.join(profile, 'Default', 'Preferences'), '{not json');
    native.prepareAppProfile(profile);
    assert.equal(JSON.parse(readFileSync(path.join(profile, 'Default', 'Preferences'), 'utf8')).translate.enabled, false);
  });
});
