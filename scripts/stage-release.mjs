import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const result = JSON.parse(readFileSync('pack-result.json', 'utf8'));
const artifact = Array.isArray(result) ? result[0] : result['@extriber/tripmeter-browser'];
assert.ok(artifact, 'Missing npm artifact');
assert.match(artifact.filename, /^extriber-tripmeter-browser-[0-9A-Za-z.-]+\.tgz$/);
execFileSync('npm', ['stage', 'publish', artifact.filename, '--access=public', '--tag=next'], { stdio: 'inherit' });
