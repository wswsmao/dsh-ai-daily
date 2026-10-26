import test from 'node:test';
import assert from 'node:assert/strict';
import { createImAdapter, resolveDelivery, buildDailyNotification, IM_DELIVERY_CONTRACT } from '../lib/im-delivery.js';
const fake = (options = {}) => ({ contractVersion: 1, async listBots() { return options.bots ?? [{ botId: 'wxbot', channel: 'weixin', token: 'SECRET' }]; }, async listTargets(id) { return options.targets ?? [{ targetId: 'daily-report', name: '每日日报', kind: 'user', route: { toUserId: 'PRIVATE_USER_ID' }, token: 'SECRET' }]; }, async describeBot(id) { if (options.unsupportedDescribe) throw Object.assign(new Error('unsupported'), { code: 'capability-unavailable' }); return { version: 1, botId: id, channel: 'weixin', connected: options.connected ?? true, account: { fingerprint: 'a'.repeat(64), token: 'SECRET' }, capabilities: ['proactive-text-checked'] }; }, async send(id, target, text, opts) { options.calls?.push({ id, target, text, opts }); if (options.error) throw options.error; return options.result ?? { sent: true }; } });

test('IM same-host discovery strips credentials native route and account fingerprint', async () => {
  const result = await resolveDelivery({ dshIm: fake() }, { channel: 'weixin' }); assert.equal(result.ready, true); assert.equal(result.botId, 'wxbot'); assert.equal(result.targetId, 'daily-report');
  for (const key of ['SECRET', 'PRIVATE_USER_ID', 'fingerprint', 'toUserId']) assert(!JSON.stringify(result).includes(key));
});
test('multiple bots or targets require explicit configured selection', async () => {
  const r = await resolveDelivery({ dshIm: fake({ bots: [{ botId: 'one', channel: 'weixin' }, { botId: 'two', channel: 'weixin' }] }) }); assert.equal(r.ready, false); assert.equal(r.reason, 'MULTIPLE_BOTS_SELECT_EXPLICITLY');
  const s = await resolveDelivery({ dshIm: fake({ targets: [{ targetId: 'a', kind: 'user' }, { targetId: 'b', kind: 'group' }] }) }); assert.equal(s.reason, 'MULTIPLE_TARGETS_SELECT_EXPLICITLY');
  const t = await resolveDelivery({ dshIm: fake({ targets: [{ targetId: 'a', kind: 'user' }, { targetId: 'b', kind: 'group' }] }) }, { botId: 'wxbot', targetId: 'b' }); assert.equal(t.ready, true); assert.equal(t.targetId, 'b');
});
test('Weixin describe capability missing does not imply offline; explicit offline is blocked', async () => {
  const r = await resolveDelivery({ dshIm: fake({ unsupportedDescribe: true }) }); assert.equal(r.ready, true); assert.equal(r.connected, null); assert.equal(r.connectionKnown, false);
  const s = await resolveDelivery({ dshIm: fake({ connected: false }) }); assert.equal(s.ready, false); assert.equal(s.reason, 'bot-not-connected');
});
test('send notification uses plain text and saved IDs only with accepted-not-read receipt', async () => {
  const calls = []; const adapter = createImAdapter({ dshIm: fake({ calls }) }); const result = await adapter.sendNotification({ botId: 'wxbot', targetId: 'daily-report', text: 'AI日报\nhttps://wswsmao.github.io/ai-tech-daily/' });
  assert.equal(result.status, 'accepted'); assert.equal(result.sent, true); assert.equal(calls.length, 1); assert.equal(calls[0].opts.format, 'plain'); assert(!('route' in calls[0])); assert(result.note.includes('read status'));
});
test('offline before send is definite; unknown network outcome is uncertain and no retry', async () => {
  const definite = createImAdapter({ dshIm: fake({ error: Object.assign(new Error('offline'), { code: 'bot-not-connected' }) }) }); const r = await definite.sendNotification({ botId: 'wxbot', targetId: 'daily-report', text: 'x' }); assert.equal(r.status, 'blocked'); assert.equal(r.uncertain, false);
  const calls = []; const uncertain = createImAdapter({ dshIm: fake({ calls, error: Object.assign(new Error('SECRET failed'), { code: 'delivery-failed' }) }) }); const s = await uncertain.sendNotification({ botId: 'wxbot', targetId: 'daily-report', text: 'x' }); assert.equal(s.status, 'uncertain'); assert.equal(s.retryable, false); assert.equal(calls.length, 1); assert(!JSON.stringify(s).includes('SECRET'));
});
test('pre-aborted cancellation never sends and input IDs prevent injection', async () => {
  const calls = []; const a = createImAdapter({ dshIm: fake({ calls }) }); const c = new AbortController(); c.abort(); const r = await a.sendNotification({ botId: 'wxbot', targetId: 'daily-report', text: 'x', signal: c.signal }); assert.equal(r.uncertain, false); assert.equal(calls.length, 0);
  await assert.rejects(() => a.sendNotification({ botId: '../private', targetId: 'a', text: 'x' })); await assert.rejects(() => a.sendNotification({ botId: 'wxbot', targetId: 'a', text: 'x'.repeat(1601) }));
});
test('explicit RPC calls only known channel endpoint and allowlisted payload', async () => {
  const calls = []; const a = createImAdapter({}, { callRpc: async (...args) => { calls.push(args); return { ok: true, value: args[1] === 'target.list' ? { targets: [{ targetId: 'daily', kind: 'user', route: { private: 'SECRET' } }] } : { sent: true } }; } });
  const targets = await a.listTargets('wxbot'); assert.equal(targets[0].targetId, 'daily'); assert(!JSON.stringify(targets).includes('SECRET')); await a.sendNotification({ botId: 'wxbot', targetId: 'daily', text: 'x' }); assert.equal(calls[0][0], IM_DELIVERY_CONTRACT.channel); assert.equal(calls[1][1], 'message.send'); assert.deepEqual(Object.keys(calls[1][2]).sort(), ['botId', 'format', 'targetId', 'text']);
});
test('HTTP fallback loopback only has no discovery and public notification URL safe', async () => {
  assert.throws(() => createImAdapter({}, { localBaseUrl: 'https://attacker.example/', fetch: async () => {} }), { code: 'UNSAFE_IM_ENDPOINT' });
  const a = createImAdapter({}, { localBaseUrl: 'http://127.0.0.1:51841', fetch: async () => ({ ok: true, json: async () => ({ sent: true }) }) }); await assert.rejects(() => a.listBots(), { code: 'DISCOVERY_UNAVAILABLE' }); const r = await a.sendNotification({ botId: 'wxbot', targetId: 'daily', text: 'x' }); assert.equal(r.sent, true);
  const s = buildDailyNotification({ date: '2026-10-26', version: 1, count: 10, url: 'https://wswsmao.github.io/ai-tech-daily/', complete: true }); assert(s.includes('10篇')); assert.throws(() => buildDailyNotification({ url: 'http://127.0.0.1:51841/' }));
});
