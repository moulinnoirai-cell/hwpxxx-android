import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const assets=new URL('../app/src/main/assets/',import.meta.url);
// Run exactly the shipped worker, with only the browser transport / WASM loading adapted to Node.
let source=fs.readFileSync(new URL('engine-worker.js',assets),'utf8');
source=source.replace("const ready=init({module_or_path:'/engine/rhwp_bg.wasm'});","const ready=init({module_or_path:fs.readFileSync(new URL('./engine/rhwp_bg.wasm',import.meta.url))});");
const temp=new URL('.qa-worker.mjs',assets);fs.writeFileSync(temp,"import fs from 'node:fs';\n"+source);
let response;globalThis.self={postMessage:r=>response=r};
try{await import(temp.href);}finally{fs.unlinkSync(temp);}
let seq=0;async function run(op,args={}){await self.onmessage({data:{id:++seq,op,args}});if(!response.ok)throw new Error(response.error);return response.data;}
async function open(format){const bytes=fs.readFileSync(new URL('fixtures/문서.'+format,import.meta.url));const meta=await run('open',{bytes});assert.equal(meta.memoSupported,true);return select();}
async function select(){return run('select',{page:0,x:120,y:135});}
for(const format of ['hwp','hwpx'])test(`${format}: memo CRUD, history and disk round trip`,async()=>{
 let c=await open(format);assert(c.text.length>=4);
 let r=await run('memoAdd',{ident:c.ident,start:0,end:3,author:'태블릿',text:'첫 메모 <script>'});
 assert(r.dirty);let memos=await run('memos');assert.equal(memos.length,1);assert.equal(memos[0].text,'첫 메모 <script>');assert(memos[0].rects.length);
 await run('memoUpdate',{id:memos[0].id,text:'수정한 메모'});await run('undo');assert.equal((await run('memos'))[0].text,'첫 메모 <script>');await run('redo');
 const ex=await run('export',{format});await run('saved',{bytes:ex.bytes});await run('open',{bytes:ex.bytes});memos=await run('memos');assert.equal(memos[0].text,'수정한 메모');
 c=(await run('memoSelect',{id:memos[0].id})).selection;const before=c.text;await run('memoDelete',{id:memos[0].id});assert.equal((await run('memos')).length,0);assert.equal((await select()).text,before);await run('undo');assert.equal((await run('memos')).length,1);
 await run('close');
});
test('formatting, 10pt paragraph gap, copy format and save races preserve edits',async()=>{
 let c=await open('hwpx');const rg={ident:c.ident,start:0,end:3};
 await run('char',{...rg,props:{italic:true,spacings:Array(7).fill(3),ratios:Array(7).fill(95)}});
 let cs=await run('charState',rg);assert.equal(cs.italic,'on');assert.equal(cs.spacings[0],3);
 await run('para',{ident:c.ident,props:{spacingBefore:10,spacingAfter:6}});assert.equal((await run('paraState',{ident:c.ident})).spacingBefore,10);
 await run('copyFormat',{...rg,scope:'both'});await run('char',{...rg,props:{italic:false}});await run('pasteFormat',rg);assert.equal((await run('charState',rg)).italic,'on');
 const ex=await run('export',{format:'hwpx'});await run('change',{ident:c.ident,text:c.text+' 저장 중 추가',offset:0});
 assert.equal((await run('saved',{bytes:ex.bytes})).dirty,true);const ex2=await run('export',{format:'hwpx'});assert.equal((await run('saved',{bytes:ex2.bytes})).dirty,false);
});
test('table text paste stays in the cell; merged ranges expand before joining',async()=>{
 await run('open',{bytes:fs.readFileSync(new URL('fixtures/table.hwpx',import.meta.url))});
 let c=await run('select',{page:0,x:130,y:140});
 let t=await run('tableState',{ident:c.ident});assert.equal(t.cells.length,4);
 const cell=t.cells[0];
 c=await run('select',{page:cell.pageIndex,x:cell.x+5,y:cell.y+5});
 let r=await run('paste',{ident:c.ident,start:0,end:0,text:'칸 안\n붙여넣기'});assert.match(r.selection.text,/붙여넣기/);assert((await run('tableState',{ident:r.selection.ident})).cells.length>0);
 await run('undo');
 c=await run('select',{page:cell.pageIndex,x:cell.x+5,y:cell.y+5});t=await run('tableState',{ident:c.ident});
 const top=t.cells.filter(x=>x.row===0).sort((a,b)=>a.col-b.col);
 await run('tableMerge',{ident:c.ident,first:top[0].cellIdx,last:top.at(-1).cellIdx});
 c=await run('select',{page:cell.pageIndex,x:cell.x+5,y:cell.y+5});t=await run('tableState',{ident:c.ident});assert(t.cells.some(x=>x.colSpan===2));
 const bottom=t.cells.find(x=>x.row===1&&x.col===0);
 await run('tableMerge',{ident:c.ident,first:t.cells.find(x=>x.row===0).cellIdx,last:bottom.cellIdx});
 await run('export',{format:'hwpx'});
});
