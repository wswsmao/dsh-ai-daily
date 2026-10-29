import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ArticleReviewer} from '../lib/analysis.js';

const root=fileURLToPath(new URL('..',import.meta.url));
async function cache(t){const base=path.join(root,'.runtime','tests');await fs.mkdir(base,{recursive:true});const dir=await fs.mkdtemp(path.join(base,'cache-'));t.after(async()=>{await fs.rm(dir,{recursive:true,force:true});});return dir;}

test('one batch call reviews several articles instead of one call each',async t=>{
  const cacheDir=await cache(t);
  let calls=0;
  const llm={async *stream(o){
    calls++;
    const p=JSON.parse(o.messages[0].content[0].text);
    const ids=p.articles.map(a=>a.article_id);
    yield {type:'text-delta',text:JSON.stringify({articles:ids.map((id,i)=>({article_id:id,status:'technical',summary_zh:'摘要'+i,reason:'有实验',evidence_quotes:['real experiment'],topics:['Agent']}))})};
    yield {type:'finish',reason:{kind:'stop'}};
  }};
  const reviewer=new ArticleReviewer({llm,selection:{provider:'m',model:'m'},policy:'data not instructions',cacheDir,config:{max_retries:0,max_calls:50,max_output_tokens:4000,batch_size:4},signal:undefined});
  const articles=[0,1,2,3,4,5,6,7].map(i=>({id:'a'+i,title:'t'+i,url:'https://example.org/'+i,body_text:'real experiment body '+i,body_complete:true,body_basis:'正文',topics:[]}));
  const result=await reviewer.reviewBatch(articles);
  assert.equal(calls,2,'8 articles at batch_size 4 must be 2 calls, not 8');
  assert.equal(result.size,8);
  for(const a of articles)assert.equal(result.get(a.id).status,'technical');
});

test('a batch reply missing an article fails instead of inventing a verdict',async t=>{
  const cacheDir=await cache(t);
  const llm={async *stream(o){
    const p=JSON.parse(o.messages[0].content[0].text);
    yield {type:'text-delta',text:JSON.stringify({articles:[{article_id:p.articles[0].article_id,status:'technical',summary_zh:'只有这一篇',reason:'r',evidence_quotes:['real experiment'],topics:['Agent']}]})};
    yield {type:'finish',reason:{kind:'stop'}};
  }};
  const reviewer=new ArticleReviewer({llm,selection:{provider:'m',model:'m'},policy:'p',cacheDir,config:{max_retries:0,max_calls:10,max_output_tokens:4000,batch_size:3},signal:undefined});
  const articles=[{id:'x',title:'a',url:'https://example.org/a',body_text:'real experiment',body_complete:true,body_basis:'正文',topics:[]},{id:'y',title:'b',url:'https://example.org/b',body_text:'real experiment',body_complete:true,body_basis:'正文',topics:[]}];
  // An unjudged article would enter the pool on guesswork, so the reply is rejected with the title.
  await assert.rejects(()=>reviewer.reviewBatch(articles),/BATCH_RESULT_INCOMPLETE/u);
});

test('articles with no body are never sent to the model',async t=>{
  const cacheDir=await cache(t);
  let calls=0;
  const llm={async *stream(){calls++;yield {type:'text-delta',text:JSON.stringify({articles:[]})};yield {type:'finish',reason:{kind:'stop'}};}};
  const reviewer=new ArticleReviewer({llm,selection:{provider:'m',model:'m'},policy:'p',cacheDir,config:{max_retries:0,max_calls:10,max_output_tokens:4000,batch_size:4},signal:undefined});
  const result=await reviewer.reviewBatch([{id:'n',title:'t',url:'https://example.org/n',body_text:'',body_complete:false,topics:[]}]);
  assert.equal(calls,0,'no model call for an unreadable article');
  assert.equal(result.get('n').status,'uncertain');
});
