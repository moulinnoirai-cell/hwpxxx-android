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
test('overlapping memo / invalid formats / oversized paste fail without losing undo',async()=>{
 let c=await open('hwpx');const rg={ident:c.ident,start:0,end:3};
 await run('char',{...rg,props:{bold:true}});await run('undo');
 await assert.rejects(run('char',{...rg,props:{ratios:Array(7).fill(999)}}));
 assert.equal((await run('redo')).dirty,true);
 await run('memoAdd',{...rg,author:'A',text:'保護한 메모😀'});
 await assert.rejects(run('memoAdd',{...rg,author:'B',text:'overlap'}));assert.equal((await run('memos')).length,1);
 await assert.rejects(run('paste',{...rg,text:Array(202).fill('row').join('\n')}));assert.equal((await run('memos'))[0].text,'保護한 메모😀');
 await assert.rejects(run('change',{ident:c.ident,text:'x'.repeat(100001)}));
 await assert.rejects(run('char',{ident:'stale-paragraph',start:0,end:3,props:{italic:true}}));
 await run('export',{format:'hwpx'});
});
test('Unicode multiline paste, undo branching and document navigation',async()=>{
 let c=await open('hwpx');const original=c.text;
 let r=await run('paste',{ident:c.ident,start:0,end:0,text:'마우스😀\r\n두 번째\n마지막'});assert(r.selection.text.startsWith('마지막'));
 await run('undo');assert.equal((await select()).text,original);await run('redo');
 c=await run('navigate',{edge:'start'});assert(c.text.startsWith('마우스😀'));c=await run('navigate',{edge:'end'});assert.equal(c.offset,[...c.text].length);
 await run('undo');c=await select();await run('change',{ident:c.ident,text:c.text+' 새 갈래',offset:0});assert.equal((await run('redo')).canRedo,false);
 await run('export',{format:'hwpx'});
});
test('saving wrong bytes is refused and cancellation returns last successful disk baseline',async()=>{
 let c=await open('hwpx');const original=c.text;await run('change',{ident:c.ident,text:c.text+' unsaved'});
 const ex=await run('export',{format:'hwpx'}),bad=new Uint8Array(ex.bytes);bad[0]^=1;
 await assert.rejects(run('saved',{bytes:bad}));await run('cancel');assert.equal((await select()).text,original);
});
test('hardware cursor crosses paragraphs and Delete joins the next paragraph as one undo step',async()=>{
 await open('hwpx');let c=await run('navigate',{edge:'start'}),original=c.text;
 await run('split',{ident:c.ident,start:2,end:2});c=await run('adjacent',{direction:-1});assert.equal(c.text,[...original].slice(0,2).join(''));assert.equal(c.offset,2);
 c=await run('adjacent',{direction:1});assert.equal(c.offset,0);assert.equal(c.text,[...original].slice(2).join(''));
 c=await run('adjacent',{direction:-1});await run('mergeNext',{ident:c.ident,start:c.text.length,end:c.text.length});assert.equal((await select()).text,original);
 await run('undo');assert.equal((await run('navigate',{edge:'start'})).text,[...original].slice(0,2).join(''));
 await run('export',{format:'hwpx'});
});

