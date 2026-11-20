import {build} from 'esbuild';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
const require=createRequire(import.meta.url),here=path.dirname(new URL(import.meta.url).pathname);
const out=path.resolve(here,'../../static/blog-editor/milkdown');
await mkdir(out,{recursive:true});
// Self-host KaTeX's WOFF2 fonts inside the CSS; the editor needs no external CDN.
const katex=path.dirname(require.resolve('katex/package.json',{paths:[path.dirname(require.resolve('@milkdown/crepe'))]}));
let css=await readFile(path.join(katex,'dist/katex.min.css'),'utf8');
css=css.replace(/src:([^;}]+)(?:;|(?=}))/g,(match,src)=>{const woff=src.match(/url\(([^)]+\.woff2)\)\s*format\(["']woff2["']\)/);return woff?`src:url(${woff[1]}) format("woff2");`:match;});
for(const filename of [...new Set([...css.matchAll(/url\((fonts\/[^)]+\.woff2)\)/g)].map(m=>m[1]))]){
  const data=await readFile(path.join(katex,'dist',filename));css=css.replaceAll(`url(${filename})`,`url(data:font/woff2;base64,${data.toString('base64')})`);
}
const result=await build({entryPoints:[path.join(here,'editor.js')],bundle:true,format:'esm',platform:'browser',target:['es2022'],minify:true,metafile:true,legalComments:'external',outfile:path.join(out,'editor.js'),plugins:[{name:'katex-self-hosted',setup(b){b.onLoad({filter:/katex\.min\.css$/},()=>({contents:css,loader:'css'}));}}],define:{'process.env.NODE_ENV':'"production"'}});

const notices=new Map();
for(const input of Object.keys(result.metafile.inputs)){
  let dir=path.dirname(path.resolve(input));
  while(dir.includes('node_modules')){
    try{
      const pkg=JSON.parse(await readFile(path.join(dir,'package.json'),'utf8'));
      if(pkg.name&&!notices.has(pkg.name)){
        let license='';for(const filename of ['LICENSE','LICENSE.md','LICENSE.txt','license','license.md']){try{license=await readFile(path.join(dir,filename),'utf8');break;}catch{}}
        notices.set(pkg.name,`${pkg.name} ${pkg.version}\nLicense: ${pkg.license||'see upstream'}\n${license}`);
      }
      break;
    }catch{dir=path.dirname(dir);}
  }
}
await writeFile(path.join(out,'THIRD_PARTY_NOTICES.txt'),[...notices.values()].join('\n\n--------------------\n\n'));
console.log('Built Milkdown editor and self-hosted styles/fonts.');
