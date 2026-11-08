// Gate for Gradle (verifyStudio) and CI: fails unless the packaged desktop Studio matches config/android-studio.json
// and the packaged engine core. There is no skip switch.
//   node scripts/verify-studio.mjs [--out app/src/main/assets/studio]
import {verifyStudio,DEFAULT_OUT} from './studio-lib.mjs';
const i=process.argv.indexOf('--out'),out=i>0?process.argv[i+1]:DEFAULT_OUT;
const {errors,info}=verifyStudio({out});
if(errors.length){console.error('Studio integrity check FAILED:\n - '+errors.join('\n - '));process.exit(1);}
console.log(`Studio OK: desktop ${info.pins.desktopVersion} (${Object.keys(info.pins.desktopPatches).length} PC patches + ${Object.keys(info.pins.androidPatches).length} Android patches), main ${info.mainScript}, ${Object.keys(info.files).length} files`);
