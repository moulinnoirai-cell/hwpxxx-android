# Studio 프런트엔드 패치 (Android 편집기)

Android 앱의 문서 편집 화면은 본가 **rhwp-studio**(rHWP v0.9.0) 위에 hwpxxx 패치를 얹은 것입니다. 이 저장소가 패치 시리즈 전체를 가지고 있으며
(PC판은 따라가지 않습니다) 빌드 결과는 넣지 않습니다. 결과물은 `app/src/main/assets/studio/`(`.gitignore`)에 생깁니다.
원칙: 본가와 겹치는 동작은 본가를 따르고, hwpxxx 고유 기능만 얹습니다. 새 기능은 가능하면 새 파일(`src/hwpxxx/…`)에 두고 본가 파일에는 얇은 연결만 남깁니다.
rHWP는 MIT 라이선스이며 빌드 결과에 `LICENSE-rhwp.txt`, `THIRD_PARTY_LICENSES-rhwp.md`, `licenses/*`(번들된 npm 패키지)를 함께 싣습니다.

| 패치 | 내용 |
|---|---|
| `features/0001-hwpxxx-new-modules.patch` | 편집기 기능의 새 파일: 메모(패널·표식·명령), 모양 복사 대화상자(연속 적용), 줄 단위 재배치, 단축키 보조(`chord-map`, 툴팁), 조합 오버레이 글꼴(`composition-font`), 성능 계측(`perf-probe`), 시험 |
| `features/0002-hwpxxx-editor-hooks.patch` | 위 기능을 본가에 잇는 얇은 연결: 단축키(한글 조합 중 Ctrl+Enter 포함), 툴바(형광펜 분할 단추 포함), 입력 처리, 쪽·단 나누기 본문 한정, 메모·글자·문단 대화상자, 번역 문구 |
| `android/0101-android-new-modules.patch` | Android 셸 연동 새 파일: 호스트 계약·저장 검증·인쇄·상태·복구 봉투 포장, 시험 |
| `android/0102-android-host-hooks.patch` | Android 연결: 저장 실패 시 닫힘, 비공개 복구 저장소, 최근 문서·이력, 가져온 글꼴, 오프라인 빌드(PWA 제외) |
| `android/0103-android-composition-text-zoom.patch` | 한글 조합 오버레이 크기: 시스템 글자 크기(WebView textZoom)가 DOM 글자에만 걸려 조합 중 글자가 본문보다 크게 보이던 것을 보정 |
| `android/0104-android-host-font-scan-by-name.patch` | 큰 문서 여는 시간·편집 반응: 첫 화면 전(그리고 편집마다) 모든 쪽의 레이어 트리를 내보내 읽던 호스트 글꼴 탐색을, 문서의 글꼴 이름으로 바로 고르고 전체 쪽 확인은 화면이 뜬 뒤 문서당 한 번 틈틈이 하도록 바꿈. 가져온 글꼴이 없으면 탐색 자체를 하지 않음 |
| `android/0105-android-doc-scrollbar.patch` | 문서 영역 오른쪽의 항상 보이는 세로 스크롤바: WebView 기본 스크롤바는 스크롤할 때만 잠깐 보이고 잡을 수 없어, 손잡이를 끌거나 길을 눌러 이동하는 막대를 따로 둠(`src/hwpxxx/doc-scrollbar.ts`). 끄는 동안 쪽 표시, 길 위에 메모 자리 표시 |
| `android/0106-android-composition-baseline.patch` | 한글 조합 중 글자가 위아래로 흔들리던 문제: 깜빡이는 조합 오버레이(DOM)의 글자를 상자 가운데가 아니라 캔버스 글자와 같은 기준선(캐럿 사각형 높이의 80%)에 놓고, 왼쪽 끝에서 시작해 장평을 따르게 함 |

`features/` → `android/` 순서(이름순)로 적용합니다. 복구(자동 저장)는 본가 방식(세션 복구 키 `RecoveryCipher`)을 따르고,
셸의 비공개 저장소에는 봉투를 암호문 앞에 붙여 한 덩어리 바이트로 보관합니다(`src/hwpxxx/android-draft-envelope.ts`).
형광펜은 본가의 연속 형광펜을 쓰되, 본체 단추는 즉시 적용·오른쪽 ▾ 단추는 팔레트로 나눕니다.

