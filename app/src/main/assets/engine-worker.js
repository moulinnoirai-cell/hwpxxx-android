import {CHAR_KEYS,COPY_CHAR_KEYS,CELL_ATTR_KEYS,PARA_KEYS,spacingToRaw,spacingToPt,paragraphForWrite,memoTarget,expandCellRange} from './editor-features.mjs';
import init,{HwpDocument} from './engine/rhwp.js';
let doc=null,selected=null,savedBytes=null,savedText='',history=[],future=[];
// Dirty tracking: every successful edit gets a new revision; snapshots carry the revision they restore.
// fmt marks states whose formatting may differ from the last save (text comparison cannot see it).
let rev=0,revSeq=0,savedRev=0,fmt=false,fmtTargets=[];
// Password of an encrypted document: worker memory only, used to reopen/verify and to keep the file encrypted on save.
let password=null,painter=null;
let exported=null;
const openBytes=b=>{const d=password!=null?HwpDocument.openWithPassword(b,password):new HwpDocument(b);return d;};
// rhwp 0.8.7 draws some HWP pictures at their original size and ignores the object's current size
// (2008 수능 정답: 567px picture drawn 1771px wide, cut off by the page). Re-applying the size fixes the layout.
function fixPictureSizes(){let ctrls;try{ctrls=JSON.parse(doc.getControls());}catch{return;}
 const want=new Map();for(const c of ctrls)if(c.ctrlId==='gso'&&c.props?.Width>0&&c.props?.Height>0)want.set(`${c.list},${c.para},${c.controlIndex}`,c.props);if(!want.size)return;
 const n=Math.min(doc.pageCount(),500),bad=new Map();for(let i=0;i<n;i++){let l;try{l=JSON.parse(doc.getPageControlLayout(i));}catch{continue;}
  for(const c of l.controls||[]){if(c.type!=='image'||!c.stableIndex)continue;const k=c.stableIndex.join(','),w=want.get(k);if(w&&(Math.abs(c.w-w.Width/75)>2||Math.abs(c.h-w.Height/75)>2))bad.set(k,w);}}
 for(const [k,w] of bad){const [s,pa,ci]=k.split(',').map(Number);try{doc.setPictureProperties(s,pa,ci,JSON.stringify({width:w.Width+1,height:w.Height+1}));doc.setPictureProperties(s,pa,ci,JSON.stringify({width:w.Width,height:w.Height}));}catch{}}}

const OBJ='￼'; // object placeholder: deleting it from a text diff would delete a table/picture/control
const canvas=typeof OffscreenCanvas==='function'?new OffscreenCanvas(8,8):null;
globalThis.measureTextWidth=(font,text)=>{if(canvas){const c=canvas.getContext('2d');c.font=font;return c.measureText(text).width;}return [...text].length*7;};
const ready=init({module_or_path:'/engine/rhwp_bg.wasm'});
const checked=s=>{const r=typeof s==='string'?JSON.parse(s):s;if(r?.ok===false||r?.error)throw new Error(r.message||r.error||'편집할 수 없는 위치예요.');return r;};
const text=()=>JSON.parse(doc.getTextFileUnicode());
// The whole-text dirty comparison runs once per revision, and page sizes are sent only when the page count
// changed or a full refresh is asked for (open/cancel/undo/redo); the UI keeps its previous sizes otherwise.
let dirtyRev=-1,dirtyVal=false,sentCount=-1;
function meta(full=false){const count=doc.pageCount();if(count<1||count>500)throw new Error('이 문서는 500페이지 한도를 넘었어요.');
 if(rev!==dirtyRev){dirtyVal=rev!==savedRev&&(fmt||text()!==savedText);dirtyRev=rev;}
 const m={count,dirty:dirtyVal,canUndo:history.length>0,canRedo:future.length>0,memoSupported:typeof doc.getMemoList==='function'};
 if(full||count!==sentCount){m.sizes=Array.from({length:count},(_,i)=>JSON.parse(doc.getPageInfo(i)));sentCount=count;}return m;}
