# hwpxxx 0.1.1

2026-10-16 · Android 11(API 30) 이상 · 앱 이름·로고 반영 업데이트 빌드

확정한 화면 디자인을 실제 Android 파일 처리와 공식 rhwp 0.8.7 엔진에 연결한 별도 앱입니다. 기존 `com.hwpviewer.hwp` APK의 Android 코드·광고·분석·푸시·원격 실행 SDK를 사용하지 않았습니다. 기존 앱과 패키지/서명이 다르며 앱 ID는 `kr.offline.hwp`입니다.

## 0.1.1 변경 사항

- 프로그램 이름을 `hwpxxx`로 확정하고 Android 앱 이름·설정·앱 정보·안내 문구에 반영했습니다.
- 사용자가 첨부한 H 수채화 로고를 Android 런처의 일반/적응형/원형 아이콘과 앱 정보 화면에 적용했습니다.
- 패키지 ID와 개인 서명키는 기존 0.1.0과 같습니다. 버전 코드는 2로 올려 기존 앱 위에 업데이트할 수 있도록 구성했습니다.
- `branding/`에는 원본 로고와 변환 이력을 보존했습니다.

## 설치와 시작

1. `hwpxxx-0.1.1.apk`를 Android 11 이상 기기에 설치합니다.
2. 문서함에서 새로고침을 누르면 파일 접근이 필요한 이유를 그림과 함께 보여줍니다.
3. ‘파일 접근 허용’을 누르고 Android 설정에서 이 앱의 모든 파일 접근을 켠 뒤 돌아옵니다.
4. 접근 가능한 내장 저장공간과 연결된 SD 카드의 HWP/HWPX 문서를 찾습니다. Android 보호 폴더·다른 앱의 전용 공간·클라우드 문서는 검색하지 않습니다.

## 구현한 기능

- HWP/HWPX 실제 파싱·페이지 렌더링과 첫 페이지 미리보기. 예시 문서로 목록을 채우지 않습니다.
- 이름 검색, 큰 지우기 버튼, 정렬, 한 버튼으로 미리보기/목록 전환, 문서함 상시 스크롤바.
- 별로 즐겨찾기 즉시 변경. 즐겨찾기와 새로고침 완료/중지 시 화면을 가리는 토스트 없음.
- 길게 누르기/더보기의 이름 변경·파일 이동·PDF 저장·파일 정보 네 항목.
- 실제 로컬 폴더 탐색, 상위/저장공간 이동, 현재 하위 폴더 검색·정렬, 새 폴더 만들기와 여기로 이동.
- 읽기 상단의 작은 연필 아이콘. 본문 터치 시 상단 페이드와 상단 여백 해제.
- 문서 전체의 두 손가락 확대(100~400%). 너비 맞춤을 100%로 사용. 별도의 배율 버튼 없음.
- 읽기/편집 중 오른쪽 빠른 세로 스크롤바. 스크롤 중 표시하고 잠시 뒤 사라짐.
- 본문/표 셀의 글자 삽입·수정·삭제, 문단 나누기·병합, 여러 문단 붙여넣기. 한글 조합이 끝난 후 반영. 외부 키보드 Ctrl+Z/Ctrl+Shift+Z 실행 취소/다시 실행.
- 편집 상단 취소/저장/다른 이름으로 저장. 입력 시 페이드, 본문 터치 시 다시 표시.
- 변경 없으면 저장 비활성화. 저장 시 ‘저장하시겠습니까? 아니오/예’. 다른 이름으로 저장은 항상 활성화하며 이름·폴더 지정.
- 다른 이름으로 저장은 원본을 보존하고 새 파일에서 편집을 계속함. 현재 버전은 같은 이름의 기존 파일 덮어쓰기를 차단하며 다른 이름/위치를 선택해야 함.
- 테마·즐겨찾기·검색/정렬/보기·읽던 위치와 배율을 기기 안에 기억함.

## 오프라인 구조와 원본 보존

