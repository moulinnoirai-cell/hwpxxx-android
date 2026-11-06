const {spawnSync}=require('node:child_process');
let failed=false;
for(const file of ['android-emulator.cjs','android-termux.cjs']){
 const result=spawnSync(process.execPath,['tests/'+file],{stdio:'inherit',timeout:12*60*1000});
 if(result.status!==0){failed=true;console.error('Android suite failed:',file,result.error?.message||result.signal||result.status);}
}
process.exitCode=failed?1:0;
