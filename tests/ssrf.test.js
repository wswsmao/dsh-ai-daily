import test from 'node:test';
import assert from 'node:assert/strict';
import {makePublicFetch,assertHostPublic} from '../lib/sources.js';

const okResponse=(body='<rss/>')=>({status:200,ok:true,headers:new Map(),body:null,async text(){return body;}});
const redirectResponse=(location)=>({status:302,ok:false,headers:{get:(k)=>k==='location'?location:null},body:null});

test('assertHostPublic rejects private and local names',async()=>{
  for(const host of ['127.0.0.1','10.1.2.3','192.168.1.1','169.254.169.254','172.16.0.1','172.31.255.255','100.64.0.1','0.0.0.0','localhost','metadata.local','[::1]','[fd00::1]','[fe80::1]']){
    await assert.rejects(()=>assertHostPublic(host,{lookup:async()=>[]}),/PRIVATE_HOST_REFUSED/,`must refuse ${host}`);
  }
  await assertHostPublic('example.com',{lookup:async()=>[{address:'93.184.216.34'}]});
});

test('assertHostPublic refuses a public name that resolves to a private address',async()=>{
  await assert.rejects(()=>assertHostPublic('evil.example.com',{lookup:async()=>[{address:'127.0.0.1'}]}),/PRIVATE_HOST_REFUSED/);
  await assert.rejects(()=>assertHostPublic('evil.example.com',{lookup:async()=>[{address:'93.184.216.34'},{address:'10.0.0.5'}]}),/PRIVATE_HOST_REFUSED/);
  await assert.rejects(()=>assertHostPublic('nx.example.com',{lookup:async()=>{throw Object.assign(new Error('not found'),{code:'ENOTFOUND'});}}),/HOST_RESOLUTION_FAILED/);
});

test('fetch refuses private initial targets',async()=>{
  const fetchFn=async()=>{throw new Error('FETCH_MUST_NOT_BE_CALLED');};
  const publicFetch=makePublicFetch(fetchFn,{lookup:async()=>[]});
  for(const url of ['http://127.0.0.1/','https://10.0.0.1/x','http://169.254.169.254/latest/meta-data/','https://localhost:8080/']){
    await assert.rejects(()=>publicFetch(url),/PRIVATE_FETCH_REFUSED|PRIVATE_HOST_REFUSED/,`must refuse ${url}`);
  }
});

test('fetch refuses redirect chains that turn private and never issues the second request',async()=>{
  let calls=0;
  const fetchFn=async(url)=>{calls++;return redirectResponse('http://127.0.0.1/admin');};
  const publicFetch=makePublicFetch(fetchFn,{lookup:async()=>[{address:'93.184.216.34'}]});
  await assert.rejects(()=>publicFetch('https://example.com/start'),/PRIVATE_HOST_REFUSED/);
  assert.equal(calls,1,'second hop must not be requested');
});

test('fetch refuses redirect to link-local metadata and IPv6 private ranges',async()=>{
  const seen=[];
  const fetchFn=async(url)=>{seen.push(url);return redirectResponse('http://169.254.169.254/latest');};
  const publicFetch=makePublicFetch(fetchFn,{lookup:async()=>[{address:'93.184.216.34'}]});
  await assert.rejects(()=>publicFetch('https://example.com/start'),/PRIVATE_HOST_REFUSED/);
  assert.equal(seen.length,1);
});

test('fetch follows public redirects up to the hop limit then stops',async()=>{
  let calls=0;
  const fetchFn=async()=>{calls++;return redirectResponse('https://example.org/next');};
  const publicFetch=makePublicFetch(fetchFn,{lookup:async()=>[{address:'93.184.216.34'}]});
  await assert.rejects(()=>publicFetch('https://example.com/start'),/SOURCE_REDIRECT_LIMIT/);
  assert.equal(calls,5);
});

test('fetch returns body for a public response and enforces the size cap',async()=>{
  const fetchFn=async()=>okResponse('<rss>ok</rss>');
  assert.equal(await makePublicFetch(fetchFn,{lookup:async()=>[{address:'93.184.216.34'}]})('https://example.com/feed'),'<rss>ok</rss>');
  const chunk=new TextEncoder().encode('x'.repeat(100000));
  let served=0;
  const streamFetch=async()=>({status:200,ok:true,headers:{get:()=>null},body:{getReader(){return {async read(){if(served>=6000000)return {done:true};served+=chunk.byteLength;return {done:false,value:chunk};},async cancel(){}};}}});
  await assert.rejects(()=>makePublicFetch(streamFetch,{lookup:async()=>[{address:'93.184.216.34'}]})('https://example.com/big'),/SOURCE_TOO_LARGE/);
});

test('fetch honours abort and never swallows it as a source failure',async()=>{
  const controller=new AbortController();
  const fetchFn=async()=>redirectResponse('https://example.org/next');
  const publicFetch=makePublicFetch(fetchFn,{lookup:async()=>[{address:'93.184.216.34'}]});
  const promise=publicFetch('https://example.com/start',controller.signal);
  controller.abort(new Error('CANCELLED'));
  await assert.rejects(()=>promise,/CANCELLED/);
});
