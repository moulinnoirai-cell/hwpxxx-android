// The installed-APK Termux suite cannot run here, but its fixture bookkeeping can be checked: every chooseProject(...) call must name exactly the
// documents that exist in the connected Termux project at that point of the suite (earlier scenarios delete files; the final picker-recreation
// scenario once expected two documents while one was left, and could never pass). No loose counts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('./android-termux.cjs',import.meta.url),'utf8');
// Walk the suite in source order, tracking which "termux-*" documents the library can show, and collect what each chooseProject call expects.
function timeline(text){
 const present=new Set(),calls=[];
 const events=/privateWrite\(project\+'\/(?:nested\/)?(termux-[\w.]+)'|run-as','com\.termux','rm',project\+'\/(termux-[\w.]+)'|fill\('(termux-export)'\)|rm','-f','\/sdcard\/(termux-export\.hwpx)'|await chooseProject\(([^)]*)\)/g;
 const both=[...(/const BOTH=\[([^\]]*)\]/.exec(text)?.[1].matchAll(/'([^']+)'/g)||[])].map(m=>m[1]);
 for(const m of text.matchAll(events)){
  if(m[1])present.add(m[1]);
  else if(m[2])present.delete(m[2]);
  else if(m[3])present.add('termux-export.hwpx');
  else if(m[4])present.delete('termux-export.hwpx');
  else{const arg=m[5].trim();const expected=arg===''?both:[...arg.matchAll(/'([^']+)'/g)].map(x=>x[1]);calls.push({expected:[...expected].sort(),actual:[...present].sort()});}
 }
 return calls;
}
test('F-F: every chooseProject call expects exactly the documents that exist at that point',()=>{
 const calls=timeline(source);
 assert(calls.length>=3,'the suite connects the project at least three times (picker, duplicate connect, recreated picker)');
 for(const [i,c] of calls.entries())assert.deepEqual(c.expected,c.actual,`chooseProject call #${i+1}`);
 const last=calls.at(-1);assert.deepEqual(last.expected,['termux-nested.hwpx'],'the picker-recreation scenario ends with exactly the nested document');
});
test('F-F: the check catches the original defect (a bare chooseProject() after the deletions)',()=>{
 const broken=source.replace("await chooseProject(['termux-nested.hwpx'])","await chooseProject()");
 assert.notEqual(broken,source);
 const last=timeline(broken).at(-1);assert.notDeepEqual(last.expected,last.actual);
});
test('F-F: the final scenario asserts the exact remaining names, not a count',()=>{
 assert(/assert\.deepEqual\(await visibleNames\(\),\['termux-nested\.hwpx'\]/.test(source));
 assert(!/count\(\)>=1/.test(source.slice(source.indexOf('the process is killed while the system folder picker is open'))),'no loose count in the final scenario');
});
