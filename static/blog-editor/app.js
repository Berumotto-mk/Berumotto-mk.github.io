import {marked} from './vendor/marked.esm.js';
import DOMPurify from '/notes/_shared/vendor/purify.es.mjs';
import {REPO,BRANCH,newDraft,today,parsePost,postPath,validate,serializePost,decode,commitPost} from './core.js?v=a067257375';
import {setupMilkdown} from './milkdown/editor.js?v=ea459a3795';

const $=id=>document.getElementById(id), apiRoot=`https://api.github.com/repos/${REPO}`;
const fields=['title','slug','date','summary','tags','body'];
let current=newDraft(), token='', busy=false, timer, previewTimer, unsaved=false, posts=[], objectUrls=[], publishPoll;
let richEditor, imageUrls=new Map();
current.slug=`post-${today().replaceAll('-','')}-${current.id.slice(0,6)}`;
const dbReady=new Promise((resolve,reject)=>{
  const request=indexedDB.open('ma-kai-blog-editor',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('drafts',{keyPath:'id'});
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(new Error('无法打开浏览器草稿存储，请使用导出草稿备份。'));
});
// Always handle storage failures, including browsers with storage disabled.
dbReady.catch(()=>{});
async function db(action,value) {
  const database=await dbReady;
  return new Promise((resolve,reject)=>{
    const tx=database.transaction('drafts',action==='getAll'?'readonly':'readwrite');
    const request=tx.objectStore('drafts')[action](...(value===undefined?[]:[value]));
    tx.oncomplete=()=>resolve(request.result);
    tx.onerror=tx.onabort=()=>reject(new Error('草稿保存失败，请导出草稿备份。'));
  });
}
function status(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error);}
function readFields(){for(const name of fields)current[name]=name==='body'&&richEditor?richEditor.read():$(name).value;current.updatedAt=Date.now();}
async function persist(){
  clearTimeout(timer);readFields();
  if(!current.path&&!current.title.trim()&&!current.body.trim()&&!current.summary.trim()&&!current.tags.trim()&&!current.assets.length){unsaved=false;return true;}
  const snapshot=structuredClone(current);
  try{
    await db('put',snapshot);
    if(current.id===snapshot.id && current.updatedAt===snapshot.updatedAt)unsaved=false;
    $('draft-status').textContent='草稿已保存到此浏览器 · '+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    await draftList();return true;
  }catch(error){$('draft-status').textContent=error.message;return false;}
}
function changed(){
  readFields();unsaved=true;$('draft-status').textContent='正在保存草稿…';
  clearTimeout(timer);timer=setTimeout(persist,500);
  $('url-hint').textContent=publicUrl();
  if(!$('preview').hidden){clearTimeout(previewTimer);previewTimer=setTimeout(renderPreview,150);}
}
function publicUrl(){
  const known=posts.find(p=>p.path===current.path)?.url;
  if(known?.startsWith('/')&&!known.startsWith('//'))return known;
  return `/post/${current.slug||'my-new-post'}/`;
}
function showDraft(draft){
  current=structuredClone(draft);unsaved=false;
  for(const name of fields)$(name).value=current[name]||'';
  for(const url of imageUrls.values())URL.revokeObjectURL(url);imageUrls.clear();
  $('slug').disabled=Boolean(current.path);
  $('editor-heading').textContent=current.path?'编辑文章':'写一篇新文章';
  $('publish').textContent=current.path?'发布更新':'发布文章';
  $('url-hint').textContent=publicUrl();
  $('view').hidden=!current.path;$('view').href=publicUrl();
  $('deployment').hidden=true;
  status(current.path?'修改会先保存为本地草稿，发布更新后才会公开。':'草稿仅在此浏览器中保存，准备好后点击发布文章。');
  richEditor?.write(current.body);
  togglePanel('article-sidebar','toggle-articles',false);
  selectView(false);draftList();
}
async function draftList(){
  try{
    const drafts=(await db('getAll')).sort((a,b)=>b.updatedAt-a.updatedAt);
    $('drafts').replaceChildren();$('draft-empty').hidden=Boolean(drafts.length);
    for(const draft of drafts){
      const button=document.createElement('button');button.type='button';button.className='item';
      button.textContent=draft.title||'未命名文章';button.setAttribute('aria-current',String(current.id===draft.id));
      const detail=document.createElement('small');detail.textContent=(draft.path?'文章修改稿 · ':'新文章草稿 · ')+new Date(draft.updatedAt).toLocaleDateString();button.append(detail);
      button.onclick=async()=>{if(busy||current.id===draft.id)return;if(!await persist())return;const latest=(await db('getAll')).find(item=>item.id===draft.id);if(latest)showDraft(latest);};
      $('drafts').append(button);
    }
  }catch(error){$('draft-empty').textContent=error.message;}
}
function renderPosts(){
  $('posts').replaceChildren();
  for(const post of posts){
    const button=document.createElement('button');button.type='button';button.className='item';button.textContent=post.title;
    const detail=document.createElement('small');detail.textContent=post.date||'打开文章进行编辑';button.append(detail);
    button.onclick=()=>loadPost(post);$('posts').append(button);
  }
  $('list-status').textContent=posts.length?`${posts.length} 篇文章`:'还没有网站文章，发布你的第一篇博客吧。';
}
async function api(path,options={},allowMissing=false){
  const response=await fetch(apiRoot+path,{method:options.method||'GET',cache:'no-store',headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(token?{Authorization:`Bearer ${token}`} : {}),...(options.body?{'Content-Type':'application/json'}:{})},...(options.body?{body:JSON.stringify(options.body)}:{})});
  if(allowMissing&&response.status===404)return null;
  if(!response.ok){
    const data=await response.json().catch(()=>({}));
    if(response.status===401){token='';$('connect').textContent='重新连接 GitHub';}
    const error=new Error(`GitHub ${response.status}：${data.message||'请求失败'}${response.status===403?'。请检查仓库 Contents 读写权限或 API 访问频率。':''}`);error.status=response.status;throw error;
  }
  return response.json();
}
async function refreshPosts(){
  $('list-status').textContent='正在加载文章…';
  try{
    const response=await fetch('./posts.json',{cache:'no-store'});
    if(response.ok){const index=await response.json();posts=Array.isArray(index)?index:[];}
    else if(!token)throw new Error('文章列表暂不可用；连接 GitHub 后可刷新。');
    if(token){
      const entries=await api(`/contents/content/post?ref=${BRANCH}`,{},true)||[];
      const known=new Map(posts.map(p=>[p.path,p]));
      posts=entries.filter(e=>e.type==='dir'||(e.name.endsWith('.md')&&e.name!=='_index.md')).map(e=>{
        const path=e.type==='dir'?e.path+'/index.md':e.path;
        return known.get(path)||{path,title:e.name.replace(/\.md$/,''),url:`/post/${e.name.replace(/\.md$/,'')}/`};
      });
    }
    renderPosts();
  }catch(error){$('list-status').textContent=error.message;}
}
function setBusy(value){
  busy=value;
  for(const element of document.querySelectorAll('button,input,textarea'))element.disabled=value;
  if(!value)$('slug').disabled=Boolean(current.path);
  const previewing=$('preview-tab').getAttribute('aria-pressed')==='true';
  richEditor?.setReadonly(value||previewing);
  $('image').disabled=value||previewing;$('source-tab').disabled=value||previewing;
}
async function loadPost(post){
  if(busy)return;if(!await persist())return;setBusy(true);status('正在载入网站文章…');
  try{
    const file=await api(`/contents/${post.path}?ref=${BRANCH}`);
    const parsed=parsePost(decode(file.content));
    const draft={...newDraft(),path:post.path,baseSha:file.sha,front:parsed.front,body:parsed.body,slug:post.path.split('/').at(-2),title:String(parsed.front.title||post.title),summary:String(parsed.front.summary||''),date:String(parsed.front.date||parsed.front.data||today()).slice(0,10),tags:Array.isArray(parsed.front.tags)?parsed.front.tags.join(', '):String(parsed.front.tags||'')};
    // Normalize dates used by older handwritten posts, e.g. 2025-6-27.
    const match=draft.date.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if(match)draft.date=`${match[1]}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}`;
    showDraft(draft);await persist();
  }catch(error){status(error.message,true);}finally{setBusy(false);}
}
function selectView(preview){
  const visual=richEditor&&!richEditor.isSource();
  $('writing').hidden=preview&&!visual;$('preview').hidden=!preview||visual;
  richEditor?.setReadonly(preview||busy);
  $('image').disabled=preview||busy;$('source-tab').disabled=preview||busy;
  $('write-tab').setAttribute('aria-pressed',String(!preview));$('preview-tab').setAttribute('aria-pressed',String(preview));
  if(preview&&!visual)renderPreview();
}
function renderPreview(){
  objectUrls.forEach(url=>URL.revokeObjectURL(url));objectUrls=[];
  const heading=document.createElement('h1');heading.textContent=current.title||'文章标题';
  const content=document.createElement('div');content.innerHTML=DOMPurify.sanitize(marked.parse(current.body||'开始编写正文后，就能在这里查看预览。'),{FORBID_TAGS:['form','input','textarea','button','style','iframe','object','embed'],FORBID_ATTR:['style']});
  for(const image of content.querySelectorAll('img')){
    const src=image.getAttribute('src');
    const asset=current.assets.find(a=>a.name===src||'./'+a.name===src);
    if(asset){
      const bytes=Uint8Array.from(atob(asset.data),c=>c.charCodeAt(0));const url=URL.createObjectURL(new Blob([bytes],{type:asset.type}));objectUrls.push(url);image.src=url;
    }else if(src && !src.startsWith('/')){
      try{image.src=new URL(src,location.origin+publicUrl()).href;}catch{}
    }
  }
  for(const link of content.querySelectorAll('a')){
    const href=link.getAttribute('href');
    try{if(href&&!href.startsWith('#'))link.href=new URL(href,location.origin+publicUrl()).href;}catch{}
    link.target='_blank';link.rel='noopener noreferrer';
  }
  $('preview').replaceChildren(heading,content);
}
function insert(before,after='',placeholder='文字'){
  if(richEditor){richEditor.insert(before+placeholder+after);return;}
  const body=$('body'),start=body.selectionStart,end=body.selectionEnd,text=body.value.slice(start,end)||placeholder;
  body.setRangeText(before+text+after,start,end,'select');body.focus();changed();
}
for(const button of document.querySelectorAll('[data-format]'))button.onclick=()=>{
  const formats={heading:['\n## ','\n','小标题'],bold:['**','**'],italic:['*','*'],list:['\n- ','\n','列表项目'],quote:['\n> ','\n','引用内容'],code:['\n```\n','\n```\n','代码'],link:['[','](https://example.com)','链接文字']};insert(...formats[button.dataset.format]);
};
$('image').onclick=()=>$('image-file').click();
$('image-file').onchange=async event=>{
  try{
    for(const file of event.target.files){
      const name=await addImage(file);
      insert(`\n![图片](${name})\n`,'','');
    }
    await persist();status('图片已加入草稿，会与文章一起发布。');
  }catch(error){status(error.message,true);}finally{event.target.value='';}
};
for(const name of fields.filter(name=>name!=='body'))$(name).addEventListener('input',changed);
$('editor').onsubmit=event=>event.preventDefault();
$('write-tab').onclick=()=>selectView(false);$('preview-tab').onclick=()=>{readFields();selectView(true);};
$('new').onclick=async()=>{if(busy)return;if(!await persist())return;const draft=newDraft();draft.slug=`post-${today().replaceAll('-','')}-${draft.id.slice(0,6)}`;showDraft(draft);await persist();$('title').focus();};
$('refresh').onclick=refreshPosts;
$('connect').onclick=()=>{
  if(token){token='';$('connect').textContent='连接 GitHub';status('已断开 GitHub，草稿继续保存在此浏览器。');return;}
  $('auth').showModal();$('token').focus();
};
$('authorize').onclick=async()=>{
  const candidate=$('token').value.trim();if(!candidate)return;
  $('authorize').disabled=true;$('auth-error').textContent='';token=candidate;$('token').value='';
  try{
    const repo=await api('');
    if(repo.permissions?.push===false)throw new Error('此账号没有网站仓库的写入权限');
    await api(`/contents/content/post?ref=${BRANCH}`);
    $('connect').textContent='断开 GitHub';$('auth').close();status('GitHub 已连接，可以发布文章。');await refreshPosts();
  }catch(error){token='';$('auth-error').textContent=error.message;}finally{$('authorize').disabled=false;}
};
$('auth').addEventListener('close',()=>{$('token').value='';});
$('publish').onclick=async()=>{
  if(busy)return;readFields();
  try{validate(current);}catch(error){status(error.message,true);return;}
  if(!token){$('auth').showModal();return;}
  await persist();
  $('publish-details').textContent=`《${current.title}》将发布到 ${publicUrl()}`;
  $('publish-dialog').showModal();
};
$('publish-dialog').addEventListener('close',async()=>{
  if($('publish-dialog').returnValue!=='publish'||busy)return;
  readFields();setBusy(true);status('正在提交文章和图片，请勿关闭页面…');
  try{
    const result=await commitPost(api,structuredClone(current));
    current.path=result.path;current.baseSha=result.sha;current.front=result.front;current.assets=[];
    await persist();$('publish').textContent='发布更新';$('editor-heading').textContent='编辑文章';
    $('view').href=publicUrl();$('view').hidden=false;
    $('deployment').href=`https://github.com/${REPO}/actions`;$('deployment').hidden=false;
    status('已提交到 GitHub，网站正在自动发布。草稿和已提交版本均已保留。');
    monitorPublication(result.commit);await refreshPosts();
  }catch(error){status(error.message,true);}finally{setBusy(false);}
});
async function monitorPublication(commit){
  clearTimeout(publishPoll);let count=0;
  const poll=async()=>{
    try{
      // Public workflow status needs no token or additional token permissions.
      const response=await fetch(`${apiRoot}/actions/runs?head_sha=${commit}`,{cache:'no-store'});
      if(!response.ok)return;
      const runs=(await response.json()).workflow_runs||[];
      const run=runs.find(r=>r.name==='Deploy website to GitHub Pages');
      if(run){$('deployment').href=run.html_url;
        if(run.status==='completed'){
          status(run.conclusion==='success'?'发布完成，点击「查看文章」即可阅读。':'文章已提交，但网站构建未成功，请点击「查看发布进度」检查。',run.conclusion!=='success');return;
        }
      }
      if(++count<36)publishPoll=setTimeout(poll,5000);
    }catch{/* The commit is safe even if status polling is unavailable. */}
  };publishPoll=setTimeout(poll,3000);
}
$('export').onclick=async()=>{
  readFields();await persist();
  const blob=new Blob([JSON.stringify({format:'ma-kai-blog-draft-v1',draft:current},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=(current.slug||'blog-draft')+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
$('import').onclick=()=>$('import-file').click();
$('import-file').onchange=async event=>{
  try{
    const file=event.target.files[0];if(!file)return;if(file.size>35*1024*1024)throw new Error('草稿文件过大');
    const data=JSON.parse(await file.text()),draft=data.draft;
    if(data.format!=='ma-kai-blog-draft-v1'||!draft||fields.some(name=>typeof draft[name]!=='string')||!Array.isArray(draft.assets)||!draft.front||typeof draft.front!=='object'||Array.isArray(draft.front))throw new Error('请选择此编辑器导出的草稿文件');
    postPath(draft);
    if(draft.assets.some(a=>!/^image-[a-z0-9-]+\.(png|jpg|webp|gif)$/.test(a.name)||typeof a.data!=='string'||!/^[a-zA-Z0-9+/]*={0,2}$/.test(a.data)||!['image/png','image/jpeg','image/webp','image/gif'].includes(a.type)))throw new Error('草稿中的图片格式无效');
    if(!await persist())return;draft.id=crypto.randomUUID();draft.updatedAt=Date.now();showDraft(draft);await persist();status('草稿已导入，发布前可以先预览。');
  }catch(error){status(error.message,true);}finally{event.target.value='';}
};
document.addEventListener('keydown',event=>{
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s'){event.preventDefault();persist();}
  if(event.key==='Escape'&&!document.querySelector('dialog[open]')){togglePanel('settings-panel','toggle-settings',false);togglePanel('article-sidebar','toggle-articles',false);}
});
window.addEventListener('beforeunload',event=>{if(unsaved||busy){event.preventDefault();event.returnValue='';}});
async function start(){
  setBusy(true);
  try{
    richEditor=await setupMilkdown({root:$('milkdown'),source:$('body'),sourceButton:$('source-tab'),onChange:changed,onUpload:addImage,resolveImage:resolveImage,notify:text=>status(text)});
  }catch(error){
    $('milkdown').hidden=true;$('body').hidden=false;$('body').addEventListener('input',changed);$('source-tab').hidden=true;
    status('可视化编辑器暂不可用，已切换到 Markdown，草稿功能仍可使用。',true);
  }
  await refreshPosts();
  try{const drafts=await db('getAll');drafts.sort((a,b)=>b.updatedAt-a.updatedAt);showDraft(drafts[0]||current);}catch{showDraft(current);}
  setBusy(false);
}
function togglePanel(panel,button,open){$(panel).hidden=!open;$(button).setAttribute('aria-expanded',String(open));}
$('toggle-articles').onclick=()=>togglePanel('article-sidebar','toggle-articles',$('article-sidebar').hidden);
$('close-articles').onclick=()=>togglePanel('article-sidebar','toggle-articles',false);
$('toggle-settings').onclick=()=>togglePanel('settings-panel','toggle-settings',$('settings-panel').hidden);
$('close-settings').onclick=()=>togglePanel('settings-panel','toggle-settings',false);
function resolveImage(src){
  const name=src.replace(/^\.\//,'');
  const asset=current.assets.find(a=>a.name===name);
  if(asset){
    if(!imageUrls.has(name)){const bytes=Uint8Array.from(atob(asset.data),c=>c.charCodeAt(0));imageUrls.set(name,URL.createObjectURL(new Blob([bytes],{type:asset.type})));}
    return imageUrls.get(name);
  }
  try{return new URL(src,location.origin+publicUrl()).href;}catch{return src;}
}
async function addImage(file){
  try{
    const ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'}[file.type];
    if(!ext)throw new Error('支持 PNG、JPG、WebP 和 GIF 图片');
    if(file.size>5*1024*1024)throw new Error('单张图片请控制在 5 MB 以内');
    if(current.assets.reduce((n,a)=>n+a.data.length,0)+file.size*4/3>28*1024*1024)throw new Error('单篇文章待发布图片请控制在 20 MB 以内');
    const buffer=await file.arrayBuffer();let binary='';for(const byte of new Uint8Array(buffer))binary+=String.fromCharCode(byte);
    const name=`image-${crypto.randomUUID()}.${ext}`;
    current.assets.push({name,type:file.type,data:btoa(binary)});
    changed();return name;
  }catch(error){status(error.message,true);throw error;}
}
start();
