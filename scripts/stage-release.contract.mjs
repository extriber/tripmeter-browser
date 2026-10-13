import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('staging targets npm even when the user routes the scope to another registry', () => {
  assert.ok(process.env.npm_execpath, 'Run this contract through npm test');
  const directory = mkdtempSync(join(tmpdir(), 'tripmeter-registry-'));
  try {
    const filename = 'extriber-tripmeter-browser-1.0.0-rc.1.tgz';
    writeFileSync(join(directory, 'pack-result.json'), JSON.stringify([{ filename }]));
    const userconfig = join(directory, 'npmrc');
    writeFileSync(userconfig, '@extriber:registry=https://npm.pkg.github.com/\n');
    // Resolve the effective destination with the real npm CLI, without publishing.
    writeFileSync(join(directory, 'npm'), `#!${process.execPath}
const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2);
if(args[0]!=='stage'||args[1]!=='publish')process.exit(2);
const flags=args.filter(a=>a.startsWith('--registry=')||a.startsWith('--@extriber:registry='));
const result=spawnSync(process.execPath,[process.env.REAL_NPM_CLI,'config','get','@extriber:registry',...flags],{encoding:'utf8',env:process.env});
if(result.status!==0)process.exit(result.status||1);
process.stdout.write(JSON.stringify({registry:result.stdout.trim(),filename:args[2]}));
`, { mode: 0o700 });
    const result = spawnSync(process.execPath, [resolve('scripts/stage-release.mjs')], {
      cwd: directory, encoding: 'utf8',
      env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}`, REAL_NPM_CLI: process.env.npm_execpath, NPM_CONFIG_USERCONFIG: userconfig, npm_config_userconfig: userconfig },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { registry: 'https://registry.npmjs.org/', filename });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