- APK 선언 권한은 `MANAGE_EXTERNAL_STORAGE` 하나입니다. INTERNET·네트워크 상태·알림·부팅·오버레이·패키지 조회 권한이 없습니다.
- Android 서비스·수신기·콘텐츠 공급자·외부 문서/링크 열기·공유·앱 실행 기능이 없습니다. 외부로 여는 Intent는 사용자가 선택한 이 앱의 파일 접근 **Android 시스템 설정**뿐입니다.
- JS·WASM·아이콘·글꼴을 APK에 넣습니다. WebView는 네트워크 로드를 차단하고 `appassets.androidplatform.net`의 로컬 가상 주소만 메모리/내장 자산으로 응답합니다. 이 주소로 인터넷에 연결하지 않습니다.
- WebView 사용 통계 수집에 명시적으로 참여하지 않으며, 로컬 전용 화면에서 원격 Safe Browsing URL 검사를 비활성화했습니다. 다만 운영체제/WebView 자체의 충돌 진단 보고까지 앱이 완전히 통제한다고 보장하지 않습니다. 공식 설명: https://developer.android.com/develop/ui/views/layout/webapps/webview-privacy
- WebView의 file/content 접근·혼합 콘텐츠·다운로드·새 창·쿠키·추가 권한·외부 탐색을 차단합니다. 문서에서 만든 SVG는 허용 요소/참조만 남긴 뒤 독립 이미지로 렌더링합니다.
- 엔진은 별도 Web Worker에서 처리하며 오래 걸리는 작업은 종료합니다. 출력은 HWP와 HWPX 모두 엔진으로 재열기·전체 텍스트 비교·첫/끝 페이지 렌더링을 통과한 뒤 네이티브로 전달합니다. 이 검증이 모든 서식의 완전 보존을 보증하지는 않습니다.
- 원본 저장: 같은 폴더에 임시 기록 → fsync → 해시 비교 → 원본이 읽은 이후 바뀌지 않았는지 해시 확인 → 지원되는 파일시스템에서 원자적 교체. 원자적 교체가 불가능하면 덮어쓰기를 실패 처리하고 다른 이름 저장을 안내합니다. 원본부터 삭제하지 않습니다.
- 파일 이동: 새 위치에 완전한 파일을 기록·동기화·해시 확인한 뒤 원본을 다시 확인하고 삭제합니다. 이름 충돌은 덮어쓰지 않습니다. 원본 삭제에 실패하면 두 파일을 보존하고 안내합니다.
- HWPX 압축 항목·해제 크기·XML 크기/깊이 제한, DTD/외부 엔티티 차단과 경로 탈출/심볼릭 링크 차단을 적용합니다. 임의 문서 파서 취약점이 전부 없다는 의미는 아닙니다.
- 썸네일과 문서 바이트는 세션 메모리에서 처리합니다. 문서 본문을 브라우저 로컬 저장소에 저장하지 않습니다. 앱 백업은 비활성화했습니다.

## PDF 방식과 현재 한계

PDF는 SVG 페이지를 최대 약 1800px 폭의 이미지로 바꾼 뒤 Android `PdfDocument`로 기기 안에서 생성합니다. 시스템 인쇄 화면·인쇄 서비스·클라우드 공급자를 호출하지 않습니다. **이미지 PDF이므로 PDF 안의 글자 검색/선택은 지원하지 않습니다.** 원래 페이지 비율과 크기를 사용합니다.

- 문서 입력/저장 최대 32MiB, HWPX 해제 누적 128MiB, 문서 500페이지, PDF 100페이지. 복잡한 그림은 개별 한도를 적용합니다.
- 글꼴/표/그림/수식 등 복잡한 문서의 렌더링과 저장 호환성은 rhwp의 지원 범위에 따릅니다. 별도 글꼴·서식·표 구조 편집 도구, 암호 입력 문서 열기, 교차 문단 전체 선택 편집은 제공하지 않습니다.
- 앱이 강제 종료되면 미저장 편집 내용은 복구되지 않습니다. 기록 도중 프로세스가 강제 종료되는 특수 상황에는 원래 폴더에 숨김 임시 파일이 남을 수 있습니다.
- 실제 Android 기기/에뮬레이터에 설치해 실행하는 시험은 이 환경에서 수행하지 않았습니다. Android 권한 설정, 시스템 키보드 조합, WebView 버전, SD 카드 연결/분리, 실제 PDF 파일 열기와 제스처는 실기기 확인이 필요합니다. 초기 개인 테스트 빌드이며 완전 검증된 배포본으로 표시하지 않습니다.

## 검증 결과

