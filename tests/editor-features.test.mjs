import test from 'node:test';
import assert from 'node:assert/strict';
import {spacingToRaw,spacingToPt,numeric,expandCellRange,memoTarget,paragraphForWrite} from '../app/src/main/assets/editor-features.mjs';
test('10pt paragraph spacing survives engine px readback without halving',()=>{
 assert.equal(spacingToRaw(10),2000);assert.equal(spacingToPt(2000/75),10);
 assert.equal(paragraphForWrite({spacingBefore:2000/75}).spacingBefore,2000);
 assert.throws(()=>numeric('abc',0,100));assert.equal(numeric(500,50,200),200);
});
test('merged-cell expansion includes a second merge reached by the first expansion',()=>{
 const a={row:2,col:0,rowSpan:1,colSpan:1},b={row:2,col:1,rowSpan:1,colSpan:1};
 const cells=[a,b,{row:1,col:1,rowSpan:2,colSpan:1},{row:0,col:0,rowSpan:2,colSpan:1}];
 assert.deepEqual(expandCellRange(cells,a,b),{top:0,left:0,bottom:2,right:1});
});
test('memo navigation preserves nested cell paths and refuses footnotes',()=>{
 const m={sectionIndex:0,paraIndex:4,startCharIdx:2,endCharIdx:6,path:[{type:'cell',controlIndex:1,cellIndex:3,paraIndex:0},{type:'cell',controlIndex:0,cellIndex:1,paraIndex:2}]};
 assert.deepEqual(JSON.parse(memoTarget(m).path),[{controlIndex:1,cellIndex:3,cellParaIndex:0},{controlIndex:0,cellIndex:1,cellParaIndex:2}]);
 assert.equal(memoTarget({...m,path:[{type:'footnote'}]}),null);
});
