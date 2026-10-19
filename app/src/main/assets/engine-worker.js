import init,{HwpDocument} from './engine/rhwp.js';
let doc=null,selected=null,savedBytes=null,savedText='',history=[],future=[];
const canvas=typeof OffscreenCanvas==='function'?new OffscreenCanvas(8,8):null;
globalThis.measureTextWidth=(font,text)=>{if(canvas){const c=canvas.getContext('2d');c.font=font;return c.measureText(text).width;}return [...text].length*7;};
const ready=init({module_or_path:'/engine/rhwp_bg.wasm'});
const checked=s=>{const r=typeof s==='string'?JSON.parse(s):s;if(r?.ok===false||r?.error)throw new Error(r.error||'편집할 수 없는 위치예요.');return r;};
const text=()=>JSON.parse(doc.getTextFileUnicode());
function meta(){const count=doc.pageCount();if(count<1||count>500)throw new Error('이 문서는 500페이지 한도를 넘었어요.');return {count,dirty:text()!==savedText,sizes:Array.from({length:count},(_,i)=>JSON.parse(doc.getPageInfo(i)))};}
function normalHit(h){if(h.cellPath?.length)return {sec:h.sectionIndex,para:h.parentParaIndex,path:JSON.stringify(h.cellPath),p:h.cellParaIndex||0,offset:h.charOffset};if(h.parentParaIndex!=null&&h.cellIndex!=null)return {sec:h.sectionIndex,para:h.parentParaIndex,ctrl:h.controlIndex,cell:h.cellIndex,p:h.cellParaIndex||0,offset:h.charOffset};return {sec:h.sectionIndex,para:h.paragraphIndex,offset:h.charOffset};}
function inCell(c){return c.path!=null||c.cell!=null;}
function len(c){return c.path!=null?doc.getCellParagraphLengthByPath(c.sec,c.para,c.path):inCell(c)?doc.getCellParagraphLength(c.sec,c.para,c.ctrl,c.cell,c.p):doc.getParagraphLength(c.sec,c.para);}
function range(c){return c.path!=null?doc.getTextInCellByPath(c.sec,c.para,c.path,0,100000):inCell(c)?doc.getTextInCell(c.sec,c.para,c.ctrl,c.cell,c.p,0,100000):doc.getTextRange(c.sec,c.para,0,100000);}
function rect(c,offset){return JSON.parse(c.path!=null?doc.getCursorRectByPath(c.sec,c.para,c.path,offset):inCell(c)?doc.getCursorRectInCell(c.sec,c.para,c.ctrl,c.cell,c.p,offset):doc.getCursorRect(c.sec,c.para,offset));}
function selection(){if(!selected)return null;return {text:range(selected),offset:selected.offset,start:rect(selected,0),end:rect(selected,len(selected)),key:JSON.stringify(selected)};}
function replace(c,start,n,s){if(c.path!=null){if(n)checked(doc.deleteTextInCellByPath(c.sec,c.para,c.path,start,n));if(s)checked(doc.insertTextInCellByPath(c.sec,c.para,c.path,start,s));return;}return checked(inCell(c)?doc.replaceTextInCellDeferredPagination(c.sec,c.para,c.ctrl,c.cell,c.p,start,n,s):doc.replaceText(c.sec,c.para,start,n,s));}
function relocate(c,result){if(inCell(c)){c.p=result.cellParaIndex??c.p;if(c.path){const path=JSON.parse(c.path);path.at(-1).cellParaIndex=c.p;c.path=JSON.stringify(path);}}else c.para=result.paraIdx??c.para;c.offset=result.charOffset??0;}
function split(c,off){const r=checked(c.path?doc.splitParagraphInCellByPath(c.sec,c.para,c.path,off):inCell(c)?doc.splitParagraphInCell(c.sec,c.para,c.ctrl,c.cell,c.p,off):doc.splitParagraph(c.sec,c.para,off));relocate(c,r);}
function takeSnapshot(){for(const x of future)doc.discardSnapshot(x.id);future=[];const limit=Math.min(40,Math.max(1,doc.snapshotCapacity()-2));while(history.length>=limit){const x=history.shift();doc.discardSnapshot(x.id);}history.push({id:doc.saveSnapshot(),selected:selected?{...selected}:null});}
async function operation(op,a){await ready;
 if(op==='open'){if(doc)doc.free();doc=new HwpDocument(new Uint8Array(a.bytes));savedBytes=new Uint8Array(a.bytes);selected=null;history=[];future=[];savedText=text();return meta();}
 if(!doc)throw new Error('먼저 문서를 열어 주세요.');
 if(op==='page'){if(a.index<0||a.index>=doc.pageCount())throw new Error('페이지를 찾을 수 없어요.');const svg=doc.renderPageSvg(a.index);if(svg.length>8*1024*1024)throw new Error('이 페이지의 그림이 너무 복잡해요.');return {svg};}
 if(op==='select'){selected=normalHit(JSON.parse(doc.hitTest(a.page,a.x,a.y)));return selection();}
 if(op==='change'){
  if(!selected)throw new Error('편집할 문장을 눌러 주세요.');
  if(a.text.length>100000||/[\r\n]/.test(a.text))throw new Error('문단 안의 글자를 편집해 주세요. 줄 바꿈은 현재 지원하지 않아요.');
  const prev=range(selected),next=a.text;if(prev===next)return {...meta(),selection:selection()};
  let pre=0,end=0;const p=[...prev],n=[...next];while(pre<p.length&&pre<n.length&&p[pre]===n[pre])pre++;
  while(end<p.length-pre&&end<n.length-pre&&p[p.length-1-end]===n[n.length-1-end])end++;
  // rhwp offsets count Unicode scalar values; textarea selection counts UTF-16 units.
  const off=pre,remove=p.length-pre-end,insert=n.slice(pre,n.length-end).join('');
  takeSnapshot();try{replace(selected,off,remove,insert);doc.pageCount();selected.offset=a.offset==null?off+[...insert].length:[...next.slice(0,a.offset)].length;return {...meta(),selection:selection()};}
  catch(e){const s=history.pop();doc.restoreSnapshot(s.id);selected=s.selected;doc.discardSnapshot(s.id);throw e;}
 }
 if(op==='split'||op==='paste'||op==='merge'){
  if(!selected)throw new Error('편집할 문장을 눌러 주세요.');
  const c=selected,prev=range(c),start=[...prev.slice(0,a.start||0)].length,end=[...prev.slice(0,a.end??a.start??0)].length;
  takeSnapshot();try{
   if(op==='merge'){
    if((inCell(c)?c.p:c.para)===0){const last=history.pop();doc.discardSnapshot(last.id);return {...meta(),selection:selection()};}
    relocate(c,checked(c.path?doc.mergeParagraphInCellByPath(c.sec,c.para,c.path):inCell(c)?doc.mergeParagraphInCell(c.sec,c.para,c.ctrl,c.cell,c.p):doc.mergeParagraph(c.sec,c.para)));
   }else{
    const lines=(op==='split'?'\n':String(a.text)).replace(/\r\n?/g,'\n').split('\n');if(lines.length>200||String(a.text||'').length>100000)throw new Error('붙여넣을 내용이 너무 길어요.');
    replace(c,start,end-start,lines[0]);c.offset=start+[...lines[0]].length;
    for(const line of lines.slice(1)){split(c,c.offset);if(line)replace(c,0,0,line);c.offset=[...line].length;}
   }
   return {...meta(),selection:selection()};
  }catch(e){const s=history.pop();doc.restoreSnapshot(s.id);selected=s.selected;doc.discardSnapshot(s.id);throw e;}
 }
 if(op==='undo'||op==='redo'){const from=op==='undo'?history:future,to=op==='undo'?future:history;if(from.length){to.push({id:doc.saveSnapshot(),selected:selected?{...selected}:null});const s=from.pop();checked(doc.restoreSnapshot(s.id));doc.discardSnapshot(s.id);selected=s.selected;}return {...meta(),selection:selection()};}
 if(op==='cancel'){doc.free();doc=new HwpDocument(savedBytes);selected=null;history=[];future=[];return meta();}
 if(op==='export'){
  const bytes=a.format==='hwpx'?doc.exportHwpx():doc.exportHwp();if(bytes.length>32*1024*1024)throw new Error('저장 결과가 32MB를 넘어요.');
  const verify=new HwpDocument(bytes);try {const t=JSON.parse(verify.getTextFileUnicode());if(t.replace(/\r\n/g,'\n')!==text().replace(/\r\n/g,'\n'))throw new Error('저장 전후의 문서 내용이 달라요. 원본은 변경하지 않았어요.');const count=verify.pageCount();if(!count||count>500)throw new Error('저장 결과의 페이지 수를 확인하지 못했어요.');verify.renderPageSvg(0);if(count>1)verify.renderPageSvg(count-1);}finally{verify.free();}
  return {bytes};
 }
 if(op==='saved'){savedBytes=new Uint8Array(a.bytes);savedText=text();return meta();}
 if(op==='close'){doc.free();doc=null;savedBytes=null;selected=null;return true;}
 throw new Error('지원하지 않는 문서 작업이에요.');
}
self.onmessage=async e=>{const {id,op,args}=e.data;try {self.postMessage({id,ok:true,data:await operation(op,args||{})});}catch(error){self.postMessage({id,ok:false,error:String(error.message||error)});}};
