# 문서 엔진(rHWP)

이 앱의 엔진은 **본가 rHWP v0.9.1을 수정 없이** 다시 빌드한 것입니다(메모 읽기·편집 API는 v0.9.0부터 포함되어 있습니다).
이전에 있던 v0.8.7용 메모 이식 패치(`0001-rhwp-pr8269-memo-api-backport-to-v0.8.7.patch`)는 폐기했습니다.

- 고정 값: `config/android-engine.json` (본가 커밋, Rust nightly, wasm-bindgen, `-Ctarget-cpu=mvp`, `-Zbuild-std`)
- 빌드: `bash scripts/build-engine.sh <rhwp 체크아웃>` → `node scripts/install-engine.mjs .build/engine`
- 검사: `node scripts/verify-engine.mjs` (Gradle `verifyMemoEngine`이 매 빌드 전에 실행; 메모 API가 있는지, 생성된 `build-info.json`의 해시가 파일과 같은지 확인)
- API 30 WebView가 multivalue/externref를 실행하지 못해 표준 배포본(`@rhwp/core`)을 그대로 쓰지 않고 `mvp` 대상으로 다시 빌드합니다.

본가를 따라가는 방법: `config/android-engine.json`과 `config/android-studio.json`의 `commit`(과 `upstreamTag`, `packageLockSha256`)을 새 태그로 올리고,
`.github/workflows/android.yml`의 `ref:`를 맞춘 뒤 `patches/rhwp-studio/`의 패치가 적용되는지 확인합니다. 겹치는 기능은 본가를 우선합니다.
