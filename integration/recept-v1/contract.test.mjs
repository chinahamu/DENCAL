import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { evaluateTransfer, MAX_BODY_BYTES, readTransfer, validateResponse } from './contract.mjs';

const { source, master, messages, variants, cases } = JSON.parse(readFileSync(new URL('fixtures.json', import.meta.url), 'utf8'));

function fixture(name) {
  const variant = variants[name];
  return variant ? { ...messages[variant.base], ...variant.changes } : messages[name];
}

function wire(message, suffix = '') {
  return Buffer.from(JSON.stringify(message) + suffix, 'utf8');
}

function lookupMaster(codeSystem, code, date) {
  return master.some((item) => item.codeSystem === codeSystem && item.code === code && item.from <= date && date <= item.to);
}

for (const example of cases) {
  test(`連携 v1 · ${example.name}`, () => {
    const inbox = [];
    for (const name of example.history) {
      const message = fixture(name);
      const historicalSource = { facilityId: message.facilityId, senderId: message.senderId };
      const result = evaluateTransfer(wire(message), { source: historicalSource, inbox, hasMaster: lookupMaster });
      assert.equal(result.httpStatus, 202);
      inbox.push({ message, receipt: result.body });
    }
    const message = fixture(example.message);
    const bytes = wire(message, example.suffix);
    const hasMaster = example.omitProcedureMaster
      ? (system, code, date) => system !== 'recept-medical-procedure' && lookupMaster(system, code, date)
      : lookupMaster;
    const result = evaluateTransfer(bytes, { source, inbox, hasMaster });
    assert.equal(result.httpStatus, example.httpStatus);
    assert.ok(validateResponse(result.body), JSON.stringify(validateResponse.errors));
    if (example.error) {
      assert.deepEqual(result.body, { error: example.error });
    } else {
      assert.deepEqual(result.body, {
        integrationId: message.integrationId,
        bodySha256: createHash('sha256').update(bytes).digest('hex'),
        status: example.status,
        issues: example.issues,
      });
      if (result.httpStatus === 200) assert.equal(result.body, inbox[0].receipt);
    }
  });
}

test('連携 v1 · 送信側の形式検証は受信履歴やマスターなしで実行できる', () => {
  assert.deepEqual(readTransfer(wire(messages.initial)), { message: messages.initial });
});

test('連携 v1 · JSONの破損・不正UTF-8・サイズ超過を拒否する', () => {
  const options = { source, hasMaster: lookupMaster };
  for (const malformed of [Buffer.from('{'), Buffer.from([0xc3, 0x28]), Buffer.from('\uFEFF{}')]) {
    assert.deepEqual(evaluateTransfer(malformed, options), { httpStatus: 400, body: { error: 'invalid_json' } });
  }
  assert.deepEqual(evaluateTransfer(Buffer.alloc(MAX_BODY_BYTES + 1), options), {
    httpStatus: 413, body: { error: 'payload_too_large' },
  });
});
