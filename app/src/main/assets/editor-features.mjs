// Shared conversions use the same units and bounds as hwpxxx desktop 1.6.1.
export const CHAR_KEYS=['bold','italic','underline','fontSize','textColor','shadeColor','spacings','ratios'];
export const PARA_KEYS=['alignment','lineSpacing','lineSpacingType','spacingBefore','spacingAfter','headType','numberingId','paraLevel','styleId'];
export const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
export function numeric(value,min,max){
 const n=Number(value);if(value===''||!Number.isFinite(n))throw new Error('숫자를 입력해 주세요.');return clamp(n,min,max);
}
export const spacingToRaw=pt=>Math.round(numeric(pt,0,1000)*200);
export const spacingToPt=px=>Math.round(px*75/200*10)/10;
export function paragraphForWrite(p){
 const out={};for(const k of PARA_KEYS)if(p[k]!=null)out[k]=p[k];
 for(const k of ['spacingBefore','spacingAfter'])if(out[k]!=null)out[k]=Math.round(out[k]*75);
 return out;
}
export function memoTarget(m){
 if(m.paraIndex==null||m.startCharIdx==null||m.endCharIdx==null)return null;
 if((m.path||[]).some(s=>s.type!=='cell'))return null;
 const c={sec:m.sectionIndex,para:m.paraIndex,offset:m.startCharIdx};
 if(m.path?.length){c.path=JSON.stringify(m.path.map(s=>({controlIndex:s.controlIndex,cellIndex:s.cellIndex,cellParaIndex:s.paraIndex})));c.p=m.path.at(-1).paraIndex;}
 return c;
}
// Grow to a fixed point: expanding for one merged cell may intersect another.
export function expandCellRange(cells,a,b){
 const r={top:Math.min(a.row,b.row),left:Math.min(a.col,b.col),bottom:Math.max(a.row+a.rowSpan-1,b.row+b.rowSpan-1),right:Math.max(a.col+a.colSpan-1,b.col+b.colSpan-1)};
 let changed=true;while(changed){changed=false;for(const c of cells){const bottom=c.row+c.rowSpan-1,right=c.col+c.colSpan-1;
  if(c.row>r.bottom||bottom<r.top||c.col>r.right||right<r.left)continue;
  const n={top:Math.min(r.top,c.row),left:Math.min(r.left,c.col),bottom:Math.max(r.bottom,bottom),right:Math.max(r.right,right)};
  if(Object.keys(r).some(k=>r[k]!==n[k])){Object.assign(r,n);changed=true;}
 }}return r;
}
