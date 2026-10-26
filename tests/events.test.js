import test from 'node:test';
import assert from 'node:assert/strict';
import {groupEvents,trustedEventKey} from '../lib/analysis.js';

const article=(id,url,title,eventKey,status='technical')=>({id,url,title,account:'a',author:'',date:'2026-10-26',topics:['Agent'],analysis:{status,summary_zh:'s',topics:['Agent'],event_key:eventKey}});

test('event_key is trusted only when the article carries that identity',()=>{
  assert.equal(trustedEventKey(article('a1','https://arxiv.org/abs/2510.12345','Paper','2510.12345')),'2510.12345');
  assert.equal(trustedEventKey(article('a2','https://github.com/agiresearch/AIOS/releases/tag/v1.5.0','AIOS v1.5.0','v1.5.0')),'v1.5.0');
  assert.equal(trustedEventKey(article('a3','https://example.com/post','Nothing identifiable','2510.12345')),'');
  assert.equal(trustedEventKey(article('a4','https://example.com/post','No key','')),'');
});

test('unverifiable event_key never merges unrelated articles',()=>{
  const a=article('a','https://example.com/one','Article one','shared-buzzword');
  const b=article('b','https://example.com/two','Article two','shared-buzzword');
  const events=groupEvents([a,b]);
  assert.equal(events.length,2,'model-provided key must not merge unrelated articles');
  assert.deepEqual(events.map(e=>e.key).sort(),['a','b']);
});

test('a verified shared identity merges articles',()=>{
  const a=article('a','https://arxiv.org/abs/2510.12345','Paper coverage','2510.12345');
  const b=article('b','https://arxiv.org/abs/2510.12345','Another take','2510.12345');
  const events=groupEvents([a,b]);
  assert.equal(events.length,1);
  assert.equal(events[0].sources.length,2);
});

test('a group whose member lacks the identity is split back into single articles',()=>{
  const a=article('a','https://arxiv.org/abs/2510.12345','Paper coverage','2510.12345');
  const b=article('b','https://example.com/unrelated','Unrelated but same key','2510.12345');
  const events=groupEvents([a,b]);
  assert.equal(events.length,2,'mixed group must not present a merged public event');
});

test('promotional articles are never grouped',()=>{
  const a=article('a','https://arxiv.org/abs/2510.12345','Real','2510.12345');
  const b=article('b','https://arxiv.org/abs/2510.12345','Ad','2510.12345','promotional');
  const events=groupEvents([a,b]);
  assert.equal(events.length,1);
  assert.equal(events[0].sources.length,1);
});
