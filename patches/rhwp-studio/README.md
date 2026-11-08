# 데스크톱 Studio 프런트엔드 패치 (Android 공유 편집기)

Android 앱의 문서 편집 화면은 PC판(hwpxxx 데스크톱 1.6.1)과 같은 **rhwp-studio**입니다. 이 저장소에는 빌드 결과를 넣지 않고,
고정 입력(`config/android-studio.json`)·패치·스크립트만 둡니다. 결과물은 `app/src/main/assets/studio/`(`.gitignore`)에 생깁니다.
rHWP는 MIT 라이선스이며 빌드 결과에 `LICENSE-rhwp.txt`, `THIRD_PARTY_LICENSES-rhwp.md`, `licenses/*`(번들된 npm 패키지)를 함께 싣습니다.

| 디렉터리 | 내용 |
|---|---|
| `desktop/0001…0011` | PC판 `patches/rhwp-studio` 11개를 **그대로** 복사한 것(PC 저장소 `fc87e2af24a98a25b6abac17144d167e1576e505`, 해시는 PC `config/editor-build.json`과 같음). 수정 금지 |
| `android/0101…` | 그 위에 순서대로 얹는 Android 전용 패치(셸 통합, 실패 시 닫힘 저장, 비공개 복구 저장소, 저장 검증 …). 이름의 번호 순으로 적용 |

## 고정 값 (`config/android-studio.json`)

- 본가 rHWP v0.8.7 커밋 `1a76570e833917d15817415a53c09ad61ab3203f` (엔진 락 `config/android-engine.json`과 같아야 함)
- `desktopPatches` / `androidPatches`: 패치 파일 이름과 SHA-256 (목록과 파일이 어긋나면 빌드·게이트가 실패)
- `packageLockSha256`: `rhwp-studio/package-lock.json` 해시 (`npm ci`로만 설치)
- `env`: `RHWP_WITHOUT_HWPCTRL=1`, `RHWP_DISABLE_EXTERNAL_WEBFONTS=1`, `RHWP_DISABLE_PWA=1`(서비스 워커·매니페스트 없음)
- `base`: `/studio/`, `csp`: `MainActivity`가 보내는 헤더와 같은 엄격한 정책(`unsafe-eval` 없음, `wasm-unsafe-eval`만). `tests/studio-build.test.mjs`가 둘이 같음을 검사
- 엔진 코어(`rhwp.js`, `rhwp_bg.wasm`, `rhwp.d.ts`)는 `scripts/verify-engine.mjs`로 검증된 Android 엔진을 그대로 사용하고, 그 해시를 `build-info.json`에 남김

## 빌드

```sh
bash scripts/build-engine.sh .build/rhwp                       # 엔진 (Rust, 별도)
node scripts/build-studio.mjs --upstream .build/rhwp           # Studio: git archive → PC 패치 → Android 패치 → npm ci → tsc → vite → 검증
node scripts/verify-studio.mjs                                  # Gradle verifyDesktopStudio 가 같은 검사를 함
```

- `--node-modules <dir>`: 같은 `package-lock.json`으로 만든 `npm ci` 결과를 재사용(숨은 락 파일이 일치할 때만)
- `--run-tests`: 패치가 더하는 Android 전용 단위 시험 전부(`rhwp-studio/tests/hwpxxx-android-*.test.ts`: 호스트 표면·저장 안전·이력/최근 문서 …, 실제 코어 사용). 업스트림 전체 시험은 일부러 돌리지 않음(희소 소스에서 알려진 기준 실패)
- `--check-paths`: 경로만 검사하고 아무것도 바꾸지 않음
- `--write-pins`: 패치를 고친 뒤 `config/android-studio.json`에 새 해시를 기록(변경 내용을 꼭 검토)
- **`--work`/`--out`은 빌드 때마다 지워집니다.** 그래서 `--work`는 `.build/` 아래, `--out`은 `app/src/main/assets/studio` 또는 `.build/` 아래만 허용하고,
  저장소 루트·upstream·엔진·서로 겹치는 경로·심볼릭 링크로 빠져나가는 경로는 어떤 파일도 건드리기 전에 거절합니다.

패치를 새로 만들 때는 위 순서로 적용한 작업 트리(git)에서 `git diff`로 뽑고, `--write-pins`로 해시를 기록한 뒤 `desktop/`은 건드리지 마세요.
