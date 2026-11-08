# DeX 편집기 검증 기록 — 2026-11-08

이 변경은 Hwpxxx 데스크톱 1.6.1의 실제 Studio 프런트엔드를 Android 기본 편집기로 사용합니다. 데스크톱 upstream 커밋과 11개 PC 패치, 12개 Android 패치는 `config/android-studio.json`의 SHA-256으로 고정합니다. 생성한 Studio/WASM/APK는 소스 커밋에 포함하지 않습니다.

## 실행 결과

| 범위 | 결과 | 실제로 실행한 경계 |
|---|---|---|
| Studio 빌드 | TypeScript·Vite·자산 해시 검증 통과, 런타임 60개 파일 | 고정 소스로 생성한 실제 생산용 번들 |
| Android 전용 Studio 단위 검사 | 138/138 통과 | 호스트·복구·저장 보호·이력·필드·글꼴 선택 |
| Node 회귀 검사 | 107/107 통과 | 엔진·편집 작업자·글꼴 공급자·ANR/Termux 하니스·Studio 빌드 경계; 새 패치 고정 후 빌드 검사 20개 재확인 |
| 실제 편집기 UI | 29/29 시나리오 통과, 건너뛴 항목 없음 | 실제 Studio·WASM·호스트 JS·키보드/마우스 이벤트, Android 네이티브 브리지는 모형 |
| 마지막 글꼴 창 초점 수정 | 영향받는 UI 2/2 재검 통과 | 문서를 다시 클릭하는 우회 없이 글꼴 창 종료 후 Ctrl+O |
| 실제 호스트 프로토콜 | 39/39 통과 | 실제 `studio-host.js` + 모형 Studio/OfflineNative, 마우스·키보드 초점 복귀 포함 |
| 최소 호스트 smoke | 41/41 통과 | 실제 번들 + 별도 작은 STUB 호스트, CSP·오프라인·PNG 인쇄·암호 저장/복구·이력/최근 문서 |
| 저장 중 문서 전환 | 9/9 통과 | 이전 문서 저장의 늦은 응답이 현재 문서 이름·저장 대상을 바꾸지 않음; 보호를 제거한 시험 사본에서는 4개가 실패 |
| JVM 저장소/호스트 검사 | 584개 검사문 통과 | 파일·백업·초안·내보내기·글꼴·암호화 이력·인텐트·클립보드·제공자 제한 시간·취소 토큰·연결 ID |
| APK | debug/release 조립·release lint 통과 | debug APK 서명 및 내부 자산 일치 별도 확인, release는 서명 설정이 없으면 unsigned |

명령 등록은 데스크톱 목록 **168개 전부**가 Android 번들에 있는 것을 확인했습니다. 이는 등록 확인이며, 168개 명령 모두를 기기에서 동작 시험했다는 뜻은 아닙니다.

## 주요 동작의 근거

- 실제 키 입력·선택·굵게·실행 취소/다시 실행·저장 후, 별도 WASM 인스턴스로 결과 파일을 다시 열어 글자와 서식을 확인했습니다. 원본 백업과 외부 변경 충돌도 확인했습니다.
- 표·메모·쪽 번호 머리말·다른 이름 저장·HWP/HWPX 변환·이미지 삽입·클립보드·복구·이력·최근 문서·창 크기/배율을 실제 UI로 시험했습니다.
- 가져온 글꼴이 도구 모음의 시스템/모든 글꼴 및 글자 모양에 나타나고, 선택 후 실제 화면과 저장 파일에 반영됩니다. 통제한 두 문단의 글자 픽셀 폭은 `[69, 300]`에서 `[191, 191]`로 바뀌어, 별도 페이지에서 같은 SFNT 바이트로 측정한 고정폭 비율 `1.0`과 일치했습니다. 저장 후 별도 인스턴스로 다시 연 두 문단 모두 선택한 글꼴 이름을 유지했습니다.
- Regular/Bold TTF, CFF OTF와 한국어 TTF는 별도 Canvas2D/CanvasKit 렌더러 시험에서 실제 글꼴 바이트·픽셀·폭·삭제 후 무효화를 확인했습니다.
- 쪽 번호 머리말은 HWP와 HWPX로 저장한 뒤 각각 별도로 다시 열어 XML의 `autoNum numType=PAGE`를 확인했습니다. 필드 검증 61개는 현재 쪽 번호와 전체 쪽 수가 모두 `1`로 보이는 경우도 구분하며, 필드 종류·순서·글 내용의 변경/손실을 거절합니다.
- 암호 저장/복구 결과는 비밀번호 없이 엔진이 열기를 거절하고, 올바른 비밀번호로 열리는 실제 암호화 문서 바이트입니다. 암호 문서 이력은 세션 메모리만 사용합니다.

## 재현

엔진과 Studio를 README의 고정 소스로 먼저 빌드합니다. JDK 17, Android SDK 35, 최신 Node.js 22 이상, Python Playwright/Chromium 및 시험용 재배포 가능 글꼴이 필요합니다. `.github/workflows/android.yml`에 빌드와 각 검사 명령이 들어 있습니다.

```sh
node scripts/verify-engine.mjs
node scripts/verify-studio.mjs
node --test tests/studio-build.test.mjs
node --test tests/android-fonts.test.mjs tests/studio-host.test.mjs
python tests/studio-ui.py
STUDIO_SMOKE_REQUIRE_FINAL=1 python tests/studio-smoke.py
bash gradlew assembleDebug assembleRelease lintRelease --no-daemon
```

## 확인 범위의 한계

브라우저 시험의 Android 경계는 모형입니다. 실제 Samsung DeX·Android WebView·Samsung IME·블루투스 키보드/마우스·SAF 제공자·시스템 클립보드·PrintManager·AndroidKeystore의 기기 실행은 이 클라우드 환경에서 확인하지 못했습니다. GitHub Actions 자체의 실행 결과도 이 기록에 포함하지 않습니다.

파일·글꼴·검증 크기 제한과 암호 문서 이력의 세션 한정 동작은 [사용 안내](DEX-DESKTOP-PARITY.md), 글꼴 형식과 보관 방식은 [글꼴 안내](ANDROID-FONTS.md)에 기록했습니다. 매우 느린 저장이 페이지의 60초 응답 제한 뒤 완료되면, 다음 저장에서 원본 해시 충돌을 표시할 수 있어 새 복사본 저장이 필요합니다.