// ---- multi-paragraph selection, internal clipboard, grid paste, recovery draft, encrypted documents ----
const P0={page:0,x:120,y:135},P1={page:0,x:200,y:160};
async function twoParagraphRange(preview=false){await open('hwpx');return run('rangeSelect',{from:P0,to:P1,preview});}
test('mouse drag across two paragraphs selects, copies, deletes and merges them into one paragraph',async()=>{
 const before=(await open('hwpx')).text;
 const whole=await run('rangeSelect',{from:P0,to:P1});
 const r=whole.range;assert(r.paragraphs>=2);assert(r.text.includes('\n'));assert(r.rects.length>=2);assert(r.rident);
 const cheap=await run('rangeSelect',{from:P0,to:P1,preview:true});assert.equal(cheap.range.text,'');assert.equal(cheap.range.rects.length,r.rects.length);assert.equal(cheap.range.rident,r.rident);
 assert.equal((await run('rangeCopy',{rident:r.rident})).text,r.text);
 const d=await run('rangeDelete',{rident:r.rident});assert(d.dirty);assert(!d.stale);
 const start=await run('navigate',{edge:'start'}),end=await run('navigate',{edge:'end'});
 assert.equal(start.text,end.text,'the document is one paragraph now');assert(start.text.length>0&&start.text.length<before.length+30);
 assert(!start.text.includes('한글 문서 실'));
});
test('range delete: undo restores text and the range selection, redo repeats it',async()=>{
 const m=await twoParagraphRange();const paragraphsBefore=(await run('navigate',{edge:'end'})).text;void paragraphsBefore;
 const start=(await run('rangeSelect',{from:P0,to:P1})).range;
 const textBefore=start.text;
 await run('rangeDelete',{rident:start.rident});
 const undone=await run('undo');assert(undone.rangeSel,'undo returns the range that was selected');assert.equal(undone.rangeSel.text,textBefore);assert(undone.canRedo);
 const redone=await run('redo');assert.equal(redone.rangeSel,null);assert(redone.canUndo);
 await run('undo');
 assert.equal((await run('rangeSelect',{from:P0,to:P1})).range.text,textBefore);
 void m;
});
test('typing or pasting over a range replaces it with Unicode and multi-line text in one undo step',async()=>{
 await open('hwpx');const r=(await run('rangeSelect',{from:P0,to:P1})).range;
 const out=await run('rangeReplace',{rident:r.rident,text:'교체😀 한글\r\n둘째 줄\n셋째'});
 assert(out.selection.text.startsWith('셋째'));assert(out.dirty);
 const again=(await run('rangeSelect',{from:{page:0,x:116,y:135},to:{page:0,x:300,y:200}})).range;assert(again.text.includes('교체😀 한글'));assert(again.text.includes('둘째 줄'));
 await run('undo');assert.equal((await run('rangeSelect',{from:P0,to:P1})).range.text,r.text);
 const stale=await run('rangeReplace',{rident:'old',text:'x'});assert.equal(stale.stale,true);
 await assert.rejects(run('rangeReplace',{rident:r.rident,text:'￼'}));
 await run('export',{format:'hwpx'});
});
test('character and paragraph formatting apply to every paragraph in the range, undo together and survive export and reopen',async()=>{
 await open('hwpx');const r=(await run('rangeSelect',{from:P0,to:P1})).range;
 const initial=await run('rangeCharState',{rident:r.rident});assert.equal(initial.italic,'off');
 const done=await run('rangeChar',{rident:r.rident,props:{italic:true,textColor:'#c0392b'}});assert.equal(done.charState.italic,'on');assert(done.rangeSel.rects.length>=2);assert(done.dirty);
 await run('rangePara',{rident:r.rident,props:{alignment:'right',spacingAfter:4}});
 assert.equal((await run('rangeParaState',{rident:r.rident})).alignment,'right');
 await assert.rejects(run('rangeChar',{rident:r.rident,props:{ratios:Array(7).fill(999)}}));
 await assert.rejects(run('rangeChar',{rident:'old',props:{italic:false}}),/바뀌/);
 await assert.rejects(run('rangePara',{rident:r.rident,props:{alignment:'diagonal'}}));
 assert.equal((await run('rangeCharState',{rident:r.rident})).italic,'on','failed commands changed nothing');
 const ex=await run('export',{format:'hwpx'});
 await run('undo');assert.notEqual((await run('rangeParaState',{rident:r.rident})).alignment,'right');
 await run('undo');assert.equal((await run('rangeCharState',{rident:r.rident})).italic,'off');
 await run('redo');await run('redo');assert.equal((await run('rangeCharState',{rident:r.rident})).italic,'on');
 await run('saved',{bytes:ex.bytes});
 await run('open',{bytes:ex.bytes});const again=(await run('rangeSelect',{from:P0,to:P1})).range;
 assert.equal((await run('rangeCharState',{rident:again.rident})).italic,'on');assert.equal((await run('rangeParaState',{rident:again.rident})).alignment,'right');
});
test('operations on one paragraph are refused while a range is active and a click collapses it',async()=>{
 await open('hwpx');const r=(await run('rangeSelect',{from:P0,to:P1})).range;
 for(const [op,args] of [['change',{text:'x'}],['paste',{text:'x\ny',start:0,end:0}],['char',{start:0,end:1,props:{bold:true}}],['merge',{}],['copyText',{start:0,end:1}]])await assert.rejects(run(op,args),/여러 문단/);
 const same=await run('rangeSelect',{from:P0,to:P0});assert.equal(same.collapsed,true);assert.equal(typeof same.selection.text,'string');
 await assert.rejects(run('rangeDelete',{rident:r.rident}),/범위/);
 const again=(await run('rangeSelect',{from:P0,to:P1})).range;const c=await run('rangeCollapse',{toStart:false});assert(c.selection.text.length>0);
 await assert.rejects(run('rangeCopy',{rident:again.rident}));
 const all=(await run('rangeAll',{})).range;assert(all.paragraphs>=2);
 const k=await run('rangeCollapse',{toStart:true});assert.equal(k.selection.offset,0);
});
test('a range spanning a table is selectable and copyable but a delete never removes the table',async()=>{
 await run('open',{bytes:fs.readFileSync(new URL('fixtures/table.hwpx',import.meta.url))});
 // [앞] [paragraph that holds the table] [뒤]: the table sits in the middle of the range.
 let c=await run('navigate',{edge:'start'});await run('change',{ident:c.ident,text:'앞',offset:1});
 c=await run('navigate',{edge:'start'});c.offset=1;await run('split',{ident:c.ident,start:1,end:1});
 c=await run('navigate',{edge:'end'});await run('change',{ident:c.ident,text:'뒤',offset:1});
 const tableBefore=await run('select',{page:0,x:130,y:160}).then(h=>run('tableState',{ident:h.ident}));assert.equal(tableBefore.cells.length,4);
 c=await run('navigate',{edge:'start'});
 const all=(await run('rangeAll',{})).range;assert.equal(all.paragraphs,3);assert(all.text.startsWith('앞')&&all.text.endsWith('뒤'));
 await assert.rejects(run('rangeDelete',{rident:all.rident}),/개체/);
 await assert.rejects(run('rangeReplace',{rident:all.rident,text:'덮어쓰기'}),/개체/);
 const copy=await run('rangeCopy',{rident:all.rident});assert(copy.text.includes('앞')&&copy.text.includes('뒤'));assert(!copy.text.includes('￼'));
 // The refused commands rolled back completely: same table, same text, no extra undo step, document still exports.
 const after=await run('select',{page:0,x:130,y:160}).then(h=>run('tableState',{ident:h.ident}));assert.equal(after.cells.length,4);
 assert.equal((await run('navigate',{edge:'start'})).text,'앞');assert.equal((await run('navigate',{edge:'end'})).text,'뒤');
 await run('export',{format:'hwpx'});
});
test('inside one table cell a range of paragraphs can be deleted; crossing into the body is refused',async()=>{
 await run('open',{bytes:fs.readFileSync(new URL('fixtures/table.hwpx',import.meta.url))});
 let c=await run('select',{page:0,x:130,y:140});await run('paste',{ident:c.ident,start:0,end:0,text:'가\n나\n다'});
 const cell=(await run('rangeSelect',{from:{page:0,x:130,y:140},to:{page:0,x:150,y:185}})).range;
 assert(cell.paragraphs>=3);assert(cell.text.startsWith('가'));
 await assert.rejects(run('rangeSelect',{from:{page:0,x:130,y:140},to:{page:0,x:130,y:230}}),/같은 본문|표 칸/);
 const out=await run('rangeDelete',{rident:cell.rident});assert(out.selection.text.length>0);assert.equal((await run('tableState',{ident:out.selection.ident})).cells.length,4);
 await run('undo');assert.equal((await run('rangeSelect',{from:{page:0,x:130,y:140},to:{page:0,x:150,y:185}})).range.text,cell.text);
 await run('export',{format:'hwpx'});
});
test('copy keeps formatting through the engine clipboard; a plain paste still works without one',async()=>{
 let c=await open('hwpx');const rg={ident:c.ident,start:0,end:3};
 await run('char',{...rg,props:{bold:true,italic:true}});
 const copy=await run('copyText',rg);assert.equal(copy.text.length,3);
 c=await run('adjacent',{direction:1});const at=[...c.text].length;
 const out=await run('pasteClip',{ident:c.ident,start:c.text.length,end:c.text.length});assert(out.selection.text.length>c.text.length);
 const pasted=(await run('charState',{ident:out.selection.ident,start:c.text.length,end:c.text.length+3}));assert.equal(pasted.bold,'on');assert.equal(pasted.italic,'on');void at;
 await run('undo');assert.equal((await run('select',{page:0,x:200,y:160})).text,c.text);
 await run('open',{bytes:fs.readFileSync(new URL('fixtures/문서.hwpx',import.meta.url))});c=await select();
 await assert.rejects(run('pasteClip',{ident:c.ident,start:0,end:0}),/복사본/);
});
test('spreadsheet text fills table cells from the selected cell, refuses overflow and undoes',async()=>{
 await run('open',{bytes:fs.readFileSync(new URL('fixtures/table.hwpx',import.meta.url))});
 const first=()=>run('select',{page:0,x:130,y:140});
 let c=await first();const t=await run('tableState',{ident:c.ident}),origin=t.cells[0];
 await assert.rejects(run('tableGrid',{ident:c.ident,text:'1\t2\t3'}),/표 밖/);
 await assert.rejects(run('tableGrid',{ident:c.ident,text:'한 칸'}),/여러 칸/);
 const r=await run('tableGrid',{ident:c.ident,text:'가\t나\r\n다\t라😀\n'});assert.equal(r.cells,4);assert(r.dirty);
 const texts=[];for(const cell of t.cells){const hit=await run('select',{page:cell.pageIndex,x:cell.x+5,y:cell.y+5});texts.push(hit.text);}
 assert.deepEqual(texts,['가','나','다','라😀']);
 await run('undo');assert.equal((await run('select',{page:origin.pageIndex,x:origin.x+5,y:origin.y+5})).text,'표 셀 시험');
 // A multi-paragraph destination cell is never overwritten.
 c=await first();await run('paste',{ident:c.ident,start:0,end:0,text:'a\nb'});
 c=await first();await assert.rejects(run('tableGrid',{ident:c.ident,text:'x\ty'}),/여러 개/);
 assert((await first()).text.length>0);
});
test('a recovery draft exports the live edit without disturbing the save baseline',async()=>{
 const c=await open('hwpx');await run('change',{ident:c.ident,text:c.text+' 복구 대상'});
 const draft=await run('draft',{format:'hwpx'});assert(draft.bytes.length>1000);assert.equal(draft.lossy,false);
 const {HwpDocument}=await import('../app/src/main/assets/engine/rhwp.js');const reopened=new HwpDocument(new Uint8Array(draft.bytes));
 assert(JSON.parse(reopened.getTextFileUnicode()).join?.('')?.includes('복구 대상')||reopened.getTextFileUnicode().includes('복구 대상'));reopened.free();
 await assert.rejects(run('saved',{bytes:draft.bytes}),/먼저 내보내/);
 const ex=await run('export',{format:'hwpx'});await run('draft',{format:'hwpx'});
 assert.equal((await run('saved',{bytes:ex.bytes})).dirty,false);
});
test('encrypted documents open only with the right password, stay encrypted in drafts and can be rendered for PDF export',async()=>{
 await open('hwpx');const {HwpDocument}=await import('../app/src/main/assets/engine/rhwp.js');
 const plain=new HwpDocument(new Uint8Array(fs.readFileSync(new URL('fixtures/문서.hwpx',import.meta.url))));const locked=plain.exportHwpxWithPassword('비밀번호-1');plain.free();
 await assert.rejects(run('open',{bytes:locked}),/PASSWORD_REQUIRED/);
 await assert.rejects(run('open',{bytes:locked,password:'틀림'}),/PASSWORD_WRONG/);
 const meta=await run('open',{bytes:locked,password:'비밀번호-1'});assert.equal(meta.encrypted,true);
 const page=await run('page',{index:0});assert(page.svg.includes('<svg'));
 const c=await select();await run('change',{ident:c.ident,text:c.text+'!'});
 const draft=await run('draft',{format:'hwpx'});
 await assert.rejects(run('open',{bytes:draft.bytes}),/PASSWORD_REQUIRED/);
 await run('open',{bytes:draft.bytes,password:'비밀번호-1'});assert.equal((await select()).text,c.text+'!');
});