## 고정 값 (`config/android-studio.json`)

- 본가 rHWP v0.9.0 커밋 `c9095c5f67632e6721e800ccc7fb43ea49d26682` (엔진 락 `config/android-engine.json`과 같아야 함)
- `featurePatches` / `androidPatches`: 패치 파일 이름과 SHA-256 (목록과 파일이 어긋나면 빌드·게이트가 실패)
- `sourcePaths`: 빌드에 쓰는 본가 경로(`rhwp-studio`, `rhwp-shared`, `vendor/npm/ajv`(`package.json` 의 `file:` 의존성), `src/renderer/square_gradient.sksl`, 글꼴·로고·라이선스)
- `packageLockSha256`: `rhwp-studio/package-lock.json` 해시 (`npm ci`로만 설치)
- `env`: `RHWP_WITHOUT_HWPCTRL=1`, `RHWP_DISABLE_EXTERNAL_WEBFONTS=1`, `RHWP_DISABLE_PWA=1`, **`RHWP_WITHOUT_AI=1`**(AI 도우미·외부 전송 없음)
- `base`: `/studio/`, `csp`: `MainActivity`가 보내는 헤더와 같은 엄격한 정책(`unsafe-eval` 없음, `wasm-unsafe-eval`만). `tests/studio-build.test.mjs`가 둘이 같음을 검사
- 엔진 코어(`rhwp.js`, `rhwp_bg.wasm`, `rhwp.d.ts`)는 `scripts/verify-engine.mjs`로 검증된 엔진을 그대로 쓰고, 그 해시를 `build-info.json`에 남김

## 빌드

```sh
bash scripts/build-engine.sh .build/rhwp                       # 엔진 (Rust, 별도)
node scripts/build-studio.mjs --upstream .build/rhwp           # Studio: git archive → 패치 → npm ci → tsc → vite → 검증
node scripts/verify-studio.mjs                                  # Gradle verifyDesktopStudio 가 같은 검사를 함
```

- `--node-modules <dir>`: 같은 `package-lock.json`으로 만든 `npm ci` 결과를 재사용(숨은 락 파일이 일치할 때만)
- `--run-tests`: 패치가 더하는 단위 시험 전부(`rhwp-studio/tests/hwpxxx-*.test.ts`, 실제 코어 사용). 업스트림 전체 시험은 일부러 돌리지 않음(희소 소스에서 알려진 기준 실패)
- `--write-pins`: 패치를 고친 뒤 새 해시를 락에 기록(차이를 꼭 검토)

## 입력 지연 (측정으로 찾은 원인과 고침)

`tests/studio-hwpxxx-features.mjs --profile` 이 CDP CPU 프로파일을 떠서 키 입력 중 메인 스레드가 어디에 쓰이는지 보여 줍니다.
이 기기(태블릿)의 Chromium에서 본문 약 2000자 문서에 글자 하나를 입력·삭제하는 데 각각 약 **0.53초**가 걸렸고, 시간의 대부분이
쪽을 다시 그릴 때 글자 덩어리마다 글꼴 이름 해석(`ordinaryTextFontFamilies` → `selectTextFaces`)을 처음부터 되풀이하는 데 쓰였습니다.
순수 함수 결과의 메모, 쪽 안 같은 글꼴의 한 번 해석, 환경 서명 기반 메모(`hwpxxx/signature-memo`)로 **입력 약 0.12초·삭제 약 0.11초**가 되었습니다.

## 성능 계측 (기기·에뮬레이터에서 읽기)

`window.rhwpPerfSnapshot()` 이 이름별 횟수·합계·최대·p95(ms)와 최근 항목을 돌려줍니다(`window.rhwpPerfReset()` 으로 비움).
`autosave.export` / `autosave.protect` / `autosave.store` (자동 복구 저장 단계), `input.afterEdit` / `input.updateCaret` / `input.executeOperation` (입력 경로),
`longtask` (50ms 이상 메인 스레드를 막은 작업). 숫자만 담고 문서 내용·이름은 담지 않으며 어디에도 저장·전송하지 않습니다.