function normalHit(h){if(h.cellPath?.length)return {sec:h.sectionIndex,para:h.parentParaIndex,path:JSON.stringify(h.cellPath),p:h.cellParaIndex||0,offset:h.charOffset};if(h.parentParaIndex!=null&&h.cellIndex!=null)return {sec:h.sectionIndex,para:h.parentParaIndex,ctrl:h.controlIndex,cell:h.cellIndex,p:h.cellParaIndex||0,offset:h.charOffset};return {sec:h.sectionIndex,para:h.paragraphIndex,offset:h.charOffset};}
function inCell(c){return c.path!=null||c.cell!=null;}
function len(c){return c.path!=null?doc.getCellParagraphLengthByPath(c.sec,c.para,c.path):inCell(c)?doc.getCellParagraphLength(c.sec,c.para,c.ctrl,c.cell,c.p):doc.getParagraphLength(c.sec,c.para);}
function range(c){return c.path!=null?doc.getTextInCellByPath(c.sec,c.para,c.path,0,100000):inCell(c)?doc.getTextInCell(c.sec,c.para,c.ctrl,c.cell,c.p,0,100000):doc.getTextRange(c.sec,c.para,0,100000);}
function rect(c,offset){return JSON.parse(c.path!=null?doc.getCursorRectByPath(c.sec,c.para,c.path,offset):inCell(c)?doc.getCursorRectInCell(c.sec,c.para,c.ctrl,c.cell,c.p,offset):doc.getCursorRect(c.sec,c.para,offset));}
function ident(c){return c?JSON.stringify([c.sec,c.para,c.ctrl??null,c.cell??null,c.p??null,c.path??null]):null;}
function selection(){if(!selected)return null;return {text:range(selected),offset:selected.offset,start:rect(selected,0),end:rect(selected,len(selected)),key:JSON.stringify(selected),ident:ident(selected)};}
function replace(c,start,n,s){if(c.path!=null){if(n)checked(doc.deleteTextInCellByPath(c.sec,c.para,c.path,start,n));if(s)checked(doc.insertTextInCellByPath(c.sec,c.para,c.path,start,s));return;}// The *DeferredPagination cell replace only accepts 1-8 characters without line breaks/tabs (IME use), so plain cells use delete+insert.
if(inCell(c)){if(n)checked(doc.deleteTextInCell(c.sec,c.para,c.ctrl,c.cell,c.p,start,n));if(s)checked(doc.insertTextInCell(c.sec,c.para,c.ctrl,c.cell,c.p,start,s));return;}return checked(doc.replaceText(c.sec,c.para,start,n,s));}
function relocate(c,result){if(inCell(c)){c.p=result.cellParaIndex??c.p;if(c.path){const path=JSON.parse(c.path);path.at(-1).cellParaIndex=c.p;c.path=JSON.stringify(path);}}else c.para=result.paraIdx??c.para;c.offset=result.charOffset??0;}
function split(c,off){const r=checked(c.path?doc.splitParagraphInCellByPath(c.sec,c.para,c.path,off):inCell(c)?doc.splitParagraphInCell(c.sec,c.para,c.ctrl,c.cell,c.p,off):doc.splitParagraph(c.sec,c.para,off));relocate(c,r);}
// range: the editor's UTF-16 selection the command acted on, handed back on undo/redo so the selection is restored.
// The redo list is dropped only when a command succeeds (mark), so a refused or failed command keeps it.
function takeSnapshot(range=null){const limit=Math.min(40,Math.max(1,doc.snapshotCapacity()-2-future.length));while(history.length>=limit){const x=history.shift();doc.discardSnapshot(x.id);}history.push({id:doc.saveSnapshot(),selected:selected?{...selected}:null,rev,fmt,range});}
const editorRange=a=>Number.isInteger(a?.start)&&Number.isInteger(a?.end)?{start:a.start,end:a.end}:null;
function rollback(){const s=history.pop();try{checked(doc.restoreSnapshot(s.id));selected=s.selected;rev=s.rev;fmt=s.fmt;dirtyRev=-1;}finally{doc.discardSnapshot(s.id);}}
function mark(format){rev=++revSeq;if(format)fmt=true;for(const x of future)doc.discardSnapshot(x.id);future=[];}
function fresh(){selected=null;history=[];future=[];fmtTargets=[];typing=null;painter=null;exported=null;rev=savedRev=++revSeq;fmt=false;dirtyRev=-1;sentCount=-1;}
// Consecutive typing in one paragraph is one undo step (gaps under 1.5s, at most 8s per step).
let typing=null;
// ---- character / paragraph formatting (body, single cell, nested cell path) ----
const COLOR=/^#[0-9a-fA-F]{6}$/,ALIGN=['left','center','right','justify'];
function charAt(d,c,o){return JSON.parse(c.path!=null?d.getCellCharPropertiesAtByPath(c.sec,c.para,c.path,o):inCell(c)?d.getCellCharPropertiesAt(c.sec,c.para,c.ctrl,c.cell,c.p,o):d.getCharPropertiesAt(c.sec,c.para,o));}
function applyChar(c,s,e,json){return checked(c.path!=null?doc.applyCharFormatInCellByPath(c.sec,c.para,c.path,s,e,json):inCell(c)?doc.applyCharFormatInCell(c.sec,c.para,c.ctrl,c.cell,c.p,s,e,json):doc.applyCharFormat(c.sec,c.para,s,e,json));}
// 0.8.7 has no paragraph-format API for nested cell paths; a one-level path is the plain cell API.
function paraRef(c){if(c.path==null)return c;const p=JSON.parse(c.path);return p.length===1?{sec:c.sec,para:c.para,ctrl:p[0].controlIndex,cell:p[0].cellIndex,p:p[0].cellParaIndex??c.p}:null;}
function paraGet(d,r){return JSON.parse(r.cell!=null?d.getCellParaPropertiesAt(r.sec,r.para,r.ctrl,r.cell,r.p):d.getParaPropertiesAt(r.sec,r.para));}
function paraSet(r,json){return checked(r.cell!=null?doc.applyParaFormatInCell(r.sec,r.para,r.ctrl,r.cell,r.p,json):doc.applyParaFormat(r.sec,r.para,json));}
function charProps(p){const o={};for(const [k,v] of Object.entries(p||{})){
 if((k==='bold'||k==='italic'||k==='underline')&&typeof v==='boolean')o[k]=v;
 else if((k==='spacings'||k==='ratios')&&Array.isArray(v)&&v.length===7&&v.every(n=>Number.isInteger(n)&&n>=(k==='spacings'?-50:50)&&n<=(k==='spacings'?50:200)))o[k]=v;
 else if(k==='fontSize'&&Number.isInteger(v)&&v>=100&&v<=9600)o[k]=v;
 else if((k==='textColor'||k==='shadeColor')&&COLOR.test(v))o[k]=v.toLowerCase();
 else throw new Error('지원하지 않는 글자 서식이에요.');}
 if(!Object.keys(o).length)throw new Error('바꿀 서식이 없어요.');return o;}