for(const format of ['hwp','hwpx'])test(`${format}: a range holding a memo can be deleted, reports the memo and undo brings it back; formats survive export`,async()=>{
 let c=await open(format);await run('memoAdd',{ident:c.ident,start:1,end:4,author:'a',text:'범위 안의 메모'});
 const r=(await run('rangeSelect',{from:P0,to:P1})).range;
 const out=await run('rangeDelete',{rident:r.rident});assert.equal(out.memosRemoved,1);assert.equal((await run('memos')).length,0);
 await run('undo');assert.equal((await run('memos')).length,1);assert.equal((await run('memos'))[0].text,'범위 안의 메모');
 const again=(await run('rangeSelect',{from:P0,to:P1})).range;
 await run('rangeChar',{rident:again.rident,props:{italic:true}});await run('rangePara',{rident:again.rident,props:{alignment:'center'}});
 const ex=await run('export',{format});await run('saved',{bytes:ex.bytes});await run('open',{bytes:ex.bytes});
 const reopened=(await run('rangeSelect',{from:P0,to:P1})).range;
 assert.equal((await run('rangeCharState',{rident:reopened.rident})).italic,'on');assert.equal((await run('rangeParaState',{rident:reopened.rident})).alignment,'center');assert.equal((await run('memos')).length,1);
});

