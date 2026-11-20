import yaml from './vendor/js-yaml.mjs';

export const REPO = 'Berumotto-mk/Berumotto-mk.github.io';
export const BRANCH = 'main';
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
export function newDraft() {
  return { id:crypto.randomUUID(), title:'',slug:'',date:today(),summary:'',tags:'',body:'',front:{},path:null,baseSha:null,assets:[],updatedAt:Date.now() };
}
export function parsePost(source) {
  const match = source.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error('这篇文章没有受支持的 YAML 头信息，请在 GitHub 中检查格式。');
  const front = yaml.load(match[1], {schema:yaml.JSON_SCHEMA}) || {};
  if (typeof front !== 'object' || Array.isArray(front)) throw new Error('文章头信息格式无效');
  return {front,body:match[2].replace(/^\r?\n/,'')};
}
export function postPath(draft) {
  if (draft.path) {
    if (!/^content\/post\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.md$/.test(draft.path) || draft.path.endsWith('/_index.md')) throw new Error('文章路径无效');
    return draft.path;
  }
  if (!SLUG.test(draft.slug)) throw new Error('请填写文章地址：使用小写字母、数字和连字符，例如 my-first-post。');
  return `content/post/${draft.slug}/index.md`;
}
export function validate(draft) {
  if (!draft.title.trim()) throw new Error('请先填写文章标题');
  if (!draft.body.trim()) throw new Error('请先填写文章正文');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date) || !Number.isFinite(Date.parse(draft.date))) throw new Error('请填写有效的发布日期');
  if (draft.date > today()) throw new Error('发布日期在未来，请改为今天或更早的日期后发布。');
  postPath(draft);
}
export function serializePost(draft) {
  validate(draft);
  const front = {...draft.front,title:draft.title.trim(),date:draft.date,summary:draft.summary.trim(),tags:draft.tags.split(/[,，]/).map(s=>s.trim()).filter(Boolean),draft:false,lastmod:new Date().toISOString()};
  if (!front.authors) front.authors=['admin'];
  return `---\n${yaml.dump(front,{lineWidth:-1,noRefs:true,sortKeys:false})}---\n\n${draft.body.trim()}\n`;
}
export function decode(content) {return new TextDecoder().decode(Uint8Array.from(atob(content.replace(/\s/g,'')),c=>c.charCodeAt(0)));}
export function encode(content) {let s=''; for(const b of new TextEncoder().encode(content))s+=String.fromCharCode(b);return btoa(s);}

// A single commit contains both text and images. Never force a branch update.
export async function commitPost(api,draft) {
  const path=postPath(draft),content=serializePost(draft);
  const postBlob=await api('/git/blobs',{method:'POST',body:{content,encoding:'utf-8'}});
  const imageEntries=[];
  for(const asset of draft.assets) {
    const dir=path.slice(0,path.lastIndexOf('/')+1);
    if (!/^[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|gif)$/.test(asset.name)) throw new Error('图片文件名无效');
    const blob=await api('/git/blobs',{method:'POST',body:{content:asset.data,encoding:'base64'}});
    imageEntries.push({path:dir+asset.name,mode:'100644',type:'blob',sha:blob.sha});
  }
  for(let attempt=0;attempt<3;attempt++) {
    const head=(await api(`/git/ref/heads/${BRANCH}`)).object.sha;
    const existing=await api(`/contents/${path}?ref=${head}`,{},true);
    if (draft.baseSha ? existing?.sha!==draft.baseSha : Boolean(existing)) {
      throw new Error(draft.baseSha ? '这篇文章已在其他地方修改。草稿已保留，请重新打开网站文章，核对后再发布。' : '这个文章地址已存在，请更换地址，或从左侧打开该文章进行修改。');
    }
    const base=await api(`/git/commits/${head}`);
    const tree=await api('/git/trees',{method:'POST',body:{base_tree:base.tree.sha,tree:[{path,mode:'100644',type:'blob',sha:postBlob.sha},...imageEntries]}});
    const commit=await api('/git/commits',{method:'POST',body:{message:`${draft.baseSha?'Update':'Publish'} blog: ${draft.title.trim()}`,tree:tree.sha,parents:[head]}});
    try {
      await api(`/git/refs/heads/${BRANCH}`,{method:'PATCH',body:{sha:commit.sha,force:false}});
    } catch(error) {
      if (![409,422].includes(error.status)||attempt===2)throw error;
      continue;
    }
    return {path,sha:postBlob.sha,commit:commit.sha,front:parsePost(content).front};
  }
}
