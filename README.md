# hwpxxx for Android 0.3.0

개인용 오프라인 HWP/HWPX 문서 앱입니다. 앱 ID `kr.offline.hwp`, Android 11(API 30) 이상, 문서 엔진 rhwp 0.8.7(MIT).
인터넷 권한이 없고 광고·분석·원격 글꼴·외부 전송이 없습니다. 문서는 기기 안에서만 처리합니다.

## 이 저장소의 출처

사용자가 올린 `hwpxxx-0.1.2.apk`(SHA-256 `a146cdd1…2104`)가 기준입니다. 0.1.2의 Android 원본은 찾지 못했기 때문에, 아래 순서로 **재구축**했습니다. 0.1.2 원본을 그대로 이어받은 저장소가 아닙니다.

1. 복구한 0.1.1 Android 프로젝트(Gradle, MainActivity, FileStore)를 뼈대로 가져왔습니다.
2. 웹 자산(app.js, native.css, engine-worker.js, 로고)을 0.1.2 APK에서 추출한 것으로 교체했습니다.
3. 0.1.2 APK의 classes.dex를 역컴파일(jadx)해 0.1.1에 없던 네이티브 동작을 소스로 옮겼습니다. 삭제 브리지, 첫 HWP 덮어쓰기 백업, HWPX 중앙 디렉터리·암호화 항목 검사, 테마별 시스템 바, 키보드를 고려한 inset, 메모리 부족 응답이 여기에 해당합니다. 아이콘·테마 리소스도 0.1.2 APK에서 가져왔습니다.
4. 그 위에 2026-10-18 최종 디자인(문서함, 권한 안내 3화면, 설정 팝업)과 편집 변경을 반영했습니다.

자세한 변경과 검증 결과는 [docs/CHANGES-0.2.0.md](docs/CHANGES-0.2.0.md)에 있습니다. 0.1.1 당시 문서와 테스트 기록은 `docs/history-0.1.1/`에 보관했고, 현재 버전의 통과 근거로 쓰지 않습니다.

## 구조

| 경로 | 내용 |
|---|---|
| `app/src/main/java/kr/offline/hwp/MainActivity.java` | WebView, 로컬 가상 origin, Native 브리지(`OfflineNative`) |
| `app/src/main/java/kr/offline/hwp/FileStore.java` | 경로 검증, 문서 검증, 원자적 저장, 백업, 이동 |
| `app/src/main/assets/studio-host.js` | 데스크톱 편집기의 Android 파일·복구·글꼴·클립보드·인쇄 연결 |
| `app/src/main/assets/studio/` | 고정한 데스크톱 Studio에서 생성하는 편집기 번들 (Git 제외) |
| `config/android-studio.json`, `patches/rhwp-studio/` | 데스크톱 1.6.1 소스와 Android 연결 패치의 빌드 고정 정보 |
| `app/src/main/assets/app.js` | 명시적으로 선택하는 기존 문서함·편집기 테스트 경로 |
| `app/src/main/java/kr/offline/hwp/FontStore.java` | 가져온 TTF/OTF의 비공개 영구 보관·검증 |
| `app/src/main/assets/intro.js` | 파일 접근 미허용 안내 3화면과 전환 |
| `app/src/main/assets/library.css` | 승인 디자인에서 생성한 문서함·안내·팝업 스타일 (`scripts/make_library_css.py`) |
| `app/src/main/assets/engine*`, `fonts/`, `icons.js` | rhwp 0.8.7, Noto Sans KR, Lucide (원래 라이선스 포함) |
| `design/latest-inline-fragment.html` | 승인 디자인 원본 |
| `tests/` | FileStore JVM 시험, 브라우저 미리보기 서버, 안내 화면 타이밍 시험, rhwp 샘플 문서 |

## 0.3.0 편집 및 태블릿 지원

PC 1.6.1의 메모·형광펜 모드·모양 복사·문단 간격·자간/장평·표 칸 합치기를 추가했습니다. 갤럭시 탭 S7 가로 화면에서는 오른쪽 편집 패널을 사용하고 회전 중에도 입력을 유지합니다. 범위와 기기 시험 상태는 [변경 안내](docs/CHANGES-0.3.0.md)를 참고하세요.