// ---- review-fix regressions (Opus/high review of 5986d59) ----
// F10: forward Delete at the very end of a section must not reach into the next section.
test('F10: forward Delete at the end of a section is a no-op and never merges into the next section',async()=>{
 await run('open',{bytes:fs.readFileSync(new URL('fixtures/two-sections.hwpx',import.meta.url))});
 const textBefore=(await run('select',{page:1,x:120,y:135})).text;
 const last=await run('select',{page:0,x:200,y:160});assert.equal(last.start.pageIndex,0);
 const r=await run('mergeNext',{ident:last.ident,start:last.text.length,end:last.text.length});
 assert.equal(r.dirty,false,'a refused cross-section merge does not make the document dirty');
 assert.equal(r.selection.text,last.text,'selection stays on the same paragraph');
 assert.equal((await run('select',{page:1,x:120,y:135})).text,textBefore,'the first paragraph of the next section is untouched');
 await run('close');
});

// H2: verifyFormats compares all PARA_KEYS of every touched paragraph after the writer round trip. Does that ever refuse a legitimate save?
for(const format of ['hwp','hwpx'])test(`H2 ${format}: paragraph formatting (align, spacing, list, line spacing, paste-format) exports and reopens`,async()=>{
 let c=await open(format);
 for(const props of [{alignment:'center'},{alignment:'justify'},{spacingBefore:10,spacingAfter:6},{list:'bullet'},{list:'none'},{lineSpacing:160}]){
  await run('para',{ident:c.ident,props});const ex=await run('export',{format});assert((await run('saved',{bytes:ex.bytes})).dirty===false,JSON.stringify(props));
 }
 const rg={ident:c.ident,start:0,end:3};await run('para',{ident:c.ident,props:{alignment:'right',spacingAfter:4}});
 await run('copyFormat',{...rg,scope:'para'});await run('para',{ident:c.ident,props:{alignment:'left',spacingAfter:0}});await run('pasteFormat',rg);
 const ex=await run('export',{format});await run('saved',{bytes:ex.bytes});
 await run('open',{bytes:Buffer.from(ex.bytes)});c=await select();const st=await run('paraState',{ident:c.ident});assert.equal(st.alignment,'right');assert.equal(st.spacingAfter,4);
 // a second paragraph, formatted as a range, with the same round trip
 await run('close');
});

