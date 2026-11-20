import {JSDOM} from 'jsdom';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const script=(await fs.readFile(new URL('../../static/notes/_shared/annotations.js',import.meta.url),'utf8')).replace('export function ','function ');
const dom=new JSDOM('<main><div id="toolbar" hidden></div><div id="body" contenteditable="false"><p id="p1">alpha <strong>bold beta</strong> gamma</p><p id="p2">delta <span class="math" contenteditable="false" data-latex="x+1">x+1</span> zeta</p></div></main>',{url:'https://example.test',runScripts:'outside-only'});
const w=dom.window,doc=w.document,root=doc.getElementById('body');w.Range.prototype.getBoundingClientRect=()=>({left:250,top:200,bottom:230,width:100,height:30});
let tool,changes=0,messages=[],id='one';w.hooks={snapshot:()=>({id,title:'source',html:root.innerHTML}),restore:n=>{root.innerHTML=n.html;tool.reset(n.id)},onChange:()=>changes++,status:v=>messages.push(v),canApply:()=>true};
w.eval(script+'\nwindow.annotation=setupAnnotations({root:document.getElementById("body"),editToolbar:document.getElementById("toolbar"),...window.hooks});');tool=w.annotation;tool.reset(id);
const bar=doc.querySelector('.annotation-bar'),float=doc.querySelector('.annotation-floating');
function select(a,x,b=a,y=a.length){const r=doc.createRange();r.setStart(a,x);r.setEnd(b,y);w.getSelection().removeAllRanges();w.getSelection().addRange(r);doc.dispatchEvent(new w.Event('selectionchange'));}
function color(kind,name){float.querySelector(`[aria-label="${kind==='highlight'?'荧光笔颜色':'文字颜色'}"]`).click();doc.querySelector(`[aria-label="${kind==='highlight'?'荧光笔':'字色'}：${name}"]`).click();}
const originalText=root.textContent;
select(doc.querySelector('#p1').firstChild,2,doc.querySelector('#p2').firstChild,3);color('highlight','黄色');
assert.equal(root.textContent,originalText);assert.equal(root.querySelectorAll('p').length,2);assert.equal(root.querySelectorAll('strong').length,1);assert.ok(root.querySelectorAll('[data-note-highlight="yellow"]').length>=4);
let marked=root.querySelector('[data-note-highlight="yellow"]');select(marked.firstChild,1,marked.firstChild,3);color('color','红色');
assert.ok(root.querySelector('[data-note-highlight="yellow"][data-note-color="red"]'));assert.equal(root.querySelectorAll('.note-annotation .note-annotation').length,0);
float.querySelector('[aria-label="清除选中的标注"]').click();assert.ok(!root.querySelector('[data-note-color="red"]'));assert.equal(root.textContent,originalText);assert.equal(root.querySelectorAll('strong').length,1);
bar.querySelector('[aria-label="撤销标注"]').click();assert.ok(root.querySelector('[data-note-color="red"]'));bar.querySelector('[aria-label="重做标注"]').click();assert.ok(!root.querySelector('[data-note-color="red"]'));
let math=root.querySelector('.math');select(math.firstChild,1,math.firstChild,2);color('highlight','蓝色');math=root.querySelector('.math');assert.equal(math.dataset.latex,'x+1');assert.equal(math.textContent,'x+1');assert.equal(math.dataset.noteHighlight,'blue');assert.ok(!math.querySelector('.note-annotation'));
float.querySelector('[aria-label="清除选中的标注"]').click();assert.equal(root.querySelector('.math').dataset.noteHighlight,undefined);assert.equal(root.querySelector('.math').dataset.latex,'x+1');
select(root.querySelector('#p1').firstChild,0,root.querySelector('#p1').firstChild,1);float.querySelector('[aria-label="加粗标注"]').click();assert.ok(root.querySelector('[data-note-bold="true"]'));float.querySelector('[aria-label="加粗标注"]').click();assert.ok(!root.querySelector('[data-note-bold="true"]'));
const size=float.querySelector('select');size.value='xlarge';size.dispatchEvent(new w.Event('change'));assert.ok(root.querySelector('[data-note-size="xlarge"]'));
const later=doc.createElement('p');later.textContent='后续编辑，必须保留';root.append(later);const now=root.innerHTML;bar.querySelector('[aria-label="撤销标注"]').click();assert.equal(root.innerHTML,now);assert.ok(messages.at(-1).includes('正文已继续编辑'));
id='two';tool.reset(id);assert.ok(bar.querySelector('[aria-label="撤销标注"]').disabled);assert.ok(bar.querySelector('[aria-label="重做标注"]').disabled);
console.log('PASS: cross-paragraph highlighting, partial recoloring/clearing, author formatting, formula integrity, undo/redo, font size and protection for later edits.');dom.window.close();
