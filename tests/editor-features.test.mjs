import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spacingToRaw,spacingToPt,numeric,expandCellRange,memoTarget,paragraphForWrite,clampZoom,ZOOM_MIN,ZOOM_MAX,probeScale} from '../app/src/main/assets/editor-features.mjs';
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

// F9: pinch, Ctrl+wheel, the zoom buttons and the stored position share one range.
test('one zoom range for wheel, buttons, pinch and stored positions',()=>{
 assert.equal(ZOOM_MIN,50);assert.equal(ZOOM_MAX,400);
 assert.equal(clampZoom(10),50);assert.equal(clampZoom(60),60);assert.equal(clampZoom(900),400);assert.equal(clampZoom(NaN),100);assert.equal(clampZoom(undefined),100);
 const app=fs.readFileSync(new URL('../app/src/main/assets/app.js',import.meta.url),'utf8');
 // No code path may carry its own zoom bounds again (the pinch used Math.max(100,...) while Ctrl+wheel allowed 50).
 assert(!/Math\.max\(\s*\d+\s*,\s*Math\.min\(\s*\d+\s*,[^)]*zoom/i.test(app),'a hard-coded zoom range is back in app.js');
 assert.equal((app.match(/clampZoom\(/g)||[]).length,3,'zoomDocument (wheel, buttons, keys), the stored position and the pinch all go through clampZoom');
});
// H4: Android text zoom is measured with a 100px probe; measurement noise is not compensated.
test('text zoom probe: factor only when the probe differs from 100px',()=>{
 assert.equal(probeScale(100),1);assert.equal(probeScale(101.5),1);assert.equal(probeScale(0),1);assert.equal(probeScale(NaN),1);
 assert.equal(probeScale(150),1.5);assert.equal(probeScale(85),.85);assert.equal(probeScale(5000),4);assert.equal(probeScale(10),.5);
});
