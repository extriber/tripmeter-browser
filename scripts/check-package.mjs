import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const directory = mkdtempSync(join(tmpdir(), 'tripmeter-package-'));
try {
  const result = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], { encoding: 'utf8' }));
  // npm 11 returns an array; npm 12 keys the result by package name.
  const packed = Array.isArray(result) ? result[0] : result['@extriber/tripmeter-browser'];
  assert.ok(packed, 'npm pack did not produce the requested artifact');
  const allowed = /^(dist\/[^/]+\.(js|cjs|ts)|package\.json|README\.md|THIRD_PARTY_NOTICES\.txt|LICENSE)$/;
  for (const file of packed.files) assert.match(file.path, allowed, `Unexpected published file: ${file.path}`);
  execFileSync('tar', ['-xzf', join(directory, packed.filename), '-C', directory]);
  const manifest = JSON.parse(readFileSync(join(directory, 'package/package.json'), 'utf8'));
  assert.equal(manifest.name, '@extriber/tripmeter-browser');
  assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
  for (const hook of ['preinstall', 'install', 'postinstall']) assert.equal(manifest.scripts?.[hook], undefined);
  const { createClient } = await import(`file://${join(directory, 'package/dist/index.js')}`);
  assert.equal(typeof createClient, 'function');
  const consumer = join(directory, 'consumer.mts');
  writeFileSync(consumer, readFileSync('package-types.mts', 'utf8').replace('./dist/index.js', './package/dist/index.js'));
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--noEmit', '--skipLibCheck', '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', consumer], { stdio: 'inherit', cwd: directory });
  console.log(JSON.stringify({ package: manifest.name, version: manifest.version, files: packed.files.length, integrity: packed.integrity }));
} finally { rmSync(directory, { recursive: true, force: true }); }
