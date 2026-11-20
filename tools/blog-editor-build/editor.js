import {CrepeBuilder} from '@milkdown/crepe/builder';
import {toolbar} from '@milkdown/crepe/feature/toolbar';
import {blockEdit} from '@milkdown/crepe/feature/block-edit';
import {imageBlock} from '@milkdown/crepe/feature/image-block';
import {listItem} from '@milkdown/crepe/feature/list-item';
import {linkTooltip} from '@milkdown/crepe/feature/link-tooltip';
import {placeholder} from '@milkdown/crepe/feature/placeholder';
import {table} from '@milkdown/crepe/feature/table';
import {codeMirror} from '@milkdown/crepe/feature/code-mirror';
import {latex} from '@milkdown/crepe/feature/latex';
import {editorViewCtx,prosePluginsCtx} from '@milkdown/kit/core';
import {Plugin} from '@milkdown/kit/prose/state';
import {replaceAll,insert} from '@milkdown/kit/utils';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';

// HTML and Hugo shortcodes stay in source mode; unsupported syntax is never
// silently parsed and discarded by a visual editor.
import {needsSource} from './compatibility.mjs';
export async function setupMilkdown({root,source,sourceButton,onChange,onUpload,resolveImage,notify}){
  let setting=false,original='',baseline,sourceMode=false;
  const crepe=new CrepeBuilder({root,defaultValue:''})
    .addFeature(listItem)
    .addFeature(linkTooltip,{inputPlaceholder:'输入链接地址',confirmButton:'确定',removeButton:'移除',editButton:'编辑'})
    .addFeature(imageBlock,{onUpload,proxyDomURL:resolveImage,inlineUploadPlaceholderText:'粘贴图片地址或上传图片',blockUploadPlaceholderText:'粘贴图片地址或上传图片',blockCaptionPlaceholderText:'图片说明',inlineUploadButton:'上传图片',blockUploadButton:'上传图片'})
    .addFeature(codeMirror,{languages:[],searchPlaceholder:'代码语言'})
    .addFeature(latex,{katexOptions:{trust:false,strict:false},inlineEditConfirm:'确定'})
    .addFeature(table)
    .addFeature(toolbar,{boldLabel:'加粗',italicLabel:'斜体',linkLabel:'链接',codeLabel:'行内代码',strikethroughLabel:'删除线',latexLabel:'公式'})
    .addFeature(blockEdit,{
      textGroup:{label:'正文',text:{label:'正文'},h1:{label:'一级标题'},h2:{label:'二级标题'},h3:{label:'三级标题'},h4:null,h5:null,h6:null,quote:{label:'引用'},divider:{label:'分隔线'}},
      listGroup:{label:'列表',bulletList:{label:'无序列表'},orderedList:{label:'有序列表'},taskList:{label:'待办列表'}},
      advancedGroup:{label:'插入',image:{label:'图片'},codeBlock:{label:'代码块'},table:{label:'表格'},math:{label:'公式'}}
    })
    .addFeature(placeholder,{text:'写下你的想法，或输入 / 插入内容…',mode:'doc'});
  const doc=()=>crepe.editor.action(ctx=>ctx.get(editorViewCtx).state.doc);
  function read(){return sourceMode?source.value:baseline&&doc().eq(baseline)?original:crepe.getMarkdown();}
  // Observe transactions immediately, including toolbar commands and undo.
  // A debounced listener could miss a change when switching to source mode.
  crepe.editor.config(ctx=>ctx.update(prosePluginsCtx,plugins=>[...plugins,new Plugin({view:()=>({update(view,previous){
    if(!setting&&!sourceMode&&!view.state.doc.eq(previous.doc)){source.value=read();onChange();}
  }})})]));
  await crepe.create();
  const textbox=root.querySelector('[contenteditable]');
  textbox.setAttribute('role','textbox');textbox.setAttribute('aria-label','文章正文');textbox.setAttribute('aria-multiline','true');
  function setSource(value){
    sourceMode=value;root.hidden=value;source.hidden=!value;
    sourceButton.setAttribute('aria-pressed',String(value));sourceButton.textContent=value?'返回可视化':'Markdown';
  }
  function write(markdown){
    original=markdown;source.value=markdown;
    if(needsSource(markdown)){
      setSource(true);notify('本文含 HTML 或 Hugo 短代码，已保留在 Markdown 模式，避免内容丢失。');return;
    }
    setting=true;
    try{crepe.editor.action(replaceAll(markdown,true));baseline=doc();setSource(false);}
    catch{setSource(true);notify('这篇文章暂时无法以可视化方式打开，原文已保留在 Markdown 模式。');}
    finally{setting=false;}
  }
  sourceButton.onclick=()=>{
    if(sourceMode){
      if(needsSource(source.value)){notify('本文含 HTML 或 Hugo 短代码，请在 Markdown 模式编辑，以保留原内容。');return;}
      write(source.value);
    }else{source.value=read();setSource(true);}
    onChange();
  };
  source.addEventListener('input',onChange);
  return {
    read,write,
    isSource:()=>sourceMode,
    insert(markdown){
      if(sourceMode){source.setRangeText(markdown,source.selectionStart,source.selectionEnd,'end');source.focus();}
      else{crepe.editor.action(insert(markdown));crepe.editor.action(ctx=>ctx.get(editorViewCtx).focus());}
      onChange();
    },
    setReadonly(value){crepe.setReadonly(value);source.disabled=value;},
    refreshImages(){for(const image of root.querySelectorAll('img')){const url=image.getAttribute('src');if(url&&!url.startsWith('blob:'))image.src=resolveImage(url);}},
  };
}
