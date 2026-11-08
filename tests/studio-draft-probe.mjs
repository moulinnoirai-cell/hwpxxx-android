// Helper of tests/studio-smoke.py: checks that an encrypted recovery draft is real ciphertext, using the packaged engine core.
//   node tests/studio-draft-probe.mjs <draft file> <password> <text that must be inside after decryption>
import fs from 'node:fs';
import {initSync,HwpDocument} from '../app/src/main/assets/engine/rhwp.js';
const [file,password,needle]=process.argv.slice(2);
initSync({module:fs.readFileSync(new URL('../app/src/main/assets/engine/rhwp_bg.wasm',import.meta.url))});
const bytes=new Uint8Array(fs.readFileSync(file));
let refused=false;
try{new HwpDocument(bytes);}catch(e){refused=/비밀번호|password/i.test(String(e?.message??e));}
if(!refused){console.log('NOT-REFUSED');process.exit(1);}
console.log('refused-without-password');
const d=HwpDocument.openWithPassword(bytes,password);
const text=String(JSON.parse(d.getTextFileUnicode()));
if(!text.includes(needle)){console.log('TEXT-MISSING');process.exit(1);}
console.log('opened-with-password');