현재 개발 브랜치는 **데스크톱의 실제 편집기 코드**를 기본 화면으로 사용합니다. 단축키·마우스 선택·툴팁·서식·표·쪽·개체 명령을 공유하고, Android 파일 저장과 내려받은 글꼴 등록을 연결합니다. 사용법과 검증 구분은 [DeX 데스크톱 편집기](docs/DEX-DESKTOP-PARITY.md), 글꼴의 형식·보관 방식은 [글꼴 안내](docs/ANDROID-FONTS.md)를 참고하세요. 실행한 검사와 기기 확인 범위는 [검증 기록](docs/DEX-VALIDATION.md)에 정리했습니다.

최상단 **도구 오른쪽의 문서 탭**, 마우스 드래그 순서 변경과 **두 문서 좌우 분할**을 지원합니다. 최대 8개 탭의 사용법·저장 및 복구 동작·기기 확인 범위는 [여러 문서 작업공간](docs/DEX-WORKSPACE.md)에 있습니다.

## 빌드

먼저 `config/android-engine.json`의 커밋을 별도 rhwp 작업 사본에 체크아웃하고 Rust nightly-2026-02-01(rust-src 및 wasm32-unknown-unknown 타깃), wasm-bindgen-cli 0.2.127로 `bash scripts/build-engine.sh <rhwp 작업 사본>`을 실행하세요. 새 엔진은 GitHub Actions에서도 빌드합니다.

이어서 Node.js 22 이상으로 공유 편집기를 빌드합니다. 작업 사본에는 `rhwp-studio`, `assets/fonts`, `assets/logo`와 upstream 라이선스 파일도 있어야 합니다. `npm ci`는 고정한 잠금 파일의 의존성을 설치합니다.

```bash
node scripts/install-engine.mjs .build/engine
node scripts/build-studio.mjs --upstream .build/rhwp --run-tests
node scripts/verify-studio.mjs
```

엔진 또는 Studio가 없거나 빌드 정보와 파일 해시가 맞지 않으면 Gradle 빌드는 중단됩니다. 생성한 런타임 파일을 소스 변경으로 커밋하지 않습니다.

JDK 17과 Android SDK(platform 35, build-tools 35.0.0)가 필요합니다. `local.properties`에 다음을 적습니다. 이 파일은 커밋하지 않습니다.

```
sdk.dir=C\:/path/to/android-sdk
release.storeFile=C\:/path/to/hwpxxx-release.jks
release.passwordFile=C\:/path/to/keystore-password.txt
```

```bash
./gradlew.bat assembleRelease
```

서명 설정이 없으면 서명되지 않은 release APK가 만들어집니다.

## 시험

```bash
node tests/engine-fixtures.mjs
```

```bash
javac -encoding UTF-8 -d build/fs-test app/src/main/java/kr/offline/hwp/FileStore.java tests/FileStoreTest.java && java -cp build/fs-test kr.offline.hwp.FileStoreTest tests/fixtures/문서.hwp tests/fixtures/문서.hwpx
```

```bash
node tests/preview-server.mjs 8765
```

미리보기 서버를 켠 상태에서, playwright-core와 로컬 Chrome으로 안내 화면을 측정합니다.

```bash
node tests/intro-timing.cjs http://localhost:8765
```

미리보기 서버는 Android 대신 가짜 브리지를 쓰고, `tests/fixtures`의 임시 사본에서 실제로 파일을 바꿉니다. Android 기기 시험을 대신하지 않습니다.


## Termux 프로젝트 검색

기본 편집기에서는 `Ctrl+O`로 파일 열기 대화상자를 띄운 뒤 **폴더 연결**에서 Android 폴더 선택 화면의 프로젝트 폴더를 선택합니다. 기존 테스트 편집기는 설정의 **Termux 프로젝트 폴더 연결**을 사용합니다. 하위 폴더의 HWP/HWPX를 검색하고 열 수 있으며, 편집 결과는 기기 저장공간에 복사본으로 저장합니다. 연결은 재시작 후에도 유지됩니다. 연결 해제는 Termux 파일을 삭제하지 않습니다. 자세한 동작과 실제 APK 검증 범위는 [DeX 시험 문서](docs/DEX-QA.md)를 참고하세요.