const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
// UTF-16 positions from the textarea -> rhwp scalar offsets within the selected paragraph.
function span(a){const t=range(selected),n=[...t].length;let s=[...t.slice(0,a.start||0)].length,e=[...t.slice(0,a.end??a.start??0)].length;if(s>e)[s,e]=[e,s];return {s:Math.min(s,n),e:Math.min(e,n),n};}
function charState(c,s,e,n){const at=[];if(e>s){const step=Math.max(1,Math.ceil((e-s)/64));for(let o=s;o<e;o+=step)at.push(o);if(at.at(-1)!==e-1)at.push(e-1);}else at.push(Math.max(0,Math.min(s,n)-1));
 const p=at.map(o=>charAt(doc,c,o)),tri=k=>p.every(x=>x[k])?'on':p.some(x=>x[k])?'mixed':'off',one=k=>p.every(x=>same(x[k],p[0][k]))?p[0][k]:null;
 return {range:e>s,...Object.fromEntries(CHAR_KEYS.map(k=>[k,['bold','italic','underline'].includes(k)?tri(k):one(k)]))};}
function paraState(c){const r=paraRef(c);if(!r)return {supported:false};const p=paraGet(doc,r);return {supported:true,alignment:p.alignment,lineSpacing:p.lineSpacing,lineSpacingType:p.lineSpacingType,spacingBefore:spacingToPt(p.spacingBefore||0),spacingAfter:spacingToPt(p.spacingAfter||0),list:p.headType==='Bullet'?'bullet':p.headType==='None'?'none':'other'};}
// getSelectionRects starts the first line at the line origin (bullet/number area included); trim it to the caret at s.
function rects(c,s,e){const r=rawRects(c,s,e);if(r.length){try{const a=rect(c,s),f=r[0];if(a.pageIndex===f.pageIndex&&a.x>f.x&&a.x<f.x+f.width&&Math.abs(a.y-f.y)<f.height){f.width-=a.x-f.x;f.x=a.x;}}catch{}}return r;}
function rawRects(c,s,e){if(e<=s)return [];return JSON.parse(c.path!=null?doc.getSelectionRectsInCellByPath(c.sec,c.para,c.path,c.p,s,c.p,e):inCell(c)?doc.getSelectionRectsInCell(c.sec,c.para,c.ctrl,c.cell,c.p,s,c.p,e):doc.getSelectionRects(c.sec,c.para,s,c.para,e));}
function sameTarget(a){if(!selected)throw new Error('편집할 문장을 눌러 주세요.');if(a.ident!==ident(selected))throw new Error('선택한 문단이 바뀌었어요. 글자를 다시 선택해 주세요.');}
// After export, the reopened bytes must carry the formatting the editor applied (not just the same text).
// A target that later edits made invalid in the live document is skipped; any failure reading the saved copy is fatal.
const points=(s,e)=>[...new Set([s,Math.floor((s+e-1)/2),e-1])];
function verifyFormats(v){const lost=new Error('저장한 문서에서 서식을 다시 확인하지 못했어요. 원본은 변경하지 않았어요.');for(const t of fmtTargets){
 if(t.kind==='char'){for(const o of points(t.s,t.e)){let x;try{x=charAt(doc,t.c,o);}catch{break;}let y;try{y=charAt(v,t.c,o);}catch{throw lost;}for(const k of CHAR_KEYS)if(!same(x[k],y[k]))throw new Error('저장한 문서에서 글자 서식이 유지되지 않았어요. 원본은 변경하지 않았어요.');}}
 else if(t.kind==='cell'){let x;try{x=checked(doc.getCellOwnProperties(t.c.sec,t.c.para,t.c.ctrl,t.c.cell));}catch{continue;}const y=checked(v.getCellOwnProperties(t.c.sec,t.c.para,t.c.ctrl,t.c.cell));for(const k of t.keys)if(!same(x[k],y[k]))throw lost;}
 else{const r=paraRef(t.c);if(!r)continue;let x;try{x=paraGet(doc,r);}catch{continue;}let y;try{y=paraGet(v,r);}catch{throw lost;}for(const k of PARA_KEYS)if(!same(x[k],y[k]))throw new Error('저장한 문서에서 문단 서식이 유지되지 않았어요. 원본은 변경하지 않았어요.');}}}
