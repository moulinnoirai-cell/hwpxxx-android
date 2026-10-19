import fs from 'node:fs';
import init,{initSync,HwpDocument} from '../app/src/main/assets/engine/rhwp.js';
initSync({module:fs.readFileSync(new URL('../app/src/main/assets/engine/rhwp_bg.wasm',import.meta.url))});
fs.mkdirSync(new URL('fixtures/',import.meta.url),{recursive:true});
const d=new HwpDocument(fs.readFileSync(new URL('fixtures/blank.hwp',import.meta.url)));
d.insertText(0,0,0,'한글 문서 실제 편집 시험입니다.');
d.splitParagraph(0,0,7);d.insertText(0,1,0,'두 번째 문단입니다. ');
fs.writeFileSync(new URL('fixtures/문서.hwp',import.meta.url),d.exportHwp());
try{fs.writeFileSync(new URL('fixtures/문서.hwpx',import.meta.url),d.exportHwpx());}catch(e){console.log('HWP to HWPX conversion unavailable; use an HWPX source for format-preserving edits.');const x=new HwpDocument(fs.readFileSync(new URL('fixtures/blank.hwpx',import.meta.url)));x.insertText(0,0,0,'한글 문서 실제 편집 시험입니다.');fs.writeFileSync(new URL('fixtures/문서.hwpx',import.meta.url),x.exportHwpx());x.free();}
console.log('fixtures created',d.pageCount(),d.getTextFileUnicode());
d.free();
