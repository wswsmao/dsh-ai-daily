import { publicSourceUrl } from './site.js';

// Contract read from @xmanrui/dsh-im 5.6.0 plugin-src/host/index.mjs and delivery-service.mjs.
// No credential/account storage reads; same-Host methods only, with explicit RPC adapter if supplied.
export const IM_DELIVERY_CONTRACT = Object.freeze({ version: 1, channel: '/dsh-im-delivery', sendEndpoint: 'message.send', listTargetsEndpoint: 'target.list', weixinStatusChannel: '/weixin', weixinStatusEndpoint: 'connection.status' });
export class ImDeliveryError extends Error {
  constructor(code, message) { super(message); this.name = 'ImDeliveryError'; this.code = code; }
}
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const TARGET = /^[A-Za-z0-9._:@-]{1,128}$/u;
const validBot = (value) => { if (typeof value !== 'string' || !ID.test(value)) throw new ImDeliveryError('INVALID_BOT_ID', 'Use the saved bot ID from IM settings.'); return value; };
const validTarget = (value) => { if (typeof value !== 'string' || !TARGET.test(value)) throw new ImDeliveryError('INVALID_TARGET_ID', 'Use the saved target ID from IM settings.'); return value; };
const codeOf = (error) => typeof error?.code === 'string' && /^[A-Za-z0-9_-]{1,80}$/u.test(error.code) ? error.code : 'delivery-unknown';
const knownBeforeSend = new Set(['bad-request', 'unknown-bot', 'unknown-target', 'invalid-target', 'bot-not-connected', 'account-unverified', 'account-changed', 'target-changed', 'capability-unavailable', 'provider-unavailable']);
function safeBot(raw) {
  if (!raw || !ID.test(raw.botId ?? '') || !/^[a-z][a-z0-9-]{0,31}$/u.test(raw.channel ?? '')) return null;
  return { botId: raw.botId, channel: raw.channel };
}
function safeTarget(raw) {
  if (!raw || !TARGET.test(raw.targetId ?? '') || typeof raw.kind !== 'string') return null;
  // Deliberately strip route/native user ID, account tokens, and conversation contents.
  return { targetId: raw.targetId, name: typeof raw.name === 'string' ? raw.name.slice(0, 80) : '', kind: raw.kind.slice(0, 40) };
}
function getService(ctx) {
  if (ctx?.dshIm) return ctx.dshIm;
  try { return ctx?.get?.('dshIm'); } catch { return undefined; }
}
async function rpcValue(callRpc, channel, endpoint, payload, signal) {
  const response = await callRpc(channel, endpoint, payload, signal);
  if (response?.ok !== true) throw new ImDeliveryError(codeOf(response?.error), 'The IM service rejected the request.');
  return response.value;
}
/** Source-proven service adapter, not an Inspect-method business invocation. */
export function createImAdapter(ctx = {}, { service = getService(ctx), callRpc, listBots, describeBot, fetch: fetchImpl, localBaseUrl } = {}) {
  const serviceReady = service && typeof service.send === 'function' && typeof service.listTargets === 'function' && typeof service.listBots === 'function';
  let httpBase;
  if (localBaseUrl !== undefined) {
    const u = new URL(localBaseUrl);
    if (!['http:', 'https:'].includes(u.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname) || u.username || u.password || u.search || u.hash) throw new ImDeliveryError('UNSAFE_IM_ENDPOINT', 'Fallback IM HTTP is limited to a verified loopback Host.');
    httpBase = u.origin;
  }
  const adapter = {
    available: Boolean(serviceReady || callRpc || httpBase && fetchImpl), mode: serviceReady ? 'same-host' : callRpc ? 'connection-rpc' : httpBase && fetchImpl ? 'loopback-http' : 'unavailable',
    async listBots({ signal } = {}) {
      signal?.throwIfAborted();
      const result = serviceReady ? await service.listBots() : typeof listBots === 'function' ? await listBots(signal) : null;
      if (!Array.isArray(result)) throw new ImDeliveryError('DISCOVERY_UNAVAILABLE', 'IM bot discovery requires the same-Host service; HTTP exposes send only.');
      return result.map(safeBot).filter(Boolean);
    },
    async listTargets(botId, { signal } = {}) {
      validBot(botId); signal?.throwIfAborted();
      let result;
      if (serviceReady) result = await service.listTargets(botId);
      else if (typeof callRpc === 'function') result = (await rpcValue(callRpc, IM_DELIVERY_CONTRACT.channel, IM_DELIVERY_CONTRACT.listTargetsEndpoint, { botId }, signal)).targets;
      else throw new ImDeliveryError('DISCOVERY_UNAVAILABLE', 'Configure an IM saved target or enable same-Host discovery.');
      if (!Array.isArray(result)) throw new ImDeliveryError('INVALID_IM_DISCOVERY', 'The IM target response is invalid.');
      return result.map(safeTarget).filter(Boolean);
    },
    async describeBot(botId, { signal } = {}) {
      validBot(botId); signal?.throwIfAborted();
      const method = serviceReady && typeof service.describeBot === 'function' ? (id) => service.describeBot(id) : describeBot;
      if (typeof method !== 'function') return { botId, connected: null, verified: false };
      try {
        const raw = await method(botId, signal);
        return { botId, channel: typeof raw?.channel === 'string' ? raw.channel : undefined, connected: typeof raw?.connected === 'boolean' ? raw.connected : null, verified: raw?.version === 1, capabilities: Array.isArray(raw?.capabilities) ? raw.capabilities.filter((v) => typeof v === 'string' && v.length < 100) : [] };
      } catch (error) {
        if (codeOf(error) === 'capability-unavailable') return { botId, connected: null, verified: false };
        throw error;
      }
    },
    async sendNotification({ botId, targetId, text, signal }) {
      validBot(botId); validTarget(targetId);
      if (typeof text !== 'string' || !text.trim() || text.length > 1600 || /\u0000/u.test(text)) throw new ImDeliveryError('INVALID_NOTIFICATION', 'Send a short non-empty notification, at most 1600 characters.');
      if (signal?.aborted) return { status: 'cancelled', sent: false, uncertain: false, retryable: false, reason: 'cancelled-before-send' };
      let started = false;
      try {
        let result;
        if (serviceReady) { started = true; result = await service.send(botId, targetId, text, { signal, format: 'plain' }); }
        else if (typeof callRpc === 'function') { started = true; result = await rpcValue(callRpc, IM_DELIVERY_CONTRACT.channel, IM_DELIVERY_CONTRACT.sendEndpoint, { botId, targetId, text, format: 'plain' }, signal); }
        else if (httpBase && fetchImpl) {
          started = true;
          const response = await fetchImpl(`${httpBase}/api/dsh-im/delivery/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ botId, targetId, text, format: 'plain' }), signal, redirect: 'error' });
          result = await response.json(); if (!response.ok) throw new ImDeliveryError(codeOf(result?.error), 'IM delivery HTTP rejected the request.');
        } else throw new ImDeliveryError('IM_UNAVAILABLE', 'The configured IM plugin is not available.');
        if (result?.sent !== true) return { status: 'uncertain', sent: false, uncertain: true, retryable: false, reason: 'send-result-unknown' };
        return { status: 'accepted', sent: true, uncertain: false, retryable: false, acceptedAt: new Date().toISOString(), note: 'Platform accepted the request; final delivery and read status are not guaranteed.' };
      } catch (error) {
        const code = codeOf(error);
        // Keep the provider's own message: collapsing it to a code hides why the platform refused.
        // Never echo the provider's message: it can embed tokens, ids or user content. The code is
        // enough to act on, and a wrong-looking code is cheaper than a leaked secret.
        const detail = code;
        if (!started || knownBeforeSend.has(code)) return { status: 'blocked', sent: false, uncertain: false, retryable: code === 'bot-not-connected' || code === 'provider-unavailable', reason: code, detail };
        // Once a send began, failure/abort may follow accepted chunks. Never retry uncertain outcomes automatically.
        return { status: 'uncertain', sent: false, uncertain: true, retryable: false, reason: code, detail: code };
      }
    },
  };
  return Object.freeze(adapter);
}
/** Read-only discovery; no automatic choice of a recipient if multiple targets exist. */
export async function resolveDelivery(ctx, config = {}) {
  const adapter = config.adapter ?? createImAdapter(ctx, config.adapterOptions);
  if (!adapter.available) return { ready: false, status: 'needs_setup', reason: 'IM_UNAVAILABLE', bots: [] };
  if (config.enabled === false) return { ready: false, status: 'disabled', reason: 'notification-disabled', bots: [] };
  try {
    const bots = await adapter.listBots({ signal: config.signal });
    const channel = config.channel === 'wechat' ? 'weixin' : config.channel ?? 'weixin';
    const candidates = [];
    for (const bot of bots.filter((b) => b.channel === channel || config.botId && b.botId === config.botId)) {
      const targets = await adapter.listTargets(bot.botId, { signal: config.signal });
      const state = await adapter.describeBot(bot.botId, { signal: config.signal });
      candidates.push({ ...bot, connected: state.connected, verified: state.verified, targets });
    }
    const selected = config.botId ? candidates.find((b) => b.botId === validBot(config.botId)) : candidates.length === 1 ? candidates[0] : undefined;
    if (!selected) return { ready: false, status: 'needs_setup', reason: candidates.length > 1 ? 'MULTIPLE_BOTS_SELECT_EXPLICITLY' : 'BOT_NOT_CONFIGURED', bots: candidates };
    // An explicitly configured targetId is authoritative: the Host may not list saved targets yet
    // (listTargets returns [] until one is saved in the UI), but a known address can still be sent to.
    // Without this, a configured target could never be used. Delivery still fails loudly if the
    // channel rejects the address.
    let target;
    if (config.targetId) {
      const wanted = validTarget(config.targetId);
      target = selected.targets.find((t) => t.targetId === wanted)
        ?? { targetId: wanted, name: '', kind: 'explicit', unlisted: true };
    } else {
      target = selected.targets.length === 1 ? selected.targets[0] : undefined;
    }
    if (!target) return { ready: false, status: 'needs_setup', reason: selected.targets.length > 1 ? 'MULTIPLE_TARGETS_SELECT_EXPLICITLY' : 'TARGET_NOT_CONFIGURED', bots: candidates };
    if (selected.connected === false) return { ready: false, status: 'blocked', reason: 'bot-not-connected', botId: selected.botId, targetId: target.targetId, bots: candidates };
    return { ready: true, status: 'configured', botId: selected.botId, targetId: target.targetId, channel: selected.channel, connected: selected.connected, connectionKnown: selected.connected !== null, bots: candidates, note: selected.channel === 'weixin' ? 'WeChat proactive sends need a recent inbound user context and platform permission; online polling does not guarantee delivery.' : 'Delivery remains subject to channel permission and quotas.' };
  } catch (error) { return { ready: false, status: 'needs_setup', reason: codeOf(error), bots: [] }; }
}
export async function sendNotification(ctx, request, options = {}) { return createImAdapter(ctx, options).sendNotification(request); }
export function buildDailyNotification({ title = 'AI 技术日报', date, version, count = 0, url, complete = false }) {
  const publicUrl = publicSourceUrl(url);
  if (!publicUrl.startsWith('https://')) throw new ImDeliveryError('INVALID_PUBLIC_LINK', 'A verified public HTTPS report link is required.');
  return `${String(title).slice(0, 120)} · ${String(date).slice(0, 20)}\n第${String(version).slice(0, 12)}版 · ${Number.isSafeInteger(count) && count >= 0 ? count : 0}篇技术文章\n${complete ? '本次检索可见范围完成' : '存在覆盖或处理缺口，请查看网页说明'}\n${publicUrl}`;
}
