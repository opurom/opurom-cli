// Node tests for the OPUROM CLI quality profile contract.
// Product quality is the default; degraded rendering needs explicit flags.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  QUALITY_PROFILES, QUALITY_DEFINES, describeQuality, qualityEnv, resolveQualityOptions,
} from '../lib/quality.mjs';

test('quality profiles list product first and compat as the only degraded mode', () => {
  assert.deepEqual([...QUALITY_PROFILES], ['product', 'compat']);
});

test('default flags resolve to the highest product quality', () => {
  const quality = resolveQualityOptions({});
  assert.equal(quality.profile, 'product');
  assert.equal(quality.edgeAa, true);
  assert.equal(quality.fontMetrics, 'proportional');
  assert.equal(quality.degraded, false);
  assert.equal(quality.legacyGolden, false);
  assert.equal(quality.noMotion, false);
  assert.equal(quality.lowPower, false);
  assert.equal(describeQuality(quality),
    'quality=product tier=product edge-aa=true font-metrics=proportional motion=on power=full');
  assert.deepEqual(quality.defines, [
    'Quality=product', 'LegacyGolden=false', 'Motion=false', 'LowPower=false',
    'EdgeAA=true', 'FontMetrics=proportional',
  ]);
  assert.equal(qualityEnv(quality).OPR_QUALITY_PROFILE, 'product');
  assert.equal(qualityEnv(quality).OPR_DEFINE_Quality, 'product');
});

test('explicit compat keeps legacy golden font metrics and disables edge AA', () => {
  const quality = resolveQualityOptions({ quality: 'compat' });
  assert.equal(quality.profile, 'compat');
  assert.equal(quality.edgeAa, false);
  assert.equal(quality.fontMetrics, 'fixed');
  assert.equal(quality.degraded, true);
});

test('explicit degraded options do not change the profile name silently', () => {
  const quality = resolveQualityOptions({
    'no-motion': true, 'low-power': true, 'font-metrics': 'fixed', 'edge-aa': false,
  });
  assert.equal(quality.profile, 'product');
  assert.equal(quality.noMotion, true);
  assert.equal(quality.lowPower, true);
  assert.equal(quality.degraded, true);
  assert.equal(describeQuality(quality),
    'quality=product tier=degraded edge-aa=true font-metrics=fixed motion=off power=low');
});

test('conflicting quality requests fail closed', () => {
  assert.throws(() => resolveQualityOptions({ quality: 'low' }), /invalid --quality/);
  assert.throws(() => resolveQualityOptions({ 'font-metrics': 'bitmap' }), /invalid --font-metrics/);
  assert.throws(() => resolveQualityOptions({ 'legacy-golden': true }), /requires --quality compat/);
  assert.throws(() => resolveQualityOptions({ quality: 'compat', 'edge-aa': true }), /--edge-aa is incompatible/);
});
