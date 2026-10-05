import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutLink, isLocalApi } from '../src/services/stripe-checkout.mjs';
import { stripeCreditPacks } from '../src/services/stripe-catalog.mjs';

test('development checkout fails closed without a genuine test link', () => {
  assert.equal(checkoutLink(16, true), null);
  for (const link of [stripeCreditPacks[16].paymentLink, 'https://evil.example/test_abc', 'https://buy.stripe.com/test_abc?x=1']) {
    assert.equal(checkoutLink(16, true, {16:link}), null);
  }
  assert.equal(checkoutLink(16, true, {16:'https://buy.stripe.com/test_abc'}), 'https://buy.stripe.com/test_abc');
});

test('production ignores test configuration and uses the live catalog', () => {
  for (const credits of [8,16,32,64,192]) {
    assert.equal(checkoutLink(credits, false, {[credits]:'https://buy.stripe.com/test_abc'}), stripeCreditPacks[credits].paymentLink);
  }
});

test('local testing requires a loopback API', () => {
  assert.equal(isLocalApi('http://localhost:8787'), true);
  assert.equal(isLocalApi('http://127.0.0.1:8787'), true);
  assert.equal(isLocalApi('https://windward-service-api.windwardlabs.workers.dev'), false);
  assert.equal(isLocalApi('http://localhost.evil.example'), false);
});
