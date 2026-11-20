import {test} from 'node:test';
import assert from 'node:assert/strict';
import {needsSource} from '../blog-editor-build/compatibility.mjs';
import {newDraft,serializePost,parsePost} from '../../static/blog-editor/core.js';

test('Hugo shortcodes and embedded HTML remain editable without a lossy conversion',()=>{
  for(const source of ['before <span class="custom">原文</span> after','{{< youtube example >}}','{{% callout note %}}','<!-- existing comment -->'])assert.equal(needsSource(source),true);
  const markdown='## 标题\n\n- 项目\n\n$x^2$\n\n```html\n<div>code sample</div>\n```';
  assert.equal(needsSource(markdown),false);
  assert.equal(needsSource('<br />\n\nNormal paragraph'),false);
});
test('mathematical posts enable Hugo math while preserving page-specific settings',()=>{
  const draft={...newDraft(),title:'公式',slug:'math-post',body:'行内 $x^2$\n\n$$\nE=mc^2\n$$',front:{custom:{keep:true}}};
  const result=parsePost(serializePost(draft));
  assert.equal(result.front.math,true);assert.deepEqual(result.front.custom,{keep:true});
  assert.equal(result.body.trim(),draft.body);
});