// H3: memo offsets must count the same characters as the editor text (one per code point), also after an emoji and after a save.
for(const format of ['hwp','hwpx'])test(`H3 ${format}: a memo after astral characters anchors the right text, survives export/reopen and memoSelect maps back to UTF-16`,async()=>{
 let c=await open(format);const text='😀😀가나다라 탭\t뒤 끝';
 await run('change',{text,offset:0,ident:c.ident});c=await select();assert.equal(c.text,text);
 // UTF-16 index 4..6 = "가나" (each emoji is two UTF-16 units)
 let r=await run('memoAdd',{ident:c.ident,start:4,end:6,author:'a',text:'이모지 뒤 메모'});
 let m=(await run('memos'))[0];assert.equal(m.anchor,'가나');assert(m.rects.length>=1);
 const ex=await run('export',{format});await run('saved',{bytes:ex.bytes});await run('open',{bytes:Buffer.from(ex.bytes)});
 m=(await run('memos'))[0];assert.equal(m.anchor,'가나',`anchor after ${format} round trip`);
 const sel=await run('memoSelect',{id:m.id});assert.equal(sel.range.start,4);assert.equal(sel.range.end,6);assert.equal(sel.selection.text.slice(sel.range.start,sel.range.end),'가나');
 // a memo on the tab-containing tail still anchors correctly
 r=await run('memoAdd',{ident:sel.selection.ident,start:9,end:12,author:'a',text:'탭 뒤'});
 const all=await run('memos');assert.equal(all.length,2);assert.equal(all.find(x=>x.text==='탭 뒤').anchor,[...text].slice(7,10).join(''));
 await run('close');
});

// H6: memos in encrypted documents go through the password export path and are still there after reopening with the password.
for(const format of ['hwp','hwpx'])test(`H6 ${format}: an encrypted document keeps an added memo and its anchor through a password save`,async()=>{
 await open(format);const {HwpDocument}=await import('../app/src/main/assets/engine/rhwp.js');
 const plain=new HwpDocument(new Uint8Array(fs.readFileSync(new URL('fixtures/문서.'+format,import.meta.url))));
 const locked=format==='hwp'?plain.exportHwpWithPassword('메모-암호'):plain.exportHwpxWithPassword('메모-암호');plain.free();
 await run('open',{bytes:locked,password:'메모-암호'});let c=await select();
 await run('memoAdd',{ident:c.ident,start:1,end:4,author:'암호작성자',text:'암호 문서 메모'});
 const ex=await run('export',{format});await run('saved',{bytes:ex.bytes});
 await assert.rejects(run('open',{bytes:ex.bytes}),/PASSWORD_REQUIRED/);
 const meta=await run('open',{bytes:ex.bytes,password:'메모-암호'});assert.equal(meta.encrypted,true);
 const m=await run('memos');assert.equal(m.length,1);assert.equal(m[0].text,'암호 문서 메모');assert.equal(m[0].author,'암호작성자');assert.equal(m[0].anchor,[...c.text].slice(1,4).join(''));
 await run('close');
});

