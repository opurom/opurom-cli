import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  buildServer, dbPathFor, DEFAULT_SERVICE_PORT, serviceEnv, serviceBinary, targetDir,
} from '../lib/service.mjs';
import { serveUrl } from '../lib/serve.mjs';
import { benchArtifactRows, formatMillis, markdownTable } from '../lib/bench.mjs';
import { CLI_ROOT, tmpDir } from '../lib/paths.mjs';

test('serviceEnv sets only OPR_PORT and OPR_DB', () => {
  const env = serviceEnv({ port: 9000, db: '/tmp/x.db', base: { PATH: '/bin' } });
  assert.equal(env.OPR_PORT, '9000');
  assert.equal(env.OPR_DB, '/tmp/x.db');
  assert.equal(env.PATH, '/bin');
  assert.equal('OPR_MIGRATIONS' in env, false);
  assert.equal('OPR_PORT' in serviceEnv({ port: null, db: null, base: {} }), false);
});

test('port and db paths are derived from the output directory', () => {
  assert.equal(DEFAULT_SERVICE_PORT, 8787);
  assert.equal(serveUrl(8787), 'http://127.0.0.1:8787');
  assert.equal(dbPathFor('/tmp/out'), path.join('/tmp/out', 'data', 'opurom.db'));
  assert.equal(targetDir('/tmp/out'), path.join('/tmp/out', 'target'));
});

test('serviceBinary finds the built executable and reports null when absent', () => {
  const dir = tmpDir('service-test-');
  try {
    assert.equal(serviceBinary(dir), null);
    fs.mkdirSync(path.join(dir, 'server'));
    fs.writeFileSync(path.join(dir, 'server', 'Cargo.toml'), '[package]\nname = "opurom-service"\n');
    const release = path.join(dir, 'target', 'release');
    fs.mkdirSync(release, { recursive: true });
    const bin = path.join(release, 'opurom-service');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    assert.equal(serviceBinary(dir), bin);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bench helpers format measured values only', () => {
  assert.equal(formatMillis(12.4), '12 ms');
  assert.equal(formatMillis(1500), '1.50 s');
  assert.equal(formatMillis(Number.NaN), 'n/a');
  const table = markdownTable([{ step: 'compile', elapsed: '12 ms' }], ['step', 'elapsed']);
  assert.match(table, /\| step \| elapsed \|/);
  assert.match(table, /\| compile \| 12 ms \|/);
  const rows = benchArtifactRows([{ name: 'web', files: 3, bytes: 2048 }]);
  assert.deepEqual(rows, [{ artifact: 'web', files: '3', bytes: '2.0 KiB' }]);
});

test('buildServer tries cached crates offline before a registry fallback', () => {
  const dir = tmpDir('service-offline-');
  const oldOffline = process.env.CARGO_NET_OFFLINE;
  delete process.env.CARGO_NET_OFFLINE;
  try {
    fs.mkdirSync(path.join(dir, 'server'));
    fs.writeFileSync(path.join(dir, 'server', 'Cargo.toml'), '[package]\nname = "opurom-service"\n');
    const cargo = path.join(dir, 'cargo');
    const logFile = path.join(dir, 'cargo.log');
    fs.writeFileSync(cargo, `#!/bin/sh
printf '%s\\n' "\${CARGO_NET_OFFLINE:-0}" >> '${logFile}'
if [ "\${CARGO_NET_OFFLINE:-0}" = "true" ]; then
  echo 'no matching package named serde_json found' >&2
  exit 101
fi
mkdir -p "\${CARGO_TARGET_DIR}/release"
printf '#!/bin/sh\\nexit 0\\n' > "\${CARGO_TARGET_DIR}/release/opurom-service"
chmod +x "\${CARGO_TARGET_DIR}/release/opurom-service"
exit 0
`, { mode: 0o755 });
    const bin = buildServer({ out: dir, cargo, log: () => {}, offline: true });
    assert.equal(bin, path.join(dir, 'target', 'release', 'opurom-service'));
    assert.deepEqual(fs.readFileSync(logFile, 'utf8').trim().split('\n'), ['true', '0']);
  } finally {
    if (oldOffline === undefined) delete process.env.CARGO_NET_OFFLINE;
    else process.env.CARGO_NET_OFFLINE = oldOffline;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
