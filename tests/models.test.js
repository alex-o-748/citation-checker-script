import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROVIDERS, PROVIDER_IDS, DEFAULT_PROVIDER,
  getProvider, modelFor, needsApiKey,
} from '../core/models.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every provider carries the fields consumers read', () => {
  for (const id of PROVIDER_IDS) {
    const p = PROVIDERS[id];
    assert.equal(typeof p.name, 'string', `${id} name`);
    assert.ok(p.name.length > 0, `${id} name non-empty`);
    assert.equal(typeof p.model, 'string', `${id} model`);
    assert.ok(p.model.length > 0, `${id} model non-empty`);
    assert.equal(typeof p.requiresKey, 'boolean', `${id} requiresKey`);
    assert.ok(p.storageKey === null || typeof p.storageKey === 'string', `${id} storageKey`);
    assert.match(p.color, /^#[0-9A-Fa-f]{6}$/, `${id} color`);
  }
});

test('a provider that requires a key also has somewhere to store it', () => {
  for (const id of PROVIDER_IDS) {
    const p = PROVIDERS[id];
    if (p.requiresKey || p.optionalKey) {
      assert.equal(typeof p.storageKey, 'string', `${id} takes a key but has no storageKey`);
    } else {
      assert.equal(p.storageKey, null, `${id} takes no key but declares a storageKey`);
    }
  }
});

test('storage keys are unique across providers', () => {
  const keys = PROVIDER_IDS.map(id => PROVIDERS[id].storageKey).filter(Boolean);
  assert.equal(new Set(keys).size, keys.length);
});

test('the default provider exists and needs no key', () => {
  const p = getProvider(DEFAULT_PROVIDER);
  assert.ok(p, `${DEFAULT_PROVIDER} is not a known provider`);
  assert.equal(p.requiresKey, false);
});

test('every provider id is dispatchable by core/providers.js', async () => {
  // callProviderAPI's switch is the other half of this table: a provider
  // listed here but missing from that switch is a runtime "Unknown provider".
  const src = fs.readFileSync(path.join(ROOT, 'core', 'providers.js'), 'utf8');
  for (const id of PROVIDER_IDS) {
    assert.match(src, new RegExp(`case '${id}':`), `core/providers.js cannot dispatch '${id}'`);
  }
});

test('getProvider and modelFor return null for an unknown id', () => {
  assert.equal(getProvider('nope'), null);
  assert.equal(modelFor('nope'), null);
});

test('needsApiKey is true only for a key-requiring provider with no key', () => {
  assert.equal(needsApiKey('claude', undefined), true);
  assert.equal(needsApiKey('claude', 'sk-ant-x'), false);
  // An *optional* key is not a missing one — the proxy covers it.
  assert.equal(needsApiKey('huggingface', undefined), false);
  assert.equal(needsApiKey('publicai', undefined), false);
  assert.equal(needsApiKey('nope', undefined), false);
});

test('main.js reads the table instead of redeclaring the models', () => {
  // The reason this module exists: main.js used to carry its own copy of
  // every model id, which is how the standalone web tool and this repo
  // drifted apart. If a model id reappears as a literal in main.js, the
  // copy is back.
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  // Strip the injected core/ block — models.js itself is spliced in there.
  const start = main.indexOf('// </core-injected>');
  assert.ok(start !== -1, 'core-injected end marker not found in main.js');
  const body = main.slice(start);
  for (const id of PROVIDER_IDS) {
    assert.ok(
      !body.includes(`'${PROVIDERS[id].model}'`),
      `main.js hardcodes ${id}'s model id — it should read core/models.js`
    );
  }
});
