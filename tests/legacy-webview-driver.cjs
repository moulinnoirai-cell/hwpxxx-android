// Test-driver compatibility only. Older Android WebView can expose checkVisibility
// on the utility-world prototype while its DOM wrappers do not implement it.
// Use the same bounding-rect visibility fallback used before this browser API.
const fs=require('node:fs'),path=require('node:path');
const root=path.join(path.dirname(require.resolve('playwright-core/package.json')),'lib');
let count=0;
function walk(dir){for(const f of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,f.name);if(f.isDirectory())walk(p);else if(f.name.endsWith('.js')){const s=fs.readFileSync(p,'utf8');if(s.includes('element.checkVisibility()')){fs.writeFileSync(p,s.replaceAll('element.checkVisibility()','(element.getClientRects().length > 0)'));count++;}}}}
walk(root);if(!count)throw new Error('Legacy driver patch did not match; review Playwright version');console.log('Legacy WebView driver fallback applied:',count);
