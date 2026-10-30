import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/env';

const base = { AUTH_MODE: 'mock' };

test('AI_PROVIDER defaults to rule-based and needs no key', () => {
  const config = loadConfig(base);
  assert.equal(config.aiProvider, 'rule-based');
  assert.equal(config.aiApiKey, '');
  assert.equal(config.aiModel, '');
});

test('AI_PROVIDER=gemini reads the key and model', () => {
  const config = loadConfig({ ...base, AI_PROVIDER: 'gemini', AI_API_KEY: ' test-key ', AI_MODEL: 'test-model' });
  assert.equal(config.aiProvider, 'gemini');
  assert.equal(config.aiApiKey, 'test-key');
  assert.equal(config.aiModel, 'test-model');
});

test('AI_PROVIDER=gemini without a key or model is rejected', () => {
  assert.throws(() => loadConfig({ ...base, AI_PROVIDER: 'gemini', AI_MODEL: 'test-model' }), /AI_API_KEY and AI_MODEL are required/);
  assert.throws(() => loadConfig({ ...base, AI_PROVIDER: 'gemini', AI_API_KEY: 'test-key' }), /AI_API_KEY and AI_MODEL are required/);
});

test('an unknown AI_PROVIDER is rejected', () => {
  assert.throws(() => loadConfig({ ...base, AI_PROVIDER: 'gemni' }), /AI_PROVIDER must be "rule-based" or "gemini"/);
});