// F17: the page skips the memo refresh in documents without memos; the engine reports the count with every reply.
test('F17: every reply carries memoCount so a memo-free document is not re-measured while typing',async()=>{
 let c=await open('hwpx');assert.equal((await run('change',{ident:c.ident,text:c.text+'가',offset:0})).memoCount,0);
 assert.equal((await run('memoAdd',{ident:c.ident,start:0,end:2,author:'a',text:'x'})).memoCount,1);
 assert.equal((await run('undo')).memoCount,0);assert.equal((await run('redo')).memoCount,1);
 await run('close');
});

// F17: the memo list can be fetched in pages (rectangles cost ~5 ms per memo) with exactly the same content as the full list.
test('F17: memos are paged without changing their content, order or rectangles',async()=>{
 let c=await open('hwpx');const text='가나다라마바사아자차카타파하'.repeat(8);await run('change',{ident:c.ident,text,offset:0});c=await select();
 for(let i=0;i<30;i++)await run('memoAdd',{ident:c.ident,start:i*3,end:i*3+2,author:'a',text:'메모 '+i});
 const full=await run('memos');assert.equal(full.length,30);assert(full.every(m=>m.rects.length>=1&&m.anchor.length===2));
 const paged=[];let from=0,pages=0;for(;;){const part=await run('memos',{from,limit:12});pages++;assert.equal(part.total,30);paged.push(...part.items);if(part.done)break;from+=12;}
 assert.equal(pages,3);assert.deepEqual(paged,full);
 assert.deepEqual((await run('memos',{from:28,limit:12})).items.map(m=>m.text),['메모 28','메모 29']);assert.equal((await run('memos',{from:100,limit:5})).done,true);
 await run('close');
});

// ---- regressions for the second Opus/high review (F-A, F-B) ----
const readFixture=name=>fs.readFileSync(new URL('fixtures/'+name,import.meta.url));
// [앞][paragraph that holds the table][뒤], with the whole body selected.
async function frontTableBack(format='hwpx'){
 await run('open',{bytes:readFixture('table.'+format)});
 let c=await run('navigate',{edge:'start'});await run('change',{ident:c.ident,text:'앞',offset:1});
 c=await run('navigate',{edge:'start'});c.offset=1;await run('split',{ident:c.ident,start:1,end:1});
 c=await run('navigate',{edge:'end'});await run('change',{ident:c.ident,text:'뒤',offset:1});
 c=await run('navigate',{edge:'start'});
 return c;
}
const tableCells=async()=>{const h=await run('select',{page:0,x:130,y:160});return (await run('tableState',{ident:h.ident})).cells;};
// Any reply that carries meta while a range is active (a stale range edit is a harmless no-op).
const metaNow=async()=>{const m=await run('rangeReplace',{rident:'stale',text:'x'});assert.equal(m.stale,true);const {canUndo,canRedo,dirty,count,memoCount}=m;return {canUndo,canRedo,dirty,count,memoCount};};
for(const format of ['hwpx','hwp'])test(`F-A ${format}: replacing a range that spans a table with the internal clipboard is refused like a plain replace, and nothing is lost`,async()=>{
 let c=await frontTableBack(format);
 const cellsBefore=await tableCells();assert.equal(cellsBefore.length,4);
 c=await run('navigate',{edge:'start'});await run('copyText',{ident:c.ident,start:0,end:1});   // the engine clipboard now holds "앞"
 const all=(await run('rangeAll',{})).range;assert.equal(all.paragraphs,3);
 const before=await metaNow();
 await assert.rejects(run('rangeReplace',{rident:all.rident,text:'앞'}),/개체/,'plain text over the table is refused');
 await assert.rejects(run('rangeReplace',{rident:all.rident,internal:true}),/개체/,'the clipboard replace is refused too');
 await assert.rejects(run('rangeDelete',{rident:all.rident}),/개체/);
 // The refusals rolled back everything: same document, same undo state, the range is still selected, the clipboard still works.
 assert.deepEqual(await metaNow(),before,'no undo step, no dirty change, no page change');
 assert.equal((await run('rangeCopy',{rident:all.rident})).text.includes('앞'),true,'the range selection survived');
 assert.equal((await tableCells()).length,4,'the table is still there');
 const ex=await run('export',{format});await run('saved',{bytes:ex.bytes});await run('open',{bytes:ex.bytes});
 assert.equal((await tableCells()).length,4,'the table is in the saved file after reopening it');
 const first=await run('navigate',{edge:'start'});assert.equal(first.text,'앞');assert.equal((await run('navigate',{edge:'end'})).text,'뒤');
});
test('F-A: a clipboard that carries the table itself cannot make up for the table the delete removed',async()=>{
 await frontTableBack('hwpx');
 const all=(await run('rangeAll',{})).range;await run('rangeCopy',{rident:all.rident});          // clipboard = 앞 + table + 뒤 (as far as the engine copies it)
 const before=await metaNow();
 await assert.rejects(run('rangeReplace',{rident:all.rident,internal:true}),/개체/,'delete removes the table, the pasted copy must not hide that');
 assert.deepEqual(await metaNow(),before);assert.equal((await tableCells()).length,4);
 const ex=await run('export',{format:'hwpx'});await run('saved',{bytes:ex.bytes});await run('open',{bytes:ex.bytes});assert.equal((await tableCells()).length,4);
});
for(const format of ['hwp','hwpx'])test(`F-A ${format}: ordinary formatted replacement keeps its formatting, undoes, and survives export and reopen`,async()=>{
 let c=await open(format);const rg={ident:c.ident,start:0,end:3};
 await run('char',{...rg,props:{bold:true,italic:true}});const copied=(await run('copyText',rg)).text;assert.equal(copied.length,3);
 const r=(await run('rangeSelect',{from:P0,to:P1})).range;
 const out=await run('rangeReplace',{rident:r.rident,internal:true});
 assert.equal(out.memosRemoved,0);assert(out.selection.text.startsWith(copied),out.selection.text);assert(out.dirty);
 const st=await run('charState',{ident:out.selection.ident,start:0,end:3});assert.equal(st.bold,'on');assert.equal(st.italic,'on');
 const ex=await run('export',{format});await run('saved',{bytes:ex.bytes});await run('open',{bytes:ex.bytes});
 const again=await select();assert(again.text.startsWith(copied));const st2=await run('charState',{ident:again.ident,start:0,end:3});assert.equal(st2.bold,'on');assert.equal(st2.italic,'on');
 await run('open',{bytes:readFixture('문서.'+format)});c=await select();const original=c.text;
 await run('char',{ident:c.ident,start:0,end:3,props:{bold:true}});await run('copyText',{ident:c.ident,start:0,end:3});
 const r2=(await run('rangeSelect',{from:P0,to:P1})).range;await run('rangeReplace',{rident:r2.rident,internal:true});
 await run('undo');await run('undo');assert.equal((await select()).text,original,'undo returns the replaced paragraphs');
});