- JDK 17 + Android SDK 35/build-tools 35.0.0으로 Java/Dex/APK 빌드 및 APK 서명 검증.
- `FileStoreTest`: JVM에서 정상 HWP/HWPX, 잘못된 문서/XML/외부 엔티티/깊이, 경로 탈출·심볼릭 링크·금지 폴더, 이름 검증, 중복 충돌, 변경된 원본, 실패 시 원본 보존과 이동을 시험.
- Chromium 133에서 **실제 WASM과 실제 HWP/HWPX 파일**로 파싱·썸네일·텍스트/표 편집·문단 나누기/병합·붙여넣기·이모지·실행 취소·저장 재열기 검증을 시험.
- 검색/보기/즐겨찾기/폴더 생성·이동·이름 변경/저장 확인/PDF 페이지 이미지 전송, 두 손가락 이벤트의 확대 계산·100% 하한, 320/390/736px 화면을 시험. JS 오류와 외부 요청 0건.
- 브라우저 UI 시험의 Android 브리지는 테스트용 대역입니다. 실제 파일 처리 코드는 별도 JVM 시험을 했습니다. PDF의 페이지 이미지 생성/전송은 시험했으나 Android PdfDocument의 실제 출력은 실기기 시험 미수행입니다.

## 소스와 빌드

구조:

- `app/src/main/java/kr/offline/hwp/MainActivity.java`: 저장공간·로컬 WebView·메시지 브리지·문서 검색·PDF.
- `app/src/main/java/kr/offline/hwp/FileStore.java`: 경로/문서 검사, 안전한 쓰기·이동·폴더 생성.
- `app/src/main/assets/app.js`: 실제 앱 UI. `engine-worker.js`: rhwp 처리와 저장 결과 재검증.
- `app/src/main/assets/engine/`: 공식 npm `@rhwp/core` 0.8.7. `ENGINE_PROVENANCE.json`에 배포 무결성 정보.
- `tests/`: 파일 처리/브라우저 시험. `TEST_RESULTS/`에 이번 시험 결과.

Android Studio에서 프로젝트 폴더를 열어 빌드하거나, JDK 17 및 Android SDK platform 35/build-tools 35.0.0이 설치된 Linux에서:

```bash
export ANDROID_SDK_ROOT=/absolute/path/to/android-sdk
bash build.sh
```

기본은 개발 서명입니다. 제공 APK와 동일한 서명으로 재빌드할 때에는 별도 개인 서명 백업에 포함된 키를 사용합니다. 개인 서명키/암호는 소스 ZIP에 포함하지 않았습니다.

```bash
export HWP_KEYSTORE=/absolute/path/to/offline-hwp.keystore
export HWP_KEY_ALIAS=hwp
read -rs HWP_KEY_PASSWORD
export HWP_KEY_PASSWORD
bash build.sh
unset HWP_KEY_PASSWORD
```

새 서명으로 설치한 APK는 기존 설치본 위에 업데이트할 수 없습니다. 기존 설치본 삭제 시 앱의 즐겨찾기·설정·읽던 위치가 지워집니다. 기기 문서는 앱 전용 저장소 밖에 있으므로 앱 삭제 대상으로 처리하지 않습니다.

검증 재실행:

```bash
mkdir -p build/unit
java -m jdk.compiler/com.sun.tools.javac.Main -encoding UTF-8 -d build/unit app/src/main/java/kr/offline/hwp/FileStore.java tests/FileStoreTest.java
java -cp build/unit kr.offline.hwp.FileStoreTest tests/fixtures/문서.hwp tests/fixtures/문서.hwpx
# Node + playwright + @sparticuz/chromium이 준비된 환경
node tests/ui.cjs
```

## 라이선스와 출처

- rhwp 0.8.7: https://github.com/edwardkim/rhwp (MIT). 원문 `app/src/main/assets/engine/LICENSE` 보존.
- Lucide: https://lucide.dev (ISC 및 포함된 Feather MIT 고지). 원문 `LUCIDE-LICENSE.txt` 보존.
- Noto Sans KR: SIL OFL 1.1. 원문 `fonts/NotoSansKR-OFL.txt` 보존.
- 빈 문서 테스트 자료의 기준: rhwp v0.8.7의 `template/blank-malgun.hwp`, `saved/blank_hwpx.hwpx`. 실제 테스트 문장·표는 로컬에서 생성했습니다. 사용자 문서는 소스/시험 자료에 포함하지 않았습니다.

원본 의심 APK와 기존 분석 보고서는 이번 APK/소스에 포함하지 않았습니다. 원본 APK에 대한 과거 분석 결과는 이 별도 앱의 실기기 검증 결과로 전환하지 않습니다.
