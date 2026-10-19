#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ -z "${ANDROID_SDK_ROOT:-}" ]]; then
  echo 'ANDROID_SDK_ROOT must point to an Android SDK with platform 35 and build-tools 35.0.0.' >&2
  exit 1
fi
build_tools="$ANDROID_SDK_ROOT/build-tools/35.0.0"
android_jar="$ANDROID_SDK_ROOT/platforms/android-35/android.jar"
mkdir -p build/classes build/gen build/dex
rm -rf build/classes/* build/gen/* build/dex/*
"$build_tools/aapt2" compile --dir app/src/main/res -o build/resources.zip
python3 - <<'PY'
from pathlib import Path
src=Path('app/src/main/AndroidManifest.xml').read_text()
Path('build/AndroidManifest.xml').write_text(src.replace('<manifest ','<manifest package="kr.offline.hwp" ',1))
PY
"$build_tools/aapt2" link -o build/resources.apk --manifest build/AndroidManifest.xml -I "$android_jar" --min-sdk-version 30 --target-sdk-version 35 --java build/gen -A app/src/main/assets build/resources.zip
mapfile -t java_sources < <(find app/src/main/java build/gen -name '*.java')
java -m jdk.compiler/com.sun.tools.javac.Main -encoding UTF-8 -source 8 -target 8 -bootclasspath "$build_tools/core-lambda-stubs.jar:$android_jar" -d build/classes "${java_sources[@]}"
mapfile -t class_files < <(find build/classes -name '*.class')
java -cp "$build_tools/lib/d8.jar" com.android.tools.r8.D8 --lib "$android_jar" --min-api 30 --output build/dex "${class_files[@]}"
python3 - <<'PY'
from pathlib import Path
import zipfile,shutil
shutil.copyfile('build/resources.apk','build/unsigned.apk')
with zipfile.ZipFile('build/unsigned.apk','a',zipfile.ZIP_DEFLATED) as z:
 assert 'AndroidManifest.xml' in z.namelist(), 'Incomplete resource APK'
 for p in Path('build/dex').glob('*.dex'):z.write(p,p.name)
PY
"$build_tools/zipalign" -f -p 4 build/unsigned.apk build/aligned.apk
if [[ -n "${HWP_KEYSTORE:-}" ]]; then
  "$build_tools/apksigner" sign --ks "$HWP_KEYSTORE" --ks-key-alias "${HWP_KEY_ALIAS:-hwp}" --ks-pass env:HWP_KEY_PASSWORD --out build/hwpxxx-0.1.1.apk build/aligned.apk
else
  echo 'No private signing key supplied; using the standard DEVELOPMENT key. For personal testing only.' >&2
  if [[ ! -f build/development.keystore ]]; then
    keytool -genkeypair -keystore build/development.keystore -storepass android -keypass android -alias androiddebugkey -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=Offline HWP Development,O=Local Development,C=KR'
  fi
  "$build_tools/apksigner" sign --ks build/development.keystore --ks-key-alias androiddebugkey --ks-pass pass:android --out build/hwpxxx-0.1.1.apk build/aligned.apk
fi
"$build_tools/apksigner" verify --verbose build/hwpxxx-0.1.1.apk
"$build_tools/aapt2" dump permissions build/hwpxxx-0.1.1.apk
