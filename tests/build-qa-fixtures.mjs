import fs from 'node:fs';
import {initSync,HwpDocument} from '../app/src/main/assets/engine/rhwp.js';
initSync({module:fs.readFileSync('app/src/main/assets/engine/rhwp_bg.wasm')});
fs.mkdirSync('.qa/fixtures',{recursive:true});
for(const format of ['hwp','hwpx']){
 const d=new HwpDocument(fs.readFileSync('tests/fixtures/문서.'+format));
 const b=format==='hwp'?d.exportHwpWithPassword('qa-only-2026'):d.exportHwpxWithPassword('qa-only-2026');
 fs.writeFileSync('.qa/fixtures/qa-locked.'+format,b);d.free();
}
const d=new HwpDocument(fs.readFileSync('tests/fixtures/blank.hwpx'));
d.beginBatch();try{for(let i=0;i<30;i++){if(i)d.splitParagraph(0,i-1,d.getParagraphLength(0,i-1));d.insertText(0,i,0,`${i+1}. DeX 문서 회귀 시험 한글😀 ABC `+'문서의 여러 페이지를 마우스와 키보드로 확인합니다. '.repeat(30));}}finally{d.endBatch();}
fs.writeFileSync('.qa/fixtures/qa-long.hwpx',d.exportHwpx());console.log('Long fixture pages:',d.pageCount());d.free();
