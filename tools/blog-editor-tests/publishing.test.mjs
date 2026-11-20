import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parsePost,serializePost,newDraft,commitPost,postPath,today} from '../../static/blog-editor/core.js';

function draft(extra={}){return {...newDraft(),title:'中文博客：研究记录',slug:'research-log',body:'## 实验\n\n包含 **Markdown** 和 $x^2$。',...extra};}
test('round trip preserves unknown Hugo metadata, Unicode and Markdown',()=>{
  const source='---\ntitle: Original\ndate: 2025-06-27\nfeatured: true\nimage:\n  caption: Keep this\ncustom:\n  nested: [a, b]\n---\n\nOriginal text';
  const original=parsePost(source),next=draft({front:original.front,tags:'机器人, 强化学习，视觉'});
  const result=parsePost(serializePost(next));
  assert.deepEqual(result.front.custom,{nested:['a','b']});
  assert.deepEqual(result.front.image,{caption:'Keep this'});
  assert.equal(result.front.featured,true);
  assert.deepEqual(result.front.tags,['机器人','强化学习','视觉']);
  assert.equal(result.front.draft,false);assert.equal(result.front.title,next.title);
  assert.equal(result.body.trim(),next.body);assert.equal(result.front.date,today());
});
test('invalid paths, blank content and accidental future dates cannot be published',()=>{
  for(const extra of [{slug:'../../other'},{title:' '},{body:' '},{date:'2999-01-01'},{path:'config/settings.md'},{path:'content/post/_index.md'}])assert.throws(()=>serializePost(draft(extra)));
  assert.equal(postPath(draft({path:'content/post/older-post/index.md'})),'content/post/older-post/index.md');
});
function fake({existing=null,race=false,conflictOnRetry=false,refError=null}={}){
  const calls=[];let reads=0;
  const api=async(path,options={},allowMissing=false)=>{
    calls.push({path,...options,allowMissing});
    if(path==='/git/blobs')return {sha:options.body.encoding==='base64'?'image-blob':'post-blob'};
    if(path==='/git/ref/heads/main'){reads++;return {object:{sha:'head-'+reads}};}
    if(path.startsWith('/contents/'))return conflictOnRetry&&reads>1?{sha:'another-change'}:existing;
    if(path.startsWith('/git/commits/'))return {tree:{sha:'base-tree-'+reads}};
    if(path==='/git/trees')return {sha:'tree-'+reads};
    if(path==='/git/commits')return {sha:'commit-'+reads};
    if(path==='/git/refs/heads/main'){
      if(refError)throw Object.assign(new Error('forbidden'),{status:refError});
      if(race&&reads===1)throw Object.assign(new Error('not a fast forward'),{status:422});
      return {};
    }
    throw new Error('Unexpected API path '+path);
  };return {api,calls};
}
test('text and images publish atomically in one commit without force',async()=>{
  const f=fake(),d=draft({assets:[{name:'image-test.png',data:'aGVsbG8=',type:'image/png'}]});
  const result=await commitPost(f.api,d);
  const trees=f.calls.filter(c=>c.path==='/git/trees');assert.equal(trees.length,1);
  assert.deepEqual(trees[0].body.tree.map(e=>e.path),['content/post/research-log/index.md','content/post/research-log/image-test.png']);
  assert.equal(f.calls.filter(c=>c.path==='/git/commits').length,1);
  assert.equal(f.calls.find(c=>c.path==='/git/refs/heads/main').body.force,false);
  assert.equal(result.sha,'post-blob');assert.equal(result.commit,'commit-1');
});
test('existing post and slug conflicts stop before commit creation',async()=>{
  for(const d of [draft(),draft({baseSha:'original',path:'content/post/research-log/index.md'})]){
    const f=fake({existing:{sha:'newer'}});await assert.rejects(commitPost(f.api,d),/地址已存在|其他地方修改/);
    assert.equal(f.calls.filter(c=>c.path==='/git/commits').length,0);
    assert.equal(f.calls.filter(c=>c.path==='/git/refs/heads/main').length,0);
  }
});
test('unrelated branch advance retries on fresh head and preserves other changes',async()=>{
  const f=fake({existing:{sha:'original'},race:true});
  await commitPost(f.api,draft({baseSha:'original',path:'content/post/research-log/index.md'}));
  assert.deepEqual(f.calls.filter(c=>c.path==='/git/trees').map(c=>c.body.base_tree),['base-tree-1','base-tree-2']);
  assert.deepEqual(f.calls.filter(c=>c.path==='/git/commits').map(c=>c.body.parents),[['head-1'],['head-2']]);
});
test('same-post edit during branch race is detected on retry',async()=>{
  const f=fake({existing:{sha:'original'},race:true,conflictOnRetry:true});
  await assert.rejects(commitPost(f.api,draft({baseSha:'original',path:'content/post/research-log/index.md'})),/其他地方修改/);
  assert.equal(f.calls.filter(c=>c.path==='/git/refs/heads/main').length,1);
});
test('permission failures do not report success or keep retrying',async()=>{
  const f=fake({refError:403});await assert.rejects(commitPost(f.api,draft()),/forbidden/);
  assert.equal(f.calls.filter(c=>c.path==='/git/refs/heads/main').length,1);
});
