import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const source=process.argv[2];if(!source)throw new Error('Pass the built engine directory');
const dest='app/src/main/assets/engine';
const lock=JSON.parse(fs.readFileSync('config/android-engine.json'));
const js=fs.readFileSync(path.join(source,'rhwp.js'),'utf8');
for(const method of ['getMemoList','insertMemo','insertMemoByPath','setMemoText','removeMemo'])if(!js.includes(method+'('))throw new Error('Missing memo API: '+method);
const hashes={};for(const name of ['rhwp.js','rhwp_bg.wasm','rhwp.d.ts']){
 const bytes=fs.readFileSync(path.join(source,name));hashes[name]=crypto.createHash('sha256').update(bytes).digest('hex');fs.writeFileSync(path.join(dest,name),bytes);
}
fs.writeFileSync(path.join(dest,'build-info.json'),JSON.stringify({...lock,hashes},null,2)+'\n');
console.log('Installed rHWP memo engine',hashes);
