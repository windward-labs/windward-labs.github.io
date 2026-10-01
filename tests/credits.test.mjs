import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoAccount, submitRequest, transitionRequest, allowMember, revokeMember, totals, usage, quoteRequest } from '../src/services/credits.mjs';

test('reservation, acceptance, and completion never double-charge a balance', () => {
  const account = createDemoAccount();
  const request = submitRequest(account, 'sam', 'sam', 'Prototype', 8);
  assert.deepEqual(totals(account), { used: 4, reserved: 12, available: 16 });
  transitionRequest(account, 'studio', request.id, 'accepted');
  assert.deepEqual(totals(account), { used: 12, reserved: 4, available: 16 });
  assert.throws(() => transitionRequest(account, 'studio', request.id, 'accepted'));
  transitionRequest(account, 'studio', request.id, 'completed');
  assert.equal(totals(account).available, 16);
});
test('cancellation releases a hold; a team member cannot cancel someone else’s work', () => {
  const account = createDemoAccount();
  const request = submitRequest(account, 'alex', 'alex', 'Prototype', 8);
  assert.throws(() => transitionRequest(account, 'sam', request.id, 'cancelled'));
  transitionRequest(account, 'alex', request.id, 'cancelled');
  assert.equal(totals(account).available, 24);
});
test('overspending, invalid quantities, spoofed attribution, and client acceptance are rejected', () => {
  const account = createDemoAccount();
  submitRequest(account, 'sam', 'sam', 'Prototype', 16);
  for (const credits of [16, -4, 0, 1.5, NaN]) assert.throws(() => submitRequest(account, 'sam', 'sam', 'More work', credits));
  assert.throws(() => submitRequest(account, 'sam', 'alex', 'Spoof', 2));
  assert.throws(() => transitionRequest(account, 'alex', 'request-2', 'accepted'));
  assert.equal(totals(account).available, 8);
});
test('revocation blocks future use but retains attribution and reserved credits', () => {
  const account = createDemoAccount();
  revokeMember(account, 'studio', 'sam');
  assert.throws(() => submitRequest(account, 'sam', 'sam', 'More work', 2));
  assert.deepEqual(usage(account, 'sam'), { used: 0, reserved: 4 });
  transitionRequest(account, 'alex', 'request-2', 'cancelled');
  assert.equal(totals(account).available, 28);
  allowMember(account, 'studio', ' SAM@example.com ', 'member');
  assert.equal(account.members.filter((member) => member.email === 'sam@example.com').length, 1);
  assert.equal(account.members.find((member) => member.id === 'sam').active, true);
});
test('only Windward changes allowlist; last account manager remains accessible', () => {
  const account = createDemoAccount();
  assert.throws(() => allowMember(account, 'alex', 'new@example.com', 'member'));
  assert.throws(() => revokeMember(account, 'studio', 'alex'));
  allowMember(account, 'studio', 'new@example.com', 'manager');
  revokeMember(account, 'studio', 'alex');
  assert.equal(account.members.find((member) => member.id === 'alex').active, false);
});
test('studio entry records both client attribution and staff actor', () => {
  const account = createDemoAccount();
  const request = submitRequest(account, 'studio', 'sam', 'Client requested review', 4);
  assert.equal(request.memberId, 'sam');
  assert.equal(account.events.at(-1).actorId, 'studio');
  assert.equal(account.events.at(-1).requestId, request.id);
});


test('all five levels use the supplied Normal and Fast schedule', () => {
  for (const [normal, fast, time] of [[2, 3, '30 minutes'], [4, 6, '1 hour'], [8, 12, '2 hours'], [16, null, '4 hours'], [32, null, '8 hours']]) {
    const quote = quoteRequest(normal);
    assert.equal(quote.credits, normal);
    assert.equal(quote.time, time);
    assert.equal(quote.deliveryHours, 48);
    if (fast === null) assert.throws(() => quoteRequest(normal, 'fast'));
    else {
      assert.equal(quoteRequest(normal, 'fast').credits, fast);
      assert.equal(quoteRequest(normal, 'fast').deliveryHours, 24);
    }
  }
  assert.throws(() => quoteRequest(4, 'unknown'));
});

test('Fast premium is reserved and refunded in full; work time stays unchanged', () => {
  const account = createDemoAccount();
  const request = submitRequest(account, 'sam', 'sam', 'Urgent review', 8, 'fast');
  assert.equal(request.credits, 12);
  assert.equal(request.time, '2 hours');
  assert.equal(request.speed, 'fast');
  assert.equal(totals(account).available, 12);
  transitionRequest(account, 'sam', request.id, 'cancelled');
  assert.equal(totals(account).available, 24);
});

test('unsupported speed and insufficient premium balance cannot create a request', () => {
  const account = createDemoAccount();
  submitRequest(account, 'alex', 'alex', 'Work', 16);
  const count = account.requests.length;
  assert.throws(() => submitRequest(account, 'sam', 'sam', 'Fast work', 8, 'fast'));
  assert.throws(() => submitRequest(account, 'sam', 'sam', 'Unsupported', 16, 'fast'));
  assert.equal(account.requests.length, count);
  assert.equal(totals(account).available, 8);
});

test('full-day session reserves 32 credits when sufficient funds exist', () => {
  const account = createDemoAccount();
  account.purchased = 64;
  const request = submitRequest(account, 'sam', 'sam', 'Full day', 32);
  assert.equal(request.credits, 32);
  assert.equal(request.time, '8 hours');
  assert.equal(request.deliveryHours, 48);
  assert.equal(totals(account).available, 24);
});