// F-B: a whole-anchor edit inside a table cell removes the memo (the core's rule, as in Hancom and the PC editor); every command that can
// do it now says so, counting what each stage removed. Body text keeps its memo through replaceText.
const cellWithMemo=async(extra={})=>{
 await run('open',{bytes:readFixture('table.hwpx')});
 let c=await run('select',{page:0,x:130,y:140});assert.equal(c.text,'표 셀 시험');
 await run('copyText',{ident:c.ident,start:0,end:2});     // a clipboard without memos, taken before the memo exists
 await run('memoAdd',{ident:c.ident,start:0,end:c.text.length,author:'셀 작성자',text:'셀 메모',...extra});assert.equal((await run('memos')).length,1);
 return c;
};
test('F-B: replacing the whole anchor in a table cell reports the removed memo, undo brings memo and text back, and the file saves',async()=>{
 let c=await cellWithMemo();
 const r=await run('change',{ident:c.ident,text:'바꾼 글',offset:4});
 assert.equal(r.memosRemoved,1);assert.equal(r.memoCount,0);assert.equal((await run('memos')).length,0);
 const ex=await run('export',{format:'hwpx'});await run('saved',{bytes:ex.bytes});await run('open',{bytes:ex.bytes});assert.equal((await run('memos')).length,0,'the removal is what the file holds');
 await run('open',{bytes:readFixture('table.hwpx')});c=await run('select',{page:0,x:130,y:140});await run('memoAdd',{ident:c.ident,start:0,end:c.text.length,author:'셀 작성자',text:'셀 메모'});
 c=await run('select',{page:0,x:130,y:140});await run('change',{ident:c.ident,text:'바꾼 글',offset:4});
 const u=await run('undo');assert.equal(u.memoCount,1);const m=await run('memos');assert.equal(m.length,1);assert.equal(m[0].text,'셀 메모');assert.equal(m[0].author,'셀 작성자');
 assert.equal((await run('select',{page:0,x:130,y:140})).text,'표 셀 시험');
 const saved=await run('export',{format:'hwpx'});assert(saved.bytes.length>1000,'with the memo restored the document still exports and re-verifies');
});
test('F-B: the memo notice reaches paste, split, pasteClip and tableGrid, and a body edit keeps the memo',async()=>{
 let c=await cellWithMemo();
 let r=await run('paste',{ident:c.ident,start:0,end:c.text.length,text:'가\n나'});assert.equal(r.memosRemoved,1);assert.equal((await run('memos')).length,0);
 await run('undo');assert.equal((await run('memos')).length,1);
 // split at a caret inside the anchor is not a deletion: whatever the engine does, the count the reply names is the count that went
 c=await run('select',{page:0,x:130,y:140});const memosBefore=(await run('memos')).length;
 r=await run('split',{ident:c.ident,start:2,end:2});assert.equal(r.memosRemoved,memosBefore-(await run('memos')).length);await run('undo');
 // internal clipboard paste over the whole anchor (the clipboard was copied before the memo existed)
 c=await run('select',{page:0,x:130,y:140});r=await run('pasteClip',{ident:c.ident,start:0,end:c.text.length});assert.equal(r.memosRemoved,1);assert.equal((await run('memos')).length,0);
 await run('undo');assert.equal((await run('memos')).length,1);
 // spreadsheet paste over the cell
 c=await run('select',{page:0,x:130,y:140});r=await run('tableGrid',{ident:c.ident,text:'가\t나\n다\t라'});assert.equal(r.cells,4);assert.equal(r.memosRemoved,1);assert.equal((await run('memos')).length,0);
 await run('undo');assert.equal((await run('memos')).length,1);
 // The same replacement in body text keeps the memo (memo-aware replaceText); nothing is removed and nothing is announced.
 await open('hwpx');c=await select();await run('memoAdd',{ident:c.ident,start:0,end:c.text.length,author:'본문',text:'본문 메모'});
 c=await select();r=await run('change',{ident:c.ident,text:'본문을 바꿨어요',offset:3});assert.equal(r.memosRemoved,0);assert.equal((await run('memos')).length,1);
 r=await run('paste',{ident:(await select()).ident,start:0,end:2,text:'가나다'});assert.equal(r.memosRemoved,0);
});
test('F-B: memos removed by the delete stage are counted even when the pasted clipboard brings memos of its own',async()=>{
 let c=await open('hwpx');await run('memoAdd',{ident:c.ident,start:0,end:3,author:'a',text:'복사할 메모'});
 c=await select();await run('copyText',{ident:c.ident,start:0,end:3});               // clipboard: the three characters with their memo
 const r=(await run('rangeSelect',{from:P0,to:P1})).range;const out=await run('rangeReplace',{rident:r.rident,internal:true});
 assert.equal(out.memosRemoved,1,'the memo of the replaced paragraph is reported as removed');
 assert.equal(out.memoCount,(await run('memos')).length);
 await run('undo');assert.equal((await run('memos')).length,1);assert.equal((await run('memos'))[0].text,'복사할 메모');
});