function openError(e){const m=String(e?.message??e);if(/비밀번호가 필요한/.test(m))return new Error('PASSWORD_REQUIRED');if(/비밀번호가 일치하지/.test(m))return new Error('PASSWORD_WRONG');return e;}
function memoList(d=doc){
 if(typeof d.getMemoList!=='function')throw new Error('메모 엔진이 필요해요. 최신 빌드로 업데이트해 주세요.');
 return checked(d.getMemoList());
}
function decoratedMemos(){return memoList().map(m=>{
 const c=memoTarget(m);let anchor='',marks=[];
 if(c)try{anchor=[...range(c)].slice(m.startCharIdx,m.endCharIdx).join('');marks=rects(c,m.startCharIdx,m.endCharIdx);}catch{}
 return {...m,anchor,rects:marks};
});}
function tableRef(){const c=selected&&paraRef(selected);if(!c||c.cell==null)throw new Error('먼저 표의 칸을 눌러 주세요. 겹친 표는 지원하지 않아요.');return c;}
function tableCells(c){return checked(doc.getTableCellBboxes(c.sec,c.para,c.ctrl));}
function memoSignature(d){return memoList(d).map(({author,text})=>({author,text}));}

async function operation(op,a){await ready;
 if(op==='open'){if(doc){doc.free();doc=null;}password=typeof a.password==='string'?a.password:null;const b=new Uint8Array(a.bytes);try{doc=openBytes(b);}catch(e){password=null;throw openError(e);}savedBytes=b;fixPictureSizes();fresh();savedText=text();return {...meta(true),encrypted:password!=null};}
 if(!doc)throw new Error('먼저 문서를 열어 주세요.');
 if(op==='page'){if(a.index<0||a.index>=doc.pageCount())throw new Error('페이지를 찾을 수 없어요.');const svg=doc.renderPageSvg(a.index);if(svg.length>64*1024*1024)throw new Error('이 페이지의 그림이 너무 복잡해요.');return {svg};}
 if(op==='select'){selected=normalHit(JSON.parse(doc.hitTest(a.page,a.x,a.y)));return selection();}
 if(op==='change'){
  if(!selected)throw new Error('편집할 문장을 눌러 주세요.');
  // A commit from an editor that no longer matches the selected paragraph (after Enter/undo) must not overwrite it.
  if(a.ident!=null&&a.ident!==ident(selected))return {...meta(),selection:selection(),stale:true};
  if(a.text.length>100000)throw new Error('문단이 너무 길어요.');
  const prev=range(selected),next=a.text;if(prev===next)return {...meta(),selection:selection()};
  let pre=0,end=0;const p=[...prev],n=[...next];while(pre<p.length&&pre<n.length&&p[pre]===n[pre])pre++;
  while(end<p.length-pre&&end<n.length-pre&&p[p.length-1-end]===n[n.length-1-end])end++;
  // rhwp offsets count Unicode scalar values; textarea selection counts UTF-16 units.
  const off=pre,remove=p.length-pre-end,insert=n.slice(pre,n.length-end).join('');
  // Line breaks already inside the paragraph may stay; only newly typed ones are refused (Enter splits paragraphs).
  if(/[\r\n]/.test(insert))throw new Error('문단 안의 글자를 편집해 주세요. 줄 바꿈은 Enter로 문단을 나눠 주세요.');
  if(insert.includes(OBJ)||p.slice(pre,pre+remove).includes(OBJ))throw new Error('표·그림 같은 개체는 여기서 지우거나 넣을 수 없어요.');
  const now=Date.now(),id=ident(selected),group=typing&&typing.ident===id&&typing.rev===rev&&now-typing.last<1500&&now-typing.start<8000;
  takeSnapshot();try{replace(selected,off,remove,insert);doc.pageCount();selected.offset=a.offset==null?off+[...insert].length:[...next.slice(0,a.offset)].length;
   if(group){const s=history.pop();doc.discardSnapshot(s.id);}
   mark(false);typing={ident:id,rev,last:now,start:group?typing.start:now};return {...meta(),selection:selection()};}
  catch(e){rollback();throw e;}
 }
 if(op==='split'||op==='paste'||op==='merge'){
  if(!selected)throw new Error('편집할 문장을 눌러 주세요.');
  if(a.ident!=null&&a.ident!==ident(selected))return {...meta(),selection:selection(),stale:true};
  const c=selected,prev=range(c),start=[...prev.slice(0,a.start||0)].length,end=[...prev.slice(0,a.end??a.start??0)].length;
  if(op!=='merge'&&([...prev].slice(start,end).includes(OBJ)||String(a.text||'').includes(OBJ)))throw new Error('표·그림 같은 개체는 여기서 지우거나 넣을 수 없어요.');
  if(op==='merge'&&(inCell(c)?c.p:c.para)===0)return {...meta(),selection:selection()};
  typing=null;takeSnapshot();try{
   // One pagination for the whole command: a 50-paragraph paste went from ~2.6s to ~45ms with identical layout.
   doc.beginBatch();try{
    if(op==='merge')relocate(c,checked(c.path?doc.mergeParagraphInCellByPath(c.sec,c.para,c.path):inCell(c)?doc.mergeParagraphInCell(c.sec,c.para,c.ctrl,c.cell,c.p):doc.mergeParagraph(c.sec,c.para)));
    else{
     const lines=(op==='split'?'\n':String(a.text)).replace(/\r\n?/g,'\n').split('\n');if(lines.length>200||String(a.text||'').length>100000)throw new Error('붙여넣을 내용이 너무 길어요.');
     replace(c,start,end-start,lines[0]);c.offset=start+[...lines[0]].length;
     for(const line of lines.slice(1)){split(c,c.offset);if(line)replace(c,0,0,line);c.offset=[...line].length;}
    }
   }finally{doc.endBatch();}
   mark(false);return {...meta(),selection:selection()};
  }catch(e){rollback();throw e;}
 }
 if(op==='undo'||op==='redo'){const from=op==='undo'?history:future,to=op==='undo'?future:history;typing=null;let back=null,marks=[];if(from.length){
  // Restore first; only a successful restore moves the entry, so a failure leaks no snapshot and loses no history.
  const s=from.at(-1),cur=doc.saveSnapshot();try{checked(doc.restoreSnapshot(s.id));}catch(e){doc.discardSnapshot(cur);throw e;}
  from.pop();doc.discardSnapshot(s.id);to.push({id:cur,selected:selected?{...selected}:null,rev,fmt,range:s.range});
  selected=s.selected;rev=s.rev;fmt=s.fmt;back=s.range;if(back&&selected){const {s:x,e:y}=span(back);marks=rects(selected,x,y);}}
  return {...meta(true),selection:selection(),range:back,rects:marks};}
 if(op==='cancel'){doc.free();doc=openBytes(savedBytes);fixPictureSizes();fresh();return meta(true);}
 if(op==='charState'){sameTarget(a);const {s,e,n}=span(a);return charState(selected,s,e,n);}
 if(op==='paraState'){sameTarget(a);return paraState(selected);}
 if(op==='char'){
  sameTarget(a);const {s,e,n}=span(a);if(e<=s)throw new Error('서식을 바꿀 글자를 먼저 선택해 주세요.');
  const props=charProps(a.props),c=selected;
  takeSnapshot(editorRange(a));try{applyChar(c,s,e,JSON.stringify(props));
   // ok:true alone is not proof: read the applied values back at both ends of the range.
   for(const o of points(s,e)){const x=charAt(doc,c,o);for(const [k,v] of Object.entries(props))if(!same(x[k],v))throw new Error('글자 서식이 적용되지 않았어요.');}
   doc.pageCount();mark(true);fmtTargets.push({kind:'char',c:{...c},s,e});if(fmtTargets.length>200)fmtTargets.shift();
   return {...meta(),selection:selection(),charState:charState(c,s,e,n),rects:rects(c,s,e)};
  }catch(e){rollback();throw e;}
 }
 if(op==='para'){
  sameTarget(a);const c=selected,r=paraRef(c);if(!r)throw new Error('겹친 표 안의 문단 서식은 아직 지원하지 않아요.');
  const cur=paraGet(doc,r),p=a.props||{},props={};
  if(p.alignment!=null){if(!ALIGN.includes(p.alignment))throw new Error('지원하지 않는 정렬이에요.');props.alignment=p.alignment;}
  if(p.lineSpacing!=null){if(cur.lineSpacingType!=='Percent')throw new Error('이 문단의 줄 간격 방식은 아직 바꿀 수 없어요.');if(!Number.isInteger(p.lineSpacing)||p.lineSpacing<50||p.lineSpacing>500)throw new Error('지원하지 않는 줄 간격이에요.');props.lineSpacing=p.lineSpacing;}
  for(const k of ['spacingBefore','spacingAfter'])if(p[k]!=null)props[k]=spacingToRaw(p[k]);
  if(p.list!=null&&p.list!=='bullet'&&p.list!=='none')throw new Error('지원하지 않는 목록이에요.');
  if(!Object.keys(props).length&&p.list==null)throw new Error('바꿀 서식이 없어요.');
  takeSnapshot(editorRange(a.range));try{
   if(p.list==='bullet')Object.assign(props,{headType:'Bullet',numberingId:doc.ensureDefaultBullet('●'),paraLevel:0});
   if(p.list==='none')props.headType='None';
   paraSet(r,JSON.stringify(props));
   const x=paraGet(doc,r);for(const [k,v] of Object.entries(props))if(['spacingBefore','spacingAfter'].includes(k)?Math.abs(x[k]*75-v)>4:!same(x[k],v))throw new Error('문단 서식이 적용되지 않았어요.');
   doc.pageCount();mark(true);fmtTargets.push({kind:'para',c:{...c}});if(fmtTargets.length>200)fmtTargets.shift();
   return {...meta(),selection:selection(),paraState:paraState(c)};
  }catch(e){rollback();throw e;}
 }

 if(op==='memos')return decoratedMemos();
 if(op==='memoSelect'){
  const m=memoList().find(m=>m.id===a.id),c=m&&memoTarget(m);if(!c)throw new Error('이 메모의 위치로 이동할 수 없어요.');
  selected=c;const t=range(c),start=[...t].slice(0,m.startCharIdx).join('').length,end=[...t].slice(0,m.endCharIdx).join('').length;
  return {selection:selection(),range:{start,end},rects:rects(c,m.startCharIdx,m.endCharIdx)};
 }
 if(op==='memoAdd'||op==='memoUpdate'||op==='memoDelete'){
  memoList();let args;
  if(op==='memoAdd'){sameTarget(a);args=span(a);if(args.e<=args.s)throw new Error('메모를 달 글자를 선택해 주세요.');}
  else{const m=memoList().find(m=>m.id===a.id);if(!m||!m.editable)throw new Error(m?.readOnlyReason||'메모를 수정할 수 없어요.');}
  if(op!=='memoDelete'&&(typeof a.text!=='string'||!a.text.trim()||a.text.length>10000))throw new Error('메모 내용을 1~10000자로 입력해 주세요.');
  typing=null;takeSnapshot(editorRange(a));try{
   if(op==='memoAdd'){const c=selected,path=c.path||(inCell(c)?JSON.stringify([{controlIndex:c.ctrl,cellIndex:c.cell,cellParaIndex:c.p}]):null),json=JSON.stringify({author:String(a.author||'hwpxxx').slice(0,100),text:a.text});
    checked(path?doc.insertMemoByPath(c.sec,c.para,path,args.s,args.e,json):doc.insertMemo(c.sec,c.para,args.s,args.e,json));}
   else checked(op==='memoUpdate'?doc.setMemoText(a.id,a.text):doc.removeMemo(a.id));
   mark(true);return {...meta(),selection:selection(),memos:decoratedMemos()};
  }catch(e){rollback();throw e;}
 }

 if(op==='copyFormat'){
  sameTarget(a);const {s,n}=span(a),c=charAt(doc,selected,Math.min(s,Math.max(0,n-1))),r=paraRef(selected),hasCell=a.cellAttr||a.cellBorder;
  if(!['char','para','both','style'].includes(a.scope))throw new Error('복사할 모양을 골라 주세요.');
  if((a.scope!=='char'||hasCell)&&!r)throw new Error('겹친 표의 문단·셀 모양은 아직 복사할 수 없어요.');
  if(hasCell&&r.cell==null)throw new Error('셀 모양은 표 안에서 복사해 주세요.');
  const includeBody=!hasCell||!a.cellOnly,copyChar=includeBody&&(a.scope==='char'||a.scope==='both');
  painter={char:copyChar?Object.fromEntries(COPY_CHAR_KEYS.filter(k=>c[k]!=null).map(k=>[k,c[k]])):{},para:includeBody&&(a.scope==='para'||a.scope==='both')?paragraphForWrite(paraGet(doc,r)):{},cell:null,styleId:null};
  if(copyChar&&painter.char.fontIds==null&&painter.char.fontId==null&&c.fontFamily)painter.char.fontId=doc.findOrCreateFontId(c.fontFamily);
  if(includeBody&&a.scope==='style'){const style=checked(r.cell!=null?doc.getCellStyleAt(r.sec,r.para,r.ctrl,r.cell,r.p):doc.getStyleAt(r.sec,r.para));painter.styleId=style.id;}
  if(hasCell){const props=checked(doc.getCellOwnProperties(r.sec,r.para,r.ctrl,r.cell)),keys=[...(a.cellAttr?CELL_ATTR_KEYS:[]),...(a.cellBorder?['borderFillId']:[])];painter.cell=Object.fromEntries(keys.filter(k=>props[k]!=null).map(k=>[k,props[k]]));}
  return true;
 }
 if(op==='pasteFormat'){
  sameTarget(a);if(!painter)throw new Error('먼저 모양을 복사해 주세요.');const {s,e}=span(a),r=paraRef(selected),hasChar=Object.keys(painter.char).length,hasPara=Object.keys(painter.para).length;
  if(hasChar&&e<=s)throw new Error('모양을 적용할 글자를 선택해 주세요.');if((hasPara||painter.styleId!=null)&&!r)throw new Error('겹친 표의 문단 모양은 아직 바꿀 수 없어요.');
  if(painter.cell&&(!r||r.cell==null))throw new Error('셀 모양을 적용할 표 칸을 눌러 주세요.');
  typing=null;takeSnapshot(editorRange(a));try{
   if(hasChar){applyChar(selected,s,e,JSON.stringify(painter.char));fmtTargets.push({kind:'char',c:{...selected},s,e});}
   if(hasPara)paraSet(r,JSON.stringify(painter.para));
   if(painter.styleId!=null)checked(r.cell!=null?doc.applyCellStyle(r.sec,r.para,r.ctrl,r.cell,r.p,painter.styleId):doc.applyStyle(r.sec,r.para,painter.styleId));
   if(hasPara||painter.styleId!=null)fmtTargets.push({kind:'para',c:{...selected}});
   if(painter.cell){checked(doc.setCellProperties(r.sec,r.para,r.ctrl,r.cell,JSON.stringify(painter.cell)));fmtTargets.push({kind:'cell',c:{...r},keys:Object.keys(painter.cell)});}
   mark(true);painter=null;return {...meta(),selection:selection(),rects:rects(selected,s,e)};
  }catch(e){rollback();throw e;}
 }
 if(op==='tableState'){sameTarget(a);const c=tableRef();return {cells:tableCells(c),current:checked(doc.getCellInfo(c.sec,c.para,c.ctrl,c.cell))};}
 if(op==='tableMerge'){
  sameTarget(a);const c=tableRef(),cells=tableCells(c),first=cells.find(x=>x.cellIdx===a.first),last=cells.find(x=>x.cellIdx===a.last);if(!first||!last)throw new Error('표의 칸을 다시 선택해 주세요.');
  const r=expandCellRange(cells,first,last);typing=null;takeSnapshot();try{checked(doc.mergeTableCells(c.sec,c.para,c.ctrl,r.top,r.left,r.bottom,r.right));selected=null;mark(true);return {...meta(true),selection:null};}catch(e){rollback();throw e;}
 }

 if(op==='export'){
  doc.flushDeferredPagination();
  // Same check as the PC app: export with the engine's content-loss report and refuse to save if anything would be dropped.
  // Encrypted documents stay encrypted with the password they were opened with.
  const hwpx=a.format==='hwpx',ex=password!=null?(hwpx?doc.exportHwpxWithPasswordAndReport(password):doc.exportHwpWithPasswordAndReport(password)):(hwpx?doc.exportHwpxWithReport():doc.exportHwpWithReport());
  let bytes,loss;try{loss=JSON.parse(ex.contentLoss());bytes=ex.takeBytes();}finally{ex.free();}
  if(loss.count||loss.losses?.length){const what=(loss.losses||[]).slice(0,3).map(x=>x.kind||x.type||x.item||x.reason||'').filter(Boolean).join(', ');throw new Error(`저장하면 문서 일부${what?`(${what})`:''}가 빠질 수 있어 저장을 멈췄어요. 원본은 변경하지 않았어요.`);}
  if(bytes.length>32*1024*1024)throw new Error('저장 결과가 32MB를 넘어요.');
  const verify=openBytes(bytes);try {const t=JSON.parse(verify.getTextFileUnicode());if(t.replace(/\r\n/g,'\n')!==text().replace(/\r\n/g,'\n'))throw new Error('저장 전후의 문서 내용이 달라요. 원본은 변경하지 않았어요.');const count=verify.pageCount();if(!count||count>500)throw new Error('저장 결과의 페이지 수를 확인하지 못했어요.');verify.renderPageSvg(0);if(count>1)verify.renderPageSvg(count-1);verifyFormats(verify);if(typeof doc.getMemoList==='function'&&JSON.stringify(memoSignature(verify))!==JSON.stringify(memoSignature(doc)))throw new Error('저장 전후의 메모 내용이 달라요. 원본은 변경하지 않았어요.');}finally{verify.free();}
  exported={rev,text:text(),bytes:bytes.slice()};return {bytes,rev};
 }
 // Only a successful disk write becomes the new baseline; older undo states may differ in formatting from it.
 if(op==='saved'){if(!exported)throw new Error('저장할 문서를 먼저 내보내 주세요.');const b=new Uint8Array(a.bytes);if(b.length!==exported.bytes.length||b.some((v,i)=>v!==exported.bytes[i]))throw new Error('저장한 문서가 내보낸 문서와 달라요.');savedBytes=b;savedText=exported.text;savedRev=exported.rev;if(rev===savedRev){fmt=false;fmtTargets=[];}exported=null;for(const x of history)x.fmt=true;for(const x of future)x.fmt=true;dirtyRev=-1;return meta();}
 if(op==='close'){doc.free();doc=null;savedBytes=null;selected=null;password=null;return true;}
 throw new Error('지원하지 않는 문서 작업이에요.');
}
self.onmessage=async e=>{const {id,op,args}=e.data;try {self.postMessage({id,ok:true,data:await operation(op,args||{})});}catch(error){self.postMessage({id,ok:false,error:String(error.message||error)});}};