// ---- re-review N-notes: a refused command must not cost the oldest undo step (history is trimmed only after a command succeeds) ----
async function undoDepth(){let n=0,m;do{m=await run('undo');n++;}while(m.canUndo&&n<200);return n;}
test('history at its cap of 40: refused table-range commands keep every undo step; a successful command still trims to 40',async()=>{
 await run('open',{bytes:readFixture('table.hwpx')});
 let c=await run('navigate',{edge:'start'});await run('change',{ident:c.ident,text:'앞',offset:1});                                   // step 1
 c=await run('navigate',{edge:'start'});c.offset=1;await run('split',{ident:c.ident,start:1,end:1});                                    // step 2
 c=await run('navigate',{edge:'end'});await run('change',{ident:c.ident,text:'뒤',offset:1});                                          // step 3
 c=await run('navigate',{edge:'start'});
 for(let i=0;i<37;i++)await run('char',{ident:c.ident,start:0,end:1,props:{bold:i%2===0}});                                          // steps 4..40
 const all=(await run('rangeAll',{})).range;assert.equal(all.paragraphs,3);
 await assert.rejects(run('rangeReplace',{rident:all.rident,text:'덮어쓰기'}),/개체/);
 await assert.rejects(run('rangeDelete',{rident:all.rident}),/개체/);
 await assert.rejects(run('rangeReplace',{rident:all.rident,internal:true}),/복사본|개체/);
 assert.equal(await undoDepth(),40,'three refusals at the cap left all 40 undo steps in place');
 // Start over at the cap, then one successful command: the oldest step goes (40 steps remain), as before.
 await run('open',{bytes:readFixture('문서.hwpx')});c=await select();
 for(let i=0;i<41;i++)await run('char',{ident:c.ident,start:0,end:2,props:{bold:i%2===0}});
 assert.equal(await undoDepth(),40,'a successful command at the cap trims the oldest step');
});
