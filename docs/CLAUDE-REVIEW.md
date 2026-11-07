# Claude 코드 리뷰 기록 (PR #2)

이 문서는 실제 Claude CLI 실행과 그 처리를 기록합니다. **네 번째 Opus·high 재리뷰는 N1·N2·실행 취소 이력 수정을 해결로 확인했고, 새 P0·P1·P2는 없다고 판정했습니다.** 낮은 우선순위 P3 메모 3건은 아래 후속 기록에 남깁니다. 이는 코드 리뷰 결과이며 PR 승인이 아닙니다. 설치 APK·공식 Termux·최종 커밋 CI·실기기·한컴 검증은 아직 완료되지 않았습니다. 모델 effort의 근거는 실제 CLI `--effort high` 수락과 init의 `per_turn_effort_active: true`이며, 모델이 실행 중 내부 설정을 직접 확인했다고 주장하지 않습니다.

## 1. 실행 기록

| 단계 | 모델 / 추론 수준 | 형태 | 결과 |
|---|---|---|---|
| 초기 리뷰 | `claude-opus-5-5` (관측값) / `--effort high` | 별도 CLI 비대화형 실행, 읽기 전용(Read/Glob/Grep만, 편집·명령·외부 요청 없음, 권한 모드 `dontAsk`), CLI 2.1.318, 39턴, 약 622초, 권한 거부 0건 | 부록 A에 원문 그대로. 응답 SHA-256(끝 줄바꿈 제외) `ccb9443c62ec622dce3b6fdceed1cb1cb666a24eb3469ba6d7ae3e4d48e09b27` |
| 구현 | `claude-sonnet-5-5` / high | 별도 CLI 실행(139턴, 권한 거부 0건) | 여러 문단 선택, 복구 초안, 암호 PDF, Termux 제공자 시간 제한 등(`docs/PARITY-AUDIT.md`) |
| 리뷰 수정 1 (초기 지적 F1~F18·H1~H7) | `claude-sonnet-5-5` / high | 별도 CLI 실행(`acceptEdits`, 129턴, 약 1,715초, 권한 거부 0건) | §2-A 처리표. 다른 CLI/하위 에이전트를 시작하지 않았고 Opus로 전환하지 않았습니다. **5시간 사용량 한도(07:40 UTC 초기화)에 걸려 중단됐고 `is_error: true`였습니다.** 마지막으로 하던 F17(메모 쪽 나누기·버튼·문서) 변경은 중단 시점에 검증되지 않은 상태였고, 이후 루트가 고정된 소스로 검사를 다시 돌렸습니다(아래 행). |
| 루트의 중단 후 기준 검사 | (CLI 아님, 셸 명령) | 쿼터 중단 뒤 고정된 작업 트리 | 엔진 검증, 고정 자료, 합친 Node 시험 **63 통과 / 0 실패 / 0 건너뜀**, 구문 검사, JVM `FileStoreTest` 53 · `TermuxWalkerTest` 30 · `DraftStoreTest` 38, 모두 종료 코드 0(`checks-astra-review-baseline/`). 이 시험들은 아래 새 지적(F-A~F-G)을 **잡지 못했습니다**. 브라우저 3종·전체 Gradle 빌드는 마지막 F17·버튼 변경 전의 통과 기록뿐이라 최종 반복이 필요했습니다. |
| 임시 Astra 전용 감사(사용자 승인) | `gpt-6-astra` / high, 읽기 전용 하위 에이전트 | 한국 시간 17:00까지 Astra만 쓰도록 사용자가 임시로 요청한 구간 | **Opus 리뷰가 아닙니다.** 격리된 재현(`pr2-task/astra-repro/`)으로 §2-B의 F-A·F-B(Astra는 P1로 평가)·F-C·F-D·F-E·F-F와 같은 6건을 보고했고 **소스는 수정하지 않았습니다**(종료 보고서 없이 사용자가 Opus 복귀를 요청해 완료된 최종 감사가 아님). 이 6건은 아래 실제 Opus 리뷰가 코드로 다시 확인했습니다. |
| 두 번째 Opus 리뷰(현재 작업 트리 전체 diff) | `claude-opus-5-5`(관측값) / `--effort high`(CLI가 옵션을 수락, init의 `per_turn_effort_active: true`) | 별도 CLI 비대화형 실행, 읽기 전용(Read/Glob/Grep만, 권한 모드 `dontAsk`), CLI 2.1.318, 36턴, 약 455초, 권한 거부 0건 | **승인하지 않음**: 확인된 P1 1건(F-A), P2 6건(F-B~F-G), P0 없음. 입력: 기준 `main` `499477990e1c23f71f4df465a26a2d448c5d564c`, 대상 `codex/android-dex-termux-pr2` `5986d59…` + 당시 작업 트리 전체(추적·미추적 모두, 전체 diff SHA-256 `2ddd76c6…2a63`, Rust 패치 4,275줄 전부 포함). 응답 SHA-256(끝 줄바꿈 제외) `9a43399a0caf9749ec68ddfdb0d2293896a62473eb865925b27ba27fb0b303f4`, 원문은 부록 B. 리뷰어 자신은 응답 안에서 실행 중 effort 값을 볼 수 없다고 적었으며 이 문서도 그 값을 확인했다고 주장하지 않습니다. |
| 루트의 추가 관찰(Opus 지적 아님) | — | `TimedCall.giveUp`의 DELIVERED 경쟁 분기 | 값이 도착한 순간 호출자가 포기하면 `stranded` 값의 폐기가 `cancel` 콜백 **뒤에** 같은 정리 작업 안에서 실행돼, 취소가 영원히 막히면 닫히지 않고 정리 풀이 가득 차면 작업 전체(폐기 포함)가 버려졌음. Sonnet·high가 소스로 확인(§2-B F-E 후속)하고 소유권 구조를 바꿨습니다. |
| 환경 사실(APK 이전) | — | 루트가 API 33 소프트웨어 AVD에서 `tests/android-system.cjs check()`를 **어떤 APK도 설치하기 전에** 실행 | 종료 코드 1, `unknown-anr package system`. 증거 `pr2-task/emulator-before-apk-anr/report.md`, `guard-evidence/`. 아무것도 닫지 않음. **환경 실패이며 APK 통과·제품 결함·CI 통과가 아닙니다.** |
| 두 번째 리뷰의 수정 | `claude-sonnet-5-5` / high | 별도 CLI 실행(지속 세션) | §2-B. 다른 CLI·하위 에이전트·다른 모델을 쓰지 않았고 Opus로 전환하지 않았습니다. 커밋·푸시·스테이징 없음. |
| 엔진 빌드·에뮬레이터 준비 | `claude-haiku-5-5` / low | 별도 실행 | 고정 툴체인으로 엔진 빌드(`build-info.json` 생성), 에뮬레이터 부팅 시도 |
| 수정 뒤 Opus 전체 재리뷰(세 번째 리뷰) | `claude-opus-5-5`(관측값) / `--effort high`(CLI 수락, init `per_turn_effort_active: true`) | 별도 CLI 비대화형 실행, 읽기 전용(Read/Glob/Grep, `dontAsk`), CLI 2.1.318, 16턴, 약 340초, 권한 거부 0건, 대상: 기준 `4994779…` + `5986d59…` + 당시 작업 트리(diff SHA-256 `711f6478…e4`), Rust 패치 4,275줄 전부 다시 읽음 | **승인하지 않음**: P0·P1 없음(F-A 해결 확인), F-A~F-F 해결, F-G 대부분 해결, **새 P2 N1·N2**와 가벼운 메모 3건. 응답 SHA-256(끝 줄바꿈 제외) `11959e9a79edd7c8c6b0909a8c1b740b39c6a90b2bade4a832ee8a0956a08a2e`, 원문은 부록 C. 리뷰어는 실행 중 effort 값을 볼 수 없다고 적었으며 이 문서도 확인했다고 주장하지 않습니다. 리뷰어는 로그를 읽었을 뿐 시험을 실행하지 않았고 변형 시험 보고는 '주장'으로만 받아들였다고 밝혔습니다. |
| N1·N2·메모 수정 | `claude-sonnet-5-5` / high | 별도 CLI 실행(지속 세션) | §2-C. 다른 모델·에이전트 없음, 커밋·푸시 없음. |

초기 리뷰 입력: 고정된 원본 PR #2 커밋 `5986d5981be91aaad5085116a0fd1f3bf3df1b74`의 전체 diff와 `git archive` 스냅샷(기준 `499477990e1c23f71f4df465a26a2d448c5d564c`). 이후의 수정은 보지 않았습니다. 응답 원문 파일의 SHA-256은 저장 시 붙은 끝 줄바꿈 때문에 위 값과 다르고(`954f9038…`) 본문은 같습니다.

**초기 리뷰가 다루지 않은 것과 그 이후:**
- Rust 패치 줄 단위 검토: 두 번째 Opus 리뷰가 4,275줄 전부를 읽었고 Android 앱에 영향을 주는 추가 결함을 찾지 못했습니다(§4 요약은 부록 B). 리뷰어가 PC 패치와 바이트 비교는 하지 않았다고 밝혔습니다(줄 수와 일부 구간 비교).
- 여러 문단 선택·복구 초안·Termux 순회기 등 초기 리뷰 이후의 코드: 두 번째 리뷰가 봤습니다. 그 결과가 §2-B의 7건입니다.
- 실제 기기·Samsung DeX/IME·Bluetooth, 한컴에서의 재열기, CI 산출물(화면·`results.json`·logcat)은 여전히 범위 밖이고 **미검증**입니다. GitHub API가 정책으로 차단돼(`api.github.com` CONNECT 403) 현재 소스의 CI 실행이 없습니다.

## 2-A. 초기 리뷰(F1~F18, H1~H7) 항목별 처리

상태 표기: **이미 수정됨**(구현 단계에서) · **확인·수정**(이 실행에서 재현 또는 코드로 확인하고 수정) · **반증/재현 안 됨**(의미 있는 재현 시도에도 결함이 나오지 않음; 코드 변경 없음 또는 방어만) · **미해결**(구체적 사유). "시험"의 통과는 이 환경(KVM 없음, 기기 없음)에서 실제로 실행한 것만 적었고, 설치 APK 시나리오는 작성만 했을 뿐 **실행하지 않았습니다**.

| # | 우선순위 | 상태 | 근거와 변경 | 시험 |
|---|---|---|---|---|
| F1 | P1 | **확인·수정** | 메모 이동이 `guarded`를 거치지 않아 대기 중 입력이 사라지는 것을 재현(되돌린 변형 코드에서 `review-ui.py`가 `pending text was lost` 로 실패). `memo-jump`를 `guarded`로 감싸 먼저 입력을 확정하고, 조합 중이면 이동을 거절하며(글자·편집기 유지) 바쁜 동안은 무시합니다. 메모 마크·상자·패널 버튼은 바쁜 동안 `disabled`. 조합 플래그가 사라진 입력칸에 남지 않도록 `placeEditor`/`placeRange`에서 초기화. | `tests/review-ui.py`(실제 Worker·페이지: 대기 입력, 조합 중, 재조합 후 이동, 메모 상자 클릭), `tests/android-emulator.cjs` 시나리오(실제 WebView·저장 파일 재열기; **미실행**) |
| F2 | P1 | **확인·수정** | `recoverSystemAnr`가 `waitForWindow`/`uiNodes`에서만 호출되고 최종 검사가 crash 버퍼뿐이어서 CDP만 쓰는 시나리오의 앱 ANR을 놓치는 것을 코드로 확인. 새 `createGuard`(`tests/android-system.cjs`)와 순수 파서(`tests/android-anr-parse.cjs`): 시나리오마다·모든 Back 키 전·종료 시 포커스와 logcat(events `am_anr`, main/system `ANR in`, crash) 검사, 3초 백그라운드 감시, 앱·Termux·DocumentsUI·Google 서비스 등 System UI/Pixel Launcher 외 ANR과 오류 대화상자는 대화상자를 건드리지 않고 실패(원래 포커스·XML·PNG·logcat 보관, `anr-failures.json`), `android-suites.cjs`가 기록된 실패를 실행 실패로 처리. Termux 시험에도 crash/ANR 검사 추가. System UI/Pixel Launcher 복구는 그대로 최대 4회, 포커스 패키지와 대화상자 글이 일치할 때만. | `tests/android-anr.test.mjs` 18건(실제 형식의 `dumpsys window`·uiautomator·logcat 표본과 가짜 adb로 전체 판단 흐름: CDP 전용 시나리오의 앱 ANR 실패·증거 보관·무입력, 알 수 없는 ANR·충돌 창, 4회 한도, 불일치·오래된 제목, 로그만 남은 ANR, 감시 스레드, Back 차단, 종료 단계, 초기화, 시험 묶음 연결). 설치 APK 통합은 **미실행**. |
| F3 | P2 | **확인·수정**(F-C·F-D에서 다시 다듬음) | 깊이 한도가 `limited`를 켜 검색 전체가 한도로 표시되던 것(첫 구현에서 중단은 막았으나 표시는 남음)을, 깊은 폴더는 `skipped`로 세고 `limited`는 문서·항목·폴더·대기열·시간 한도 전용으로 정리. 깊은 가지 뒤의 형제도 찾음. | `TermuxWalkerTest` 30건(깊이·형제·완전성), 변형 코드로 실패 확인 |
| F4 | P2 | **이미 수정됨**(구현 단계) | 검색 시작 때 `refs.clear()`를 하지 않고, 완전히 끝난 검색(`complete()`: 한도·건너뜀·취소 없음)에서만 보이지 않은 참조를 정리. 이번에 `complete()`를 명시하고 깊이 건너뜀도 불완전으로 취급. 두 번째 리뷰: 같은 목록을 가진 폴더를 별칭으로 건너뛰고도 `complete()`가 참이어서 이 보호가 무력화됨(F-D) → 건너뛴 별칭도 `skipped`로 세어 불완전 처리. | `complete()`는 JVM 시험. `TermuxFolders`의 참조 맵 자체는 Android 의존이라 단위 시험 없음(컴파일 확인) |
| F5 | P2 | **확인·수정** | 공유 저장공간 한도에 걸리면 Termux를 아예 검색하지 않던 구조를 바꿔 연결 폴더를 먼저(몫 5,000개) 찾고 나머지를 공유 저장공간에 줍니다. 폴더별 공정 몫(`fairShare`). 두 번째 리뷰: 폴더 하나가 자기 몫에 닿으면 뒤의 폴더가 전부 검색되지 않는 새 결함(F-C) → 수정. | 몫 계산·공정성 JVM 시험. 1만 개 파일 기기에서의 순서는 **미검증**(컴파일 확인) |
| F6 | P2 | **이미 수정됨**(구현 단계) | 연결 검증 실패 시 `finally`에서 영구 권한을 되돌려 줌(이미 저장된 폴더는 유지). | Android API 의존: 단위 시험 없음, **미실행**(APK 시험 없음) |
| F7 | P2 | **일부 이미 수정, 나머지 확인·수정** | 구현 단계: 제공자 호출 제한 시간·취소, JS 시간 초과 때 `cancelScan`. 이번: 검색을 별도 스레드(`scanner`)로 옮겨 상태·열기·저장·연결·해제가 검색 뒤에 줄서지 않게 하고, 검색마다 자기 중지 플래그, Termux 검색의 진행 알림, 150초 총 시간 예산. | 시간·진행 JVM 시험. 스레드 분리는 컴파일 확인, 기기 시험 **미실행** |
| F8 | P2 | **확인·수정** | 모든 파일 접근 회수 후 Termux 연결로 `permission`이 참이라 공유 문서가 남는 것을 재현(변형 코드에서 실패). 회수를 감지하면 진행 중 검색을 취소하고 공유 문서·썸네일을 지우고 연결 폴더만 다시 검색, 늦게 도착한 공유 `scanBatch`는 무시. 실제 Android는 권한 회수 때 프로세스를 종료하는 경우가 많아 이 경로는 프로세스가 살아남을 때만 쓰입니다. | `tests/review-ui.py`(시험용 Termux 가짜 브리지; Termux 동작의 근거 아님) |
| F9 | P2 | **확인·수정** | 두 손가락 확대가 100% 미만을 막던 것을 재현(변형 코드에서 `pinch minimum 100`). 한 곳(`clampZoom`: 50~400)으로 통일. | `tests/editor-features.test.mjs`, `review-ui.py`(실제 터치 이벤트로 최소·최대, 50%에서 100%로 튀지 않음) |
| F10 | P2 | **확인·수정** | 구역 끝의 앞으로 지우기가 엔진 오류 `첫 번째 문단은 병합할 수 없습니다`를 내는 것을 두 구역 문서로 재현. 다음 구역이면 아무 일도 하지 않음. | `tests/editor-worker.test.mjs`(`tests/fixtures/two-sections.hwpx`) |
| F11 | P2 | **확인·수정** | 입력칸에서 Ctrl+Z가 문서 실행 취소로 동작함을 재현(변형 코드에서 실패). 입력칸·선택칸에서는 Ctrl+S/Ctrl+Shift+S, Esc, 칸 자체의 Enter만 앱 명령. | `review-ui.py` |
| F12 | P2 | **확인·수정** | 조합 중 `ArrowRight`가 문단 이동을 하는 코드를 합성 조합 이벤트로 재현(변형 코드에서 실패). `isComposing`/`keyCode 229`/조합 플래그 확인. 실제 Samsung IME가 어떤 키 이벤트를 보내는지는 **미검증**. | `review-ui.py` |
| F13 | P2 | **확인·수정**(코드 근거; 시험 결함은 두 번째 리뷰의 F-F로 수정) | 앱이 재생성된 뒤 폴더 선택 결과가 `id<0`이라 버려지던 것을, 연결은 하고 `foldersChanged`로 알리도록 변경. | `tests/android-termux.cjs` 시나리오(`am kill`로 폴더 선택 화면이 열린 채 프로세스 종료; 실제 DocumentsUI; **미실행**) |
| F14 | P2 | **확인·수정** | 새 실행은 이전 복구 기록·증거를 지우고, 대화상자 글이 포커스 창의 패키지와 일치해야 하며, 탭 뒤 `N.after.png`도 저장. 두 시험 묶음은 한 기록을 공유(`ANDROID_ANR_KEEP`). | `android-anr.test.mjs`(불일치·초기화·4회 한도) |
| F15 | P2 | **확인·수정** | 새 `scripts/verify-engine.mjs`: `build-info.json` 필수, 고정 값(`config/android-engine.json`) 전부 일치, 패치 SHA, `rhwp.js`/`rhwp_bg.wasm`/`rhwp.d.ts`의 실제 SHA-256과 기록 일치, 메모 API 이름, WebAssembly 머리말. Gradle `verifyMemoEngine`이 매 빌드 전에 실행(끄는 스위치 없음), `install-engine.mjs`도 설치 후 같은 검사, CI에도 별도 단계. CI·`build-engine.sh` 고정 값이 잠금과 같은지도 검사. | `tests/engine-integrity.test.mjs` 10건(변조·낡은 바이너리·낡은 glue·다른 커밋·변조된 패치·누락). 실제 Gradle로 변조/누락 시 `verifyMemoEngine`이 실패하는 것을 실행(`logs/gradle-gate-negative.log`) |
| F16 | P2 | **확인·수정** | `patches/rhwp-engine/README.md`의 PC(Windows/MinGW/wasm-pack) 절차를 이 저장소의 `scripts/build-engine.sh`·`config/android-engine.json` 기준 Android 절차로 교체(고정 값 표, 새로 받은 체크아웃 필요 설명). | — |
| F17 | P2 | **확인(실측)·부분 수정** | 실측: 메모 20개 약 110 ms, 200개 약 1.1 s(데스크톱 Node, 메모 사각형 계산 ≈5.5 ms/개) — 입력이 확정될 때마다 반복되면 실제로 지연. 그러나 글을 고치면 메모 위치가 바뀌므로 갱신을 없애지 않았습니다(낡은 표시는 잘못). 대신: ① 메모 없는 문서는 엔진 응답의 `memoCount===0`이면 건너뜀(입력으로는 메모가 생기지 않음), ② 입력 확정은 입력이 멈춘 뒤(450 ms)로 미루고 다른 모든 명령·메모 패널 열기는 즉시 갱신, ③ 메모를 25개씩 나눠 가져와 편집이 사이에 끼어들게 함(워커가 길게 막히지 않음), ④ 늦게 그려지는 페이지는 그 페이지의 마크만 다시 그림. 입력 중 잠깐(최대 약 0.5초+조회 시간) 마크가 이전 위치일 수 있음(표시만, 저장 데이터 아님). | `editor-worker.test.mjs`(`memoCount`, 쪽 나누기 내용 동일), `review-ui.py`(입력 후 마크 재그림). 휴대폰에서의 실제 지연은 **미측정** |
| F18 | P2 | **확인·수정**(액션 태그 고정은 하지 않음) | `scripts/fetch-termux-qa.sh`가 저장소에 고정한 SHA-256 `3550e61f…7144`로 검증하고, 같은 릴리스의 체크섬 파일에 정확히 같은 줄이 있는지도 확인(`--ignore-missing` 제거). 값은 임의로 만들지 않고 2026-11-07에 github.com/termux/termux-app 릴리스의 체크섬 파일(HTTPS)과 직접 내려받은 x86_64 APK의 실제 SHA-256이 같은 것을 확인한 뒤 고정. GitHub Actions의 태그 → SHA 고정은 불필요한 변경이라 하지 않음(선택 사항). | 스크립트를 실제로 실행해 통과 확인 |
| H1 | 가설(P1 가능) | **완화 — 실제 제공자 확인 미실행** | 순환/별칭/대용량 폴더 방어(F-D로 재설계: 조상과 목록이 같은 폴더는 아래 폴더들도 3단계 같을 때만 별칭, 건너뜀은 불완전로 기록, 같은 목록의 진짜 중첩 폴더는 모두 검색. §2-B 참고)(복사본 형제는 구별), 점 폴더·`node_modules`·`__pycache__`·홈의 `storage` 제외, 시간·몫 예산. 제공자가 링크를 폴더로 보고 링크 경로를 ID로 쓴다는 것은 리뷰의 가정이며, 실제 Termux로는 확인하지 못했습니다(그래서 위 방어는 가정에 맞춘 것이고, 가정이 틀리면 추가 검색 시간 외의 해는 없습니다). 형제로 향하는 링크의 중복은 못 막음(문서화). | JVM 시험(가짜 제공자). 실제 `ln -s` 함정 4종(순환 링크, node_modules, 점 폴더, 70단계)을 `android-termux.cjs`에 추가(**미실행**) |
| H2 | 가설(P1 가능) | **반증(재현 안 됨)** | HWP·HWPX에서 정렬·간격·글머리표·줄 간격·모양 복사(`scope:'para'`)를 하고 내보낸 뒤 다시 열어도 저장이 거부되지 않음. 24개 `PARA_KEYS` 비교는 약화하지 않고 유지. 한계: 번호 매기기가 있는 실제 한컴 문서는 시험 자료가 없어 미확인. | `editor-worker.test.mjs` H2(hwp, hwpx) |
| H3 | 가설(P2) | **반증(재현 안 됨)** | 이모지(UTF-16 두 단위)·탭이 앞에 있어도 메모 앵커 글자가 맞고 저장·재열기 후, `memoSelect`의 UTF-16 범위 변환도 맞음. 한계: 같은 문단에서 표/그림 개체 앞의 앵커는 시험하지 않음. | `editor-worker.test.mjs` H3(hwp, hwpx) |
| H4 | 가설(P2) | **미해결(기기 필요) — 안전한 보정 구현** | WebView 글자 배율이 편집 입력칸의 px 글자에 영향을 주는지는 이 환경에서 확인하지 못했습니다. 100px 시험 요소로 배율(글자·줄 높이)을 측정해 영향이 있을 때만 나누고, 없으면 1이라 어느 경우에도 안전합니다. | 순수 계산 시험. APK 시나리오(1.0 대 1.5 배율에서 입력칸의 시각 크기가 같은지, 측정값을 `results.json`에 기록; **미실행**) |
| H5 | 가설(P2) | **재현 안 됨 — 방어만 유지** | 메모 상자·마크를 누를 때의 페이지 탭 판정을 제거한 변형 코드에서도 오류 창이 없고 앵커가 선택됨(경쟁은 메모 이동이 이김). 불필요한 엔진 조회와 터치의 메뉴 전환을 없애는 방어(`.memo-mark,.memo-box`는 탭 대상 제외)는 남김. | `review-ui.py` |
| H6 | 가설(P2) | **반증(재현 안 됨), 서명 약함은 의도적으로 유지** | 암호 HWP/HWPX에 메모를 달고 암호 저장·재열기해도 메모 글·작성자·앵커 글자가 유지됨. `memoSignature`는 작성자·내용 순서만 비교하며 앵커 위치까지 비교하면 실제 문서에서 정상 저장이 거부될 위험이 있어 바꾸지 않음(문서화). | `editor-worker.test.mjs` H6(hwp, hwpx) |
| H7 | 가설 | **확인·정리** | `git ls-files --stage`로 `app/src/main/assets/engine/.rhwp_bg.wasm.my6jCi`(blob `cd544c15…`, 10,223,616바이트)가 첫 가져오기 커밋 `893d20d`부터 main에서 추적됨을 확인(압축 해제 부산물이 아님). 코드 어디서도 참조하지 않고 점 파일이라 APK에 들어가지 않음(빌드한 APK의 `assets/engine/` 목록으로 확인). 작업 트리에서 삭제하고 `.gitignore`에 같은 패턴 추가. **Git 기록은 다시 쓰지 않으며** 기록에는 계속 남음. 커밋할 때 이 삭제는 별도 위생 변경으로 보입니다. | APK 목록 확인 |

## 2-B. 두 번째 Opus·high 리뷰(F-A~F-G)의 처리 — Sonnet·high 수정, **Opus 재리뷰 대기**

각 항목에서 "시험"은 수정 전 코드로 되돌려(변형) 실제로 실패하는 것을 확인한 뒤 복구한 것만 변형 확인으로 적었습니다. 설치 APK·실제 Termux·실제 기기·한컴에서는 실행하지 않았습니다.

| # | 우선순위 | 상태 | 원인 증명 → 수정 | 시험 |
|---|---|---|---|---|
| F-A | P1 | **확인·수정** | `rangeReplace`에서 `internal:true`면 `objectsLost` 검사를 건너뛰어 `[앞][표][뒤]` 범위를 엔진 클립보드로 바꾸면 표가 지워지고 저장됨(Astra의 격리 재현과 리뷰의 코드 근거, 수정 전 코드를 되돌린 변형에서 새 시험 3건이 실패). 이제 파괴적 삭제(`deleteRangeNow`) **직후, 붙여넣기 전**에 객체 수를 원래와 비교해(붙여넣는 클립보드에 표가 있어도 잃은 것을 가리지 못함) 표·그림 등을 잃으면 거절·롤백하고, 붙여넣은 뒤에는 삭제 직후보다 객체가 줄지 않았는지 한 번 더 확인합니다. 일반 붙여넣기 보호는 같은 검사로 더 일찍 걸리며 약화하지 않았습니다. 롤백은 범위 선택·엔진 클립보드·실행 취소 기록·수정 상태를 그대로 둡니다. | `editor-worker.test.mjs`: HWPX·HWP에서 평문·클립보드·삭제 3경로 모두 `개체` 오류, 거절 뒤 `canUndo/canRedo/dirty/count/memoCount` 동일·범위 선택 유지·표 4칸 유지, 저장·재열기 후 표 유지; 클립보드가 표를 품은 경우; 정상적인 서식 있는 교체는 성공하고 서식 유지·저장·재열기·실행 취소 2번으로 원본 복귀 |
| F-B | P2 | **확인·수정(의미 선택·고지)** | 표 칸 안의 교체는 `delete…InCell*`+`insert…InCell*`이라 엔진의 메모 보존 경로(`replace_range_keeping_memos`)를 타지 않아, 앵커 글 전체를 바꾸면 메모가 조용히 지워졌음(P2: 코어가 의도적으로 지우는 동작이고 PC·한/글과 같으며 실행 취소로 복원됨). 엔진 패치 없이 안전한 일관성을 택했습니다: **본문은 메모를 새 글에 유지, 칸 안은 앵커 전체를 바꾸면 메모가 지워지고 모든 명령이 알립니다.** 새 `memoTracker`가 명령의 단계(삭제·삽입·붙여넣기)마다 줄어든 메모 수를 세어(순합계가 아님: 클립보드가 메모를 가져와도 삭제로 지운 메모는 보고됨) `change`·`paste`·`split`·`merge*`·`pasteClip`·`tableGrid`·`rangeReplace/Delete`의 응답 `memosRemoved`로 반환하고, 화면은 `refreshPages`에서 같은 안내를 냅니다. 메모가 없는 문서는 조회를 건너뜁니다(`memoHint`). 저장 시 메모 검증(`memoSignature`)은 그대로이고, 메모의 원래 ID·작성 시각을 지어내 되살리지 않습니다. | `editor-worker.test.mjs`: 칸 안 `change`→`memosRemoved:1`·메모 0·저장/재열기 0개·실행 취소로 메모 글·작성자·칸 글 복원·재저장; `paste`·`split`·`pasteClip`·`tableGrid` 모두 보고; 본문 같은 교체는 `memosRemoved:0`에 메모 유지; 클립보드가 메모를 가져와도 삭제 단계의 `memosRemoved:1` 보고. **한계**: 칸 안 메모 보존 교체는 구현하지 않음(엔진 패치 필요), 지워진 메모의 원본 ID·작성 시각은 실행 취소 스냅숏 안에서만 보존됨. |
| F-C | P2 | **확인·수정** | `limited`가 한 폴더의 몫 소진·폴더/항목 상한에도 켜져 `finished()`(=`limited‖stop`)가 참이 되어 호출자 반복문이 뒤의 연결 폴더를 전부 건너뜀(JVM 재현: 문서 4개·폴더 2개에서 첫 폴더의 2개만 반환). 이제 `finished()`는 **전체 중단**(취소, 전체 시간 150초)만 뜻하고, 폴더별 불완전은 `limited`·`complete()`로만 보고합니다. 반복문을 `TermuxWalker.walkAll`로 옮겨 `TermuxFolders.scan`이 그대로 호출하고(자체 `finished()` 판단 없음), 몫이 0이면 그 폴더를 조회하지 않고 불완전 처리합니다. 정리 기준(`complete()`일 때만 참조 삭제)은 그대로입니다. | `TermuxWalkerTest`: 실제 반복문 `walkAll`에 4개 문서·2개 폴더 → 양쪽 모두 나열, 몫이 남으면 다음 폴더로 이월, 폴더 3개·문서 3개, 아주 작은 예산에서도 마지막 폴더 도달, 취소·시간 한도는 전체 중단(뒤 폴더는 조회하지 않고 불완전), 권한 회수된 폴더는 건너뛰고 다음 폴더 진행, `TermuxFolders.java`가 `walker.walkAll(roots)`를 쓰고 `walker.finished()`를 쓰지 않음을 소스로 확인. 변형(`finished()`에 `limited` 복원)에서 실패 확인. |
| F-D | P2 | **확인·수정** | 이름·크기·시간이 같은 목록을 조상과 공유하는 진짜 중첩 폴더를 별칭으로 오인해 건너뛰고도 `skipped`를 올리지 않아 검색이 '완료'로 보고되고 참조가 정리됨(JVM 재현: `x/`와 `x/a/`가 `[a/, r.hwp]`). 제공자는 정규 식별자를 주지 않아 같은 목록만으로는 증명할 수 없으므로: ① 같은 목록의 폴더는 **일단 의심만** 하고, 의심 폴더와 조상 쌍의 첫 하위 폴더를 따라 3단계(또는 가지의 끝)까지 목록이 계속 같을 때에만 별칭으로 보고 건너뜁니다. 다르면 진짜 폴더로 들어갑니다. ② 건너뛴(또는 확인하지 못한) 별칭은 `skipped`로 세어 `complete()`가 거짓이 되고 참조는 정리되지 않습니다. ③ 확인 작업은 한 번의 검색당 240회 조회로 제한되고, 넘으면 그 폴더는 같은 방식으로 건너뛰며(공급자 오류·취소도 같음) 어떤 경우에도 무한히 돌지 않습니다. 기존 깊이·폴더·항목·시간 한도와 방문 ID 집합은 그대로입니다. | `TermuxWalkerTest`: ID가 서로 다른 같은 배치의 중첩 폴더(2·4단계) 전부 검색·완료, 리뷰 재현 배치, ID가 새로 붙는 실제 `loop -> .`와 실제 Termux 배치 `nested/loop -> ..`(문서 중복 없음·불완전·확인 조회 상한 이내·폴더 수 한정), 확인 중 제공자 오류는 건너뜀·불완전, 의심 폴더 200개에서 확인 작업 상한과 폴더 401개 정확히 한 번씩. 변형(지문만으로 별칭 처리)에서 실패 확인. **한계**: 같은 목록이 4단계 이상 이어진 뒤에야 달라지는 진짜 중첩은 별칭으로 건너뛰며 불완전로 표시됩니다(조용히 '완료'가 되지 않음). 별칭 때문에 불완전해진 폴더 묶음에서는 사라진 문서의 참조가 정리되지 않습니다. |
| F-E | P2(방어, Android에서 실제 정지는 관찰하지 못함) | **확인·수정, 후속으로 소유권 재설계** | `giveUp`이 호출 스레드에서 `cancel.run()`을 동기 실행해 20 ms 마감이 500 ms 콜백 때문에 546 ms가 걸림(JVM 재현). 이제 호출자는 포기 표시·`future.cancel(true)`만 하고, `cancel` 콜백과 늦게 도착한 값의 폐기는 **고정 2개 보조 스레드**(대기열 16, 데몬, 유휴 시 종료)에서 실행됩니다. 보조 스레드가 모두 막혀 대기열도 차면 그 정리는 버려지고(`cleanupRejected`로 집계) 호출 스레드에서 실행하거나 새 스레드를 만들지 않으며, 제공자 호출용 스레드는 기존대로 최대 8개라 총 스레드 수는 한정됩니다. 결과 인계는 `RUNNING→DELIVERED/ABANDONED` 상태 하나로 정해 늦은 값이 정확히 한 번 폐기됩니다. 중단된 호출자는 `Cancelled`와 인터럽트 상태를 유지합니다. **후속(루트가 지적한 분기)**: 위 첫 구현은 값이 도착한 순간(DELIVERED) 포기한 호출자가 `stranded` 값을 받아 그 폐기를 `cancel` 콜백 뒤의 같은 정리 작업에 넣었기 때문에, 취소가 막히면 값이 닫히지 않았고 정리 풀이 가득 차면 폐기까지 함께 버려졌습니다(재현: 막힌 취소 + 가득 찬 보조 스레드 + 3000회 중단 호출에서 값 3개가 닫히지 않음, `StrandRepro.java`). 지금은 값을 만든 **제공자 작업 스레드가 호출자가 가져가거나 포기할 때까지(최대 `HANDOFF_MS`=2초) 값의 소유자**이고, 포기되면 그 스레드가 직접 정확히 한 번 닫습니다. 폐기는 취소 콜백·정리 풀과 무관하고(취소는 별도의 최선 노력 작업, 가득 차면 버리고 집계), 소유자는 항상 최대 8개의 제공자 스레드 중 하나라 대기 중인 폐기 수도 한정됩니다. 호출자 스레드에서 닫지 않으며 새 스레드도 만들지 않습니다. 한계: 영원히 막히는 폐기자는 자기 제공자 스레드를 계속 차지하며, 이는 용량 제한의 '바쁨' 거절로 드러납니다. Android의 `CancellationSignal`이 막힌다는 것을 관찰한 것이 아니며 그렇게 주장하지 않습니다. | `TermuxWalkerTest`(후속: 143 검사 — 값을 만든 작업자가 DELIVERED 상태에서 값을 쥔 채 마감이 지나고 취소가 영원히 막히고 보조 풀이 가득 차 취소가 버려져도 값은 취소 게이트가 닫힌 채 정확히 한 번, 제공자 스레드에서 닫힘; 같은 상태에서 600회 중단 경쟁에서 만들어진 값 − 가져간 값 = 닫힌 값; 스레드 수 한정). 변형(작업자의 최종 폐기 제거)에서 실패 확인. 500 ms 취소 콜백에도 20 ms 마감 유지(<300 ms), 콜백은 `provider-cleanup` 스레드; 40회 호출 모두 막힌 콜백에서도 각 호출 <400 ms, 보조 스레드 ≤2, 초과분 정확히 22건 집계·호출 스레드에서 실행되지 않음, 해제 뒤 접수된 18건 실행; 인터럽트 상태·보조 스레드 실행; 1,000회 경주에서 폐기 값이 정확히 한 번·호출 스레드 밖; 막힌 폐기자도 마감 유지; 8개 제공자 스레드가 모두 막히면 다음 호출은 즉시 `이전 요청` 오류, 풀리면 다시 동작. 변형(콜백 동기 실행)에서 541 ms로 실패 확인. |
| F-F | P2(시험 결함) | **확인·수정** | `chooseProject()`가 항상 `termux-` 검색 결과 정확히 2개를 기다렸는데 앞선 시나리오가 `termux-remove.hwp`를 지우고 공유 복사본도 지워 마지막 시나리오에는 `termux-nested.hwpx`만 남아 통과할 수 없었음. 시나리오마다 **정확한 이름 목록**을 받도록 바꿨고(`chooseProject(['termux-nested.hwpx'])`), 마지막 시나리오는 `visibleNames()`가 정확히 그 목록인지도 다시 단언합니다(느슨한 개수 검사 제거). 실제 공식 Termux·SAF·권한 경로는 그대로입니다. | `tests/android-termux-fixtures.test.mjs`(Node): 시나리오 순서대로 파일 생성·삭제를 추적해 모든 `chooseProject` 호출의 기대 목록이 그 시점의 실제 문서와 같은지, 원래 결함(인수 없는 호출)을 잡는지, 마지막이 정확한 이름 단언인지 확인. 설치 APK 실행은 **미실행**. |
| F-G | P2 | **확인·수정** | `scheduleDraft`가 매 편집마다 `clearTimeout` 후 4초 뒤로 다시 잡아 쉬지 않고 입력하면 복구본이 영영 안 만들어지고, 도움말·`DEX-QA.md`는 "몇 초마다"로 과장. 이제 마지막 복구본에 들어가지 않은 첫 편집부터 **최대 30초**(`DRAFT_MAX_WAIT_MS`)를 넘기지 않고(대기 시간 = `min(쉼 시간, 첫 편집+30초−지금)`), 조합 중·편집 확정 대기·바쁨이면 0.5초 간격으로 다시 시도하되 최대 대기는 계속 흐릅니다(IME·바쁨·내보내기 의미 유지). 복구본 쓰는 중에 들어온 편집은 끝난 직후 다시 확인하며, 복구본의 기준 원본·해시는 건드리지 않습니다. 도움말·문서를 정정: "약 4초 쉴 때·연속 입력 중에도 최대 30초·백그라운드 즉시, 마지막 성공 스냅숏까지만, 절대 보장 아님". | `tests/dex-ui.py` 3b: 1초마다 입력(4초 쉼 없음) 40초 — 15초에는 복구본 없음, 31.0초에 생성, 입력 38자 중 복구본에는 34자(앞부분)가 돌아오고 원본 해시 불변, 마지막에 UI로 복구본 삭제; 변형(최대 대기 제거)에서 `a draft was written during continuous typing`으로 실패 확인. `tests/android-emulator.cjs`에 같은 연속 입력 시나리오 추가(실제 WebView, `am force-stop`, 원본 해시 불변; **미실행**). |

## 2-C. 세 번째 Opus·high 리뷰(N1·N2와 메모)의 처리 — Sonnet·high 수정, **Opus 재리뷰 대기**

| # | 우선순위 | 상태 | 원인 → 수정 | 시험 |
|---|---|---|---|---|
| N1 | P2 | **확인·수정** | `writeDraft`가 `state.saving`이면 타이머를 버리고 반환했고, 저장이 실패하면(외부 변경·읽기 전용·공간 부족·시간 초과) 어디서도 다시 예약하지 않아, 저장 중에 도래한 복구본이 새 입력 없이는 영영 안 쓰였음(변형으로 재현). 이제 저장 중에는 복구본을 **쓰지 않고**(내보내기·업로드와 겹침 방지) 마감(`draftSince`)을 그대로 둔 채 0.5초 간격으로 다시 확인하므로(회전하지 않음), 저장이 실패하면 바로 다음 시도에서 복구본이 만들어집니다. 저장이 성공하면 기존처럼 `dropDraft`가 타이머를 멈추고, 저장 중에 들어온 편집의 마감은 내보내기 시각부터 셉니다. 실패 때 마감을 초기화하지 않으며 원본 해시·충돌 검사·덮어쓰기 정책은 건드리지 않았습니다. 도움말은 "보통 약 4초, 용량이 큰 문서는 더 길어 최대 30초"로 정정(`draftPause`가 문서 크기에 따라 4~30초). | `tests/dex-ui.py` 3c(실제 Worker·페이지, 미리보기 브리지에 `/__delay` 추가: `finishSave` 7초 지연): 외부 변경 뒤 저장 → 4초 타이머가 저장 중에 도래하지만 5.5초 시점에 복구본 없음 → 충돌 대화상자 → **새 입력·`visibilitychange` 없이** 복구본 생성, 외부 바이트·해시 그대로, 백업 없음, 새로고침 → 복구본 제안 → 복구해서 열기에 편집 내용 있음·원본 그대로 → 새로고침 → 삭제 → 복구본 0. 변형(`if(state.saving)return`)에서 `draft after the failed save, with no new edit []`로 실패 확인 후 복구. 기존 성공 저장·저장 중 추가 편집 시험은 그대로. |
| N2 | P2(하드닝) | **확인·수정** | 별칭 확인 조회가 전체 시간·항목 예산과 무관했음. 이제 확인 조회는 ① `timeUp()`이면 시작하지 않고, 조회 시간은 남은 전체 시간으로 제한(`Source.list(id,max,budgetMs)`, 제공자는 `min(20초, 남은 시간)`; 일반 목록 조회도 같음), ② 응답 없음(`Timeout`)이 3번이면 더 확인하지 않고, ③ 한 조회는 2,000개까지만 읽고 그 이상이면 비교할 수 없어 '결정 불가'(건너뜀·불완전, 별칭으로 확인하지 않음), ④ 읽은 항목은 폴더별·전체 항목 수에 합산, ⑤ 확인 조회 240회는 연결 폴더마다 남은 몫으로 나눠 루프가 많은 첫 폴더가 뒤 폴더의 확인을 굶기지 못하게 합니다. 확인된 별칭(`aliases`)과 확인하지 못한 의심(`undecided`) 카운터를 분리했고 둘 다 `skipped`로 세어 검색을 '완료'로 보지 않으며 참조를 정리하지 않습니다. H1의 별칭 차단·정상 중첩·전체 취소·깊이·참조 유지는 그대로입니다. | `TermuxWalkerTest`(152 검사, 실제 `walkAll` 경유): 확인 조회가 600 ms씩 걸려도 400 ms 예산에서 끝남(~650 ms, 6개를 다 기다리지 않음)·남은 시간 이내의 예산 전달·`undecided=1`·불완전; 시간 초과 3번 뒤 확인 중단(질의 3개); 2,500개 목록이 상한(2,000) 밖에서만 다를 때 별칭으로 확정하지 않고 건너뜀·`entries`에 읽은 항목 합산; 루프 200개 폴더 뒤의 두 번째 폴더의 동일 배치 폴더가 여전히 확인·검색됨. 변형 4종(시간 검사 제거 3002 ms, 절단 규칙 제거, 폴더별 몫 제거, 시간 초과 중단 제거) 모두 실패 확인. 기존 '확인 조회 상한' 시험은 확인된 별칭 40 + 결정 불가 160으로 더 엄격하게 갱신. |
| 메모 1: 한계(40)에 닿은 기록 | P3(기존) | **확인·수정** | `takeSnapshot`이 명령 **전**에 가장 오래된 실행 취소를 지워 거절·실패한 명령(F-A 거절 등)이 롤백돼도 되살리지 못했음. 이제 명령이 **성공한 뒤**(`mark`)에만 한계로 줄입니다(엔진 스냅숏 용량 100이라 명령 중 1개 초과는 안전). | `editor-worker.test.mjs`: 표가 낀 범위를 기록 40개에서 평문·삭제·클립보드로 3번 거절해도 실행 취소 40단계 유지, 성공 명령은 여전히 40으로 줄임. 변형(명령 전 줄이기)에서 `39 !== 40`으로 실패 확인. |
| 메모 2: 도움말 '약 4초' | P3 | **수정** | N1에서 함께 정정(위). 문서 3종도 같은 문구. | — |
| 메모 3: 메모 갱신 비용 | — | **의도적으로 미착수** | 휴대폰에서 측정하지 않은 메모 성능 재설계는 하지 않았고, 실제 기기 측정 한계로 남깁니다(F17 행과 §4). | — |

## 3. 이 환경에서 실제로 실행한 시험(최종 커밋이 아님, 미커밋 작업 트리)

로그는 `/workspace/.cloud-setup/pr2-task/` 아래 `checks-*` 폴더(`results.tsv`: 시험 이름과 실제 종료 코드)와 `logs/`에 있습니다. KVM·실제 기기가 없고 에뮬레이터에는 아직 APK가 설치되지 않아 설치 APK 시험과 실제 Termux 시험은 **실행하지 못했습니다**(시나리오는 `node --check`만).

**§2-B 수정 뒤(이 실행, Sonnet·high)** — 종료 코드를 잘라내지 않고 묶음별로 실행(`run-checks.sh`):

| 시험 | 결과 |
|---|---|
| `node scripts/verify-engine.mjs`, `node tests/build-qa-fixtures.mjs` | 종료 코드 0 |
| `node --test tests/editor-features.test.mjs tests/editor-worker.test.mjs tests/engine-integrity.test.mjs tests/android-anr.test.mjs tests/android-termux-fixtures.test.mjs` | **74 통과 / 0 실패 / 0 건너뜀**(worker 38건: 새 F-A·F-B 8건 포함) |
| `node --check`(android-emulator/termux/suites/system/anr-parse, legacy-webview-driver) | 모두 0 |
| JVM `FileStoreTest` / `TermuxWalkerTest` / `DraftStoreTest` | 종료 코드 0. `TermuxWalkerTest`는 **116 검사**(후속 소유권 수정 뒤 143 검사, 아래 최종 반복 참고)(이전 30; F-C·F-D·F-E 추가), 시간·경주에 민감한 부분을 포함해 반복 실행해 통과 |
| Chromium `tablet-ui.py`, `dex-ui.py`(연속 입력 40초 복구 포함), `review-ui.py`(칸 메모 안내 포함) | 모두 0 |
| `gradlew assembleDebug assembleRelease lintRelease --offline --no-daemon`(`verifyMemoEngine` 가드 켠 상태) + `apksigner verify`(debug) | 모두 0 |
| 최종 소스에서 전체 반복(`run-checks.sh all opus2-fixes-final`, 2026-11-07T10:11Z) | 18개 검사 전부 종료 코드 0(Node 74/0/0, JVM, 브라우저 3종, Gradle 빌드·lintRelease, apksigner) |
| **N1·N2·메모 수정 뒤 전체 반복**(`run-checks.sh all n1n2-final`, 2026-11-07T10:39Z) | 18개 검사 전부 종료 코드 0: engine, fixtures, Node **75 통과/0/0**(worker 39건), 구문 6종, javac, FileStore, `TermuxWalkerTest` **152 검사**(10회 반복 통과), DraftStore, 브라우저 tablet/dex(3c 포함)/review, Gradle `assembleDebug assembleRelease lintRelease`, apksigner |
| 변형 확인(수정 전 코드로 되돌려 시험이 실패하는지) | (N1·N2·기록 한계 변형은 §2-C) F-A(새 3건 실패), F-C(문서 4개·폴더 2개에서 첫 폴더 2개만), F-D(`x/r.hwp`만 보고), F-E(541 ms), F-G(`a draft was written during continuous typing`) 모두 실패 확인 후 복구 |

**이전 기록(수정 전, 참고용)**: 루트의 쿼터 중단 후 기준 검사 — Node 63/0/0, JVM 53·30·38, 모두 종료 코드 0(`checks-astra-review-baseline/`). 첫 Sonnet 수정 실행의 브라우저·Gradle 통과는 마지막 F17·버튼 변경 전의 것이라 위 표가 그것을 대신합니다.

| 아직 하지 못한 것 | 상태 |
|---|---|
| 설치 APK(`android-emulator.cjs`, `android-termux.cjs`), 실제 Termux 제공자, 실제 Tab S7/DeX/Samsung IME/Bluetooth, 한컴 재열기, CI·PR 설명 갱신 | **미실행 / 미검증** |

## 4. 남은 것

- **§2-B 수정에 대한 Opus·high 재리뷰**(루트가 별도 실행으로 진행). 그 전까지 F-A~F-G는 "수정·자체 시험 통과"이지 "승인"이 아닙니다.
- 설치 APK 시나리오 실행. 에뮬레이터는 시스템 서버 재시작 뒤 APK 설치 전 `check()`에서 `unknown-anr package system`(종료 코드 1)이 났고 아무것도 닫지 않았습니다. 환경 실패일 뿐 APK 통과·제품 결함·CI 통과가 아닙니다. 루트가 진행 예정: 메모 이동 입력 보존, 입력칸 단축키, 큰 글자 정렬 H4, 심볼릭 링크·깊이 함정 H1, 선택 화면 중 프로세스 종료 F13(이제 정확한 이름 목록 F-F), 연속 입력 복구본 F-G, ANR 가드의 설치 APK 통합.
- 실제 Termux 제공자가 링크를 어떻게 보고하는지(H1), 휴대폰급 기기에서의 메모 갱신 지연, 실제 한컴 재열기(메모·확장 바탕쪽·메모 모양 65535), 실제 Galaxy Tab S7·DeX·Samsung IME·Bluetooth는 **미검증**.
- 엔진 자체의 Rust 시험은 Android 빌드에서 실행되지 않고(`--include=src/**`), Android 동작은 worker 시험만으로 확인됩니다.
- GitHub API 차단으로 이 소스의 CI 실행·PR #2 설명 갱신은 아직 없습니다. 어떤 CI 통과도 이 문서에 주장하지 않습니다.

## 부록 A. 초기 Opus 리뷰 응답 원문 (수정 없음)

`claude-opus-5-5`, `--effort high`, 원본 PR #2 커밋 `5986d5981be91aaad5085116a0fd1f3bf3df1b74` 대상. 아래 네 개의 백틱 울타리 안은 응답 파일을 바이트 그대로 옮긴 것입니다.

````markdown
# Initial review of PR #2 (frozen baseline), Opus/high, read-only

## 1. What I reviewed

| Item | Value |
|---|---|
| PR #2 commit reviewed | `5986d5981be91aaad5085116a0fd1f3bf3df1b74` (`codex/android-dex-termux-pr2`) |
| Base (Android main) | `499477990e1c23f71f4df465a26a2d448c5d564c` |
| PR #1 | `a6b087f1d2807b3c73676e24d21323a165d83029` is an ancestor. I took this from `orchestration-facts.json` and `pr2-commits.txt` (line 15); I could not re-verify it with git. |
| PC reference | `/workspace/hwpxxx` @ `fc87e2af24a98a25b6abac17144d167e1576e505`. I only checked that the engine patch exists there. |
| Inputs | `opus-baseline-full.diff` (38 files) and `baseline-snapshot/` (git archive of the PR commit). I did not read `/workspace/hwpxxx-android`. |
| Method | Static and read-only. I ran no tests, builds or device checks. The engine baseline tests were run by the orchestrator; I am not certifying them, the devices, or Hancom. |

**Coverage:**
- **Read fully:** `app.js` diff, `editor-features.mjs`, `engine-worker.js`, `MainActivity.java`, `TermuxFolders.java`, manifests, `app/build.gradle`, workflow, `scripts/*`, every file under `tests/`, `docs/DEX-QA.md`, `docs/CHANGES-0.3.0.md`.
- **Read for save semantics only:** `FileStore.java`, which this PR does not change.
- **Skimmed:** the CSS changes.
- **Not reviewed line by line:** the 4,280-line Rust patch `patches/rhwp-engine/0001-…patch`. I only checked that its SHA in `config/android-engine.json` matches `ENGINE_PROVENANCE.json` (`5fefe4f2…`).

**Do actionable P0/P1 findings remain? Yes.**
- No P0.
- 2 confirmed P1: F1 (product) and F2 (test evidence).
- 2 likely-P1 hypotheses that each need one reproducer: H1 and H2.

---
| 네 번째 Opus 재리뷰(N1·N2·이력) | `claude-opus-5-5` / `--effort high`, init 활성 확인 | 같은 읽기 전용 리뷰 세션을 별도 CLI 실행으로 재개, 7턴, 권한 거부 0건 | 새 P0·P1·P2 없음, P3 3건. 코드 판정이며 PR 승인 아님. 원문 부록 D, 응답 SHA-256 `bd762f8fdc3edd3644f699770523e7d3ea8d3e2d7598079285ac51a3a96de43b` |


## 2. Confirmed defects

All paths are relative to `baseline-snapshot/`.

### F1 — P1 — Jumping to a memo skips flushing pending text and the busy guard (can lose typed text)
- **Where:** `app/src/main/assets/app.js:409-411`
- **Code evidence:**
  - The `memo-jump` handler calls `state.engine.run('memoSelect')` and then `placeEditor(...)`, which removes the current `#text-editor` and creates a new one.
  - It never calls `flushEdit()` and does not use `guarded()`.
  - Every other path that changes the selection does flush first: `chooseText` at L189, `moveParagraph`/`navigateDocument` at L420-421, and `historyStep` via `guarded` at L297.
- **Why text is lost:**
  - The pending `commitEdit` timer (L193) reads `$('#text-editor')` when it fires, so it reads the new textarea and the old edits are dropped.
  - With a Korean IME the last syllable stays in composition (`composing=true`), and clicking the panel does not end it because `pointerdown.preventDefault` at L341 keeps focus.
  - If `compositionend` never fires on the removed node, `composing` stays `true`. Then `commitEdit` and `queueEdit` refuse to commit, and `flushEdit` keeps throwing "한글 입력을 마친 뒤…". That stuck state is a hypothesis; the lost un-flushed text is not.
  - The handler also does not check `state.busy`. If it runs while a format or merge command is in flight, the worker's `selected` can differ from the textarea's `ident`. Later `change` commits then come back `stale` and are silently dropped (`commitEdit` L194: `if(r.stale)return;`), while the text still shows in the textarea.
- **How to reproduce:**
  1. In edit mode with the memo panel open, type Korean (for example "메모" with the last syllable still composing).
  2. Immediately click a memo's anchor button (`.memo-anchor`, `data-action="memo-jump"`).
  3. Click back to the earlier paragraph: the last syllable or last keystrokes are missing from the engine text.
- **Impact:** Edits the user saw on screen are silently missing from the saved document.
- **Fix:**
  - Wrap the body of the `memo-jump` handler in `guarded(async()=>{…})`; `guarded` already calls `flushEdit` and sets `busy`.
  - Disable `.memo-anchor` and `memo-box` actions while `state.busy`.
  - Add a regression test: type, click the memo anchor, then check that `change` reached the worker. Include a variant where composition is still active.

### F2 — P1 (test evidence only) — An app ANR is not reliably counted as a failure
- **Where:**
  - `tests/android-system.cjs:13-36`
  - `tests/android-emulator.cjs:28, 47, 213`
  - `tests/android-termux.cjs:86-88`
- **What works:** `recoverSystemAnr` only clicks Wait for "System UI / Pixel Launcher isn't responding" (L16). Other error dialogs throw (L20). It is capped at 4 recoveries (L23). It saves the XML, PNG and logcat before tapping (L27-28). That part is correct.
- **The gap:** an ANR from the app under test is only detected by chance.
  - `recoverSystemAnr` runs only inside `waitForWindow` (on return from Settings or DocumentsUI) and inside `uiNodes` in the Termux suite.
  - Most scenarios are driven over CDP. CDP talks to the renderer process, so steps keep passing while an app ANR dialog sits on top.
  - The final assertion only checks `logcat -b crash` (`android-emulator.cjs:213`). ANRs do not go to the crash buffer.
  - The Termux suite has no crash or ANR assertion at all.
  - `backPrompt` (L47) and `returnFromSettings` (L28) send `KEYCODE_BACK` blindly. Whether Back cancels an ANR dialog on API 33 is not verified. If it does, it would be counted as `BACK_DISMISSED_INPUT_UI_FIRST`.
- **How to reproduce (to confirm the gap):** block the app's main thread for more than 5 s during a CDP-only scenario, for example with a debug-only delay in `reply()`. The suite can still pass.
- **Impact:** DEX-QA.md says "앱 자체나 알 수 없는 응답 없음은 … 실패합니다", and the PR states "WebView 오류 0개, 시스템 ANR 복구 0회". The test code does not fully enforce either.
- **Fix:**
  - After every `record()`/`check()`, and at the end of both suites, assert that `dumpsys window` `mCurrentFocus` does not match `Application Not Responding: kr.offline.hwp.preview`.
  - At the end of both suites, assert that `logcat -d -b events` has no `am_anr` line and `-b main,system` has no `ANR in kr.offline.hwp.preview`.
  - Add the same `-b crash` check to the Termux suite.
  - Before each blind Back key, check focus and fail if an `aerr_` window is focused.

### F3 — P2 — Hitting a depth or queue limit in one Termux folder stops the whole scan
- **Where:** `TermuxFolders.java:68, 74, 77, 80`
- **Code evidence:** `dir.depth>=64` or `pending.size()>=50000` sets `result.limited=true`. The outer loops then stop scanning every remaining folder and tree. The shared-storage scan handles the same depth case by silently skipping (`MainActivity.java:221`).
- **Reproduce:** one 65-level-deep folder (or a symlink loop, see H1) in the first tree, alphabetically, means later trees and sibling folders are never listed.
- **Impact:** Documents are missing from search results. The UI shows only the generic "검색 한도에 도달했어요" message.
- **Fix:** For the depth limit, skip that branch and count it as `skipped` instead of aborting. Keep `limited` for the global document and folder caps only.

### F4 — P2 — Clearing the Termux index at scan start makes already-listed Termux documents unopenable
- **Where:** `TermuxFolders.java:64` (`refs.clear()`), `MainActivity.java:142, 156-157, 193`, `app.js:62`
- **Reproduce:** Start a refresh, then cancel it (or tap a Termux document) while `termux.scan` is running. The cancelled result keeps the old `state.docs` (`app.js:62`), but `refs` no longer contains the entry. `read` then falls through to `document(id)`, which shows "문서 목록을 새로고침…" or the all-files permission error.
- **Fix:** Build the new map locally and swap it in atomically when the scan finishes, or keep entries whose tree is still connected.

### F5 — P2 — Termux folders are never scanned once the shared-storage scan hits its limit
- **Where:** `MainActivity.java:230` (`if(!limit&&!scanStop.get())`)
- **Reproduce:** shared storage with more than 10,000 HWP files or more than 50,000 folders: connected Termux projects never appear.
- **Impact:** The main Termux use case fails exactly on heavily used devices.
- **Fix:** Scan the connected Termux trees first (they are small and explicitly chosen), or give them a reserved share of the limit.

### F6 — P2 — A failed connect still keeps the persisted permission
- **Where:** `TermuxFolders.java:32-35`
- **Code evidence:** `takePersistableUriPermission` runs before the root is validated. If the query fails or the root is not a directory, the permission stays but is never saved to the prefs, so nothing can ever release it. Persisted grants are capped per app.
- **Fix:** Wrap the validation in `try { … } catch (Exception e) { releasePersistableUriPermission(...); throw e; }`.

### F7 — P2 — The Termux traversal blocks every other native operation
- **Where:** `MainActivity.java:30` (single-thread `io`), `:134`, `:230`; `TermuxFolders.java:63-86`; `app.js:L9 native()` timeouts
- **Code evidence:**
  - The SAF provider queries have no time budget and send no `scanProgress` events (only the shared scan sends them, at L227).
  - `status`, `read`, `beginSave`, `connect` (via `onActivityResult` L236) and `disconnectFolder` all wait behind the scan on the same thread.
  - They hit their 30 s JavaScript timeout and show "작업 시간이 초과됐어요".
  - After the 300 s scan timeout, the native scan keeps running.
- **Fix:**
  - Run the Termux scan on its own executor, or give it a time budget and a stop check per query.
  - Send progress events from the Termux scan.
  - Send `cancelScan` when the JavaScript side times out.

### F8 — P2 — Revoking all-files access while a Termux folder is connected leaves stale shared documents listed
- **Where:** `app.js:60, 67`
- **Code evidence:** `state.permission = shared || termuxActive` stays `true`, so the resume handler takes neither the grant branch nor the revoke branch.
- **Impact:** Shared documents stay in the library until a manual refresh. Opening one fails with a permission error. No data is lost.
- **Fix:** In the resume handler, when `shared && !state.sharedPermission`, cancel the scan, drop the non-`external` documents, and refresh.

### F9 — P2 — Pinch zoom and Ctrl+wheel use different minimum zoom levels
- **Where:** `app.js:175` keeps `Math.max(100,…)`. `zoomDocument` and `renderReader` (L503-507, L477) allow 50%.
- **Reproduce:** Ctrl+- down to 60%, then pinch on touch: the zoom jumps to 100% or more.
- **Fix:** Use one shared minimum constant (50).

### F10 — P2 — Forward Delete at the end of a section merges into paragraph 0 of the next section
- **Where:** `engine-worker.js:90` (`adjacent` crosses into the next section), `:138, :143-144`
- **Code evidence:** `mergeNext` → `Object.assign(c, adjacent(c,1))` → `mergeParagraph(sec+1, 0)`. The backward `merge` path deliberately turns paragraph 0 into a no-op (L139). The forward path ends in an engine error and an error dialog, or does an unintended cross-section merge, depending on what rhwp does.
- **Fix:** In `mergeNext`, return a no-op when the next position is in a different section.

### F11 — P2 — Document shortcuts fire inside panel number fields
- **Where:** `app.js:432-437`
- **Code evidence:** the second capture listener does not exclude `input`. So Ctrl+Z, Y, B, I and U inside `#fmt-spacings`, `#fmt-spacingBefore` and similar fields run document undo or formatting instead of acting on the field. The first listener (L423) does exclude inputs.
- **Fix:** Return early when `e.target.matches('input,select')`, except for Ctrl+S.

### F12 — P2 — Arrow-key paragraph moves ignore IME composition
- **Where:** `app.js:426`
- **Code evidence:** the ArrowLeft/ArrowRight boundary jump does not check `e.isComposing` or `keyCode===229`. During Hangul composition at the end of a paragraph, ArrowRight (which normally just commits the syllable) also jumps to the next paragraph. The code gap is certain; whether Samsung IME sends `key==='ArrowRight'` here has not been verified.
- **Fix:** Add `if(e.isComposing||e.keyCode===229)return;` to that branch.

### F13 — P2 — The folder-picker result is dropped if the activity is recreated
- **Where:** `MainActivity.java:36, 130, 234`
- **Code evidence:** `folderPickerRequest` is only kept in memory. If the process is killed while DocumentsUI is open, the new instance gets `id<0` and returns early, so the user's selection is never connected.
- **Fix:** In `onActivityResult`, connect the tree even when `id<0`, then send `foldersChanged`.

### F14 — P2 — Weak spots in how the ANR recovery records evidence
- **Where:** `tests/android-system.cjs:5-7, 11, 14-16, 23, 30`
- **Code evidence:**
  - `recoveries.json` is never cleared at the start of a run. A local re-run inherits old counts and evidence. CI starts clean, so this only affects local runs.
  - The message regex is checked against the dump but not against the package named in the `mCurrentFocus` string from L14. If two ANRs are queued, Wait can be tapped and recorded as "System UI" while focus shows the app's ANR.
  - No screenshot is taken after the tap.
- **Fix:**
  - Clear the journal at suite start.
  - Require the focus line to contain `com.android.systemui` or `com.google.android.apps.nexuslauncher`.
  - Save a `N.after.png` after the tap.

### F15 — P2 — The memo-engine build gate only checks method names in `rhwp.js`
- **Where:** `app/build.gradle:31-41`, `scripts/install-engine.mjs`
- **Code evidence:** a new `rhwp.js` next to a stale `rhwp_bg.wasm` passes the gate. `build-info.json` contains the hashes, but nothing checks them.
- **Fix:** In `verifyMemoEngine`, check the SHA-256 of `rhwp.js` and `rhwp_bg.wasm` against `build-info.json`, and require `build-info.json` to exist.

### F16 — P2 (docs) — The engine patch README describes the PC/Windows build
- **Where:** `patches/rhwp-engine/README.md:32-46`
- **Code evidence:** it references `scripts/wasm-pack-locked.sh`, `scripts/build-editor.mjs`, `config/editor-build.json`, `AI/bin/rhwp-wasm.mjs`, MinGW and Rust 1.93.1. None of these exist in this repository, and they contradict `config/android-engine.json` (nightly-2026-02-01, `-Ctarget-cpu=mvp`, `-Zbuild-std`).
- **Fix:** Point the section at `scripts/build-engine.sh` and `config/android-engine.json`.

### F17 — P2 — Memos are reloaded on every committed edit and re-drawn on every page render
- **Where:** `app.js:291` (`refreshPages` ends with `await refreshMemos()`), `:154` (`renderPage` calls `renderMemoMarks()`), `:356-370`
- **Impact:** Each 80 ms typing commit recomputes selection rectangles for every memo, and the memo DOM is rebuilt for each lazily rendered page. Lag in documents with many memos is a hypothesis; the call frequency is confirmed in the code.
- **Fix:** Refresh memos only after memo, structural or format operations, or when the page count changes. Re-render marks only for the affected page.

### F18 — P2 (CI hygiene)
- **Where:** `.github/workflows/android.yml` (third-party actions pinned by tag), `scripts/fetch-termux-qa.sh:8-10`
- **Code evidence:** the Termux APK is checked against a checksum file downloaded from the same release, with `--ignore-missing`.
- **Fix:** Pin the APK's SHA-256 in the repository. Optionally pin the actions by SHA.

---

## 3. Unverified hypotheses (need a reproducer before treating them as defects)

- **H1 — would be P1 if confirmed — Termux symlinks cause cycles, duplicates or very long scans.**
  - Termux's DocumentsProvider seems to list symlinked directories as `MIME_TYPE_DIR`, with absolute-path IDs.
  - `TermuxFolders.java:69` only removes duplicate IDs. So pnpm `node_modules/.pnpm` cycles, or `~/storage/shared → /storage/emulated/0` (created by `termux-setup-storage`, under the picker's default HOME, MainActivity L130), could cause:
    - up to 50,000 provider calls, blocking the I/O thread (see F7);
    - an early `limited` abort (see F3);
    - shared documents listed twice as read-only `external` copies.
  - **Reproduce:** add `ln -s .. loop`, a pnpm-style cycle and `~/storage/shared` to the `android-termux.cjs` fixtures.
  - **Fix:** skip `node_modules`, `.venv`, `storage` at the HOME root, `.cache` and dot-folders; give each tree a time budget; on depth overflow, skip the branch.

- **H2 — would be P1 if confirmed — The stricter paragraph check can refuse saves.**
  - `verifyFormats` now compares all 24 `PARA_KEYS` (`engine-worker.js:84`; before this PR it compared 3).
  - Any key that changes or reads back as `undefined` after the HWP or HWPX writer round trip (`numberingId`, `borderConnect`, `*BreakUnit`, …) makes every save in that session fail with "문단 서식이 유지되지 않았어요".
  - HWP plus paragraph formatting plus export is not tested (`editor-worker.test.mjs` only covers HWPX at L413-421).
  - **Fix:** compare only the keys the operation wrote, and add HWP tests for align, spacing, list and paste-format with `scope:'para'`.

- **H3 — P2 — Memo offsets may count characters differently from the editor text.** `memoSelect` and `decoratedMemos` (`engine-worker.js:100, 194`) assume `startCharIdx` counts the same characters as `getTextRange` (one per Unicode code point, with one placeholder per control). If rhwp counts in HWP units instead, an emoji or table control before the anchor shifts it. Tests only cover offsets 0-3 with plain characters.

- **H4 — P2 — Large system font size may misalign the editor overlay.** The PR adds `setTextZoom(fontScale*100)` (`MainActivity.java:53, 63`). This may scale the overlay textarea's px fonts set by `layoutEditor`, so they no longer line up with the rendered SVG page. The font_scale 1.5 test (`android-emulator.cjs` "font scale…") only checks that controls are visible.

- **H5 — P2 — A memo box click in edit mode also runs a text hit-test outside the page.** At widths of 1600 px or more, clicking a `memo-box` (inside `.page`, placed `left:calc(100%+12px)`) also fires the `pointerup` → `chooseText` hit-test with x beyond the page width (`app.js:595 diff`, `:367`). The result may be an error dialog or a wrong selection that races with `memo-jump`.

- **H6 — P2 — Memo checks after export are partial, and encrypted memo saving is untested.** `memoSignature` compares only author and text order (`engine-worker.js:105`). Losing or moving an anchor would go unnoticed. Encrypted documents with memos are not tested through `export*WithPasswordAndReport`. If that path dropped memos, the existing check would refuse the save rather than lose data.

- **H7 — Possible stray build file.** `app/src/main/assets/engine/.rhwp_bg.wasm.my6jCi` is in the snapshot but not in the diff, so it most likely came from extracting the archive. Confirm it is not tracked in git. aapt would ignore dot-files anyway.

---

## 4. Requested areas that look correct

- **Saving while edits continue:** `export` records `{rev,text,bytes}`; `saved` checks the bytes and only resets `fmt` when `rev===savedRev` (L250-253). The tests cover export → change → saved → still dirty. During a save the content is `inert`, and pending edits and highlights are flushed before export.
- **Atomic write, backups and external changes:**
  - `FileStore` is unchanged: same-folder temp file, fsync, SHA re-read, `ATOMIC_MOVE`, a SHA conflict check, and deleting the backup if the write fails.
  - Termux sources can never be written in place (`MainActivity.java:142, 193`), and the UI routes them to Save As (`app.js:204`).
  - The backup is made on the first in-place HWP save of each session. A new backup file is made every session, so they accumulate (policy note, not a defect).
- **Encrypted HWP/HWPX:** the password stays in worker memory; export uses the password-export path and re-opens with the password to verify. The emulator test covers wrong password, correct password, save and reopen for both formats.
- **Bridge and CSP:** the CSP is unchanged in both the meta tag and the response header. `.mjs` is served as `text/javascript`. The permission gate exemptions (`scan`, `read`, `disconnectFolder`, aborts) still route non-Termux IDs through `document()`, which re-checks all-files access. `connect` only accepts `com.termux.documents` trees. Memo, author and folder text is escaped.
- **ANR recovery:** recovery is limited to System UI and Pixel Launcher; other dialogs throw; at most 4 recoveries; XML, PNG and logcat are saved before the tap; and `recoveries.json` is printed (`android-suites.cjs:10`) and uploaded with `.qa/android-*`. The weak spots are listed in F2 and F14.
- **Test fakes:**
  - `tablet-ui.py` and `preview-server.mjs` use a fake bridge and are clearly labeled browser-only.
  - `legacy-webview-driver.cjs` only patches Playwright (visibility check and CDP mode).
  - The emulator's permission step can fall back to `appops` if the Settings switch is missing; when that happens it is recorded in `results.json.permissionGrant`. The final run's value should be checked before claiming the grant went through the Settings UI.

## 5. Not covered here or not implemented (not counted as defects)

- **Not ported (known):** multi-paragraph mouse selection, the Hangul-only HTML clipboard path, pasting across multiple cells, merging nested tables, and PDF export of encrypted documents from the library (`app.js:211` still refuses). Unsaved edits are not recovered after a forced kill (documented in DEX-QA.md).
- **Not verified on hardware:** real Tab S7, DeX, Samsung IME and Bluetooth, and reopening saved files in Hancom.
- **Not reviewed:** the Rust patch line by line, PC parity beyond confirming the patch exists, and CI run artifacts (screenshots, `results.json`, logcat).
- **Missing tests:** HWP memo save on a device, encrypted documents with memos, Termux symlinks and loops, and Termux scan timeouts.
````

## 부록 B. 두 번째 Opus 리뷰 응답 원문 (수정 없음)

`claude-opus-5-5`(관측값), `--effort high`(CLI가 수락), 읽기 전용, 현재 작업 트리 전체 diff 대상. 응답 SHA-256(끝 줄바꿈 제외) `9a43399a0caf9749ec68ddfdb0d2293896a62473eb865925b27ba27fb0b303f4`. 아래 네 개의 백틱 울타리 안은 응답 파일을 그대로 옮긴 것이며 어떤 문장도 고치거나 줄이지 않았습니다. 응답의 §6 "Local test logs are someone else's claims"와 "No installed-APK run passes" 같은 주의 문장도 그대로입니다.

````markdown
# PR #2 code review: Opus, effort HIGH, read-only (final review of the current source)

## 1. Run, base and target

| Item | Value |
|---|---|
| Model | Requested `--model opus`. This run identifies as `claude-opus-5-5`. |
| Effort | Requested HIGH. I can't see the effort setting from inside the run, so I don't claim it. |
| Tools | Read, Glob and Grep only. I made no edits and ran no shell commands, tests, builds or network calls. I ran nothing; every test result below is someone else's claim or log. |
| Android base | `main` @ `499477990e1c23f71f4df465a26a2d448c5d564c` |
| Target | `codex/android-dex-termux-pr2` @ `5986d5981be91aaad5085116a0fd1f3bf3df1b74`, plus every tracked and untracked change in the working tree (diff SHA-256 `2ddd76c6…2a63`, as stated in the review context) |
| PC reference | `/workspace/hwpxxx` @ `fc87e2af24a98a25b6abac17144d167e1576e505` |
| Generated vendor files | `rhwp.js`, `rhwp.d.ts` and `rhwp_bg.wasm` are generated, so I treated them as build output, not app source. To check engine behaviour I read the patched Rust source in `.build/rhwp/src`, which is the checkout `build-engine.sh` patched, and the installed `rhwp.d.ts` API list. I did not re-hash `build-info.json` myself. |

**Verdict:**
- **1 confirmed P1** (finding 1).
- **6 P2:** five confirmed by code reading (2, 3, 4, 6, 7) and one that is hardening for a contract no current Android caller breaks (5).
- **No P0.**
- **I don't approve this PR,** and nothing here covers Samsung DeX, Samsung IME, Bluetooth or behaviour in real Hancom software.

## 2. Coverage

**Read in full or for the relevant paths:**
- The complete review diff in my context, including all 4,275 lines of the Rust patch, read hunk by hunk.
- Current `engine-worker.js` lines 38–49 and 140–410: replace, range, paste, grid, export and saved.
- From the diff: `app.js`, `MainActivity.java`, `TermuxFolders.java`, `TermuxWalker.java`, `TimedCall.java`, `DraftStore.java`, `android-system.cjs`, `android-anr-parse.cjs`, `android-anr.test.mjs`, `android-emulator.cjs`, `android-termux.cjs`, `android-suites.cjs`, `verify-engine.mjs`, the workflow, and all worker, browser and JVM tests.
- In the current Termux suite file: lines 36–112.

**Engine source I checked against the patch (`.build/rhwp/src`):**
- `text_editing.rs`: the deferred cell replace at lines 1830–1943, which calls plain `delete_text_at` at line 1943, and every `delete_text_at_keeping_memos` call site.
- `field_query.rs`: `next_click_here_field_id` and `collect_max_field_id`. These collect ids from all fields, so new memo ids don't collide.
- `hwpctrl_sets.rs`: `controls_json`, `collect_controls` and `control_identity`. The control walk recurses into table cells, and **every** field, memo or not, reports `ctrlId ""`.

**PC parity:**
- The PC and Android engine patches have the same line count, except that Android adds one trailing blank line (4,274 vs 4,275 lines).
- Lines 2575–2614 and 4262–4275 are identical in both. **I did not byte-diff the whole file;** for the rest I rely on the line counts plus my in-context reading.
- `config/editor-build.json`: PC pins the built core files, not the patch.
- `patches/rhwp-studio/0006-rhwp-pr8269-memo-studio.patch`, lines 60–170 (`touchesMemoAnchor`): PC's editor relies on the engine deleting a memo whose whole anchor is deleted, and captures fragments so undo works.

**Remaining limits of this review:**
- I did not open the Astra repro files. I re-derived each Astra finding from the code instead.
- I did not reread every unchanged line of `app.js` or `MainActivity.java` on disk.
- I did not run the PR's Rust tests. They are also excluded from Android builds, because `build-engine.sh` applies the patch with `--include=src/**`.

## 3. Findings

### F-A (P1, confirmed): replacing a range with the internal clipboard skips the object guard and can delete a table that then gets saved
- **Where:** `app/src/main/assets/engine-worker.js:342-349`. Line 348 runs the check only `if(!a.internal&&objectsLost(...))`. The UI path is `app.js` `bindRangeEditor` paste, which calls `rangeEdit('rangeReplace',{internal:true},…)`.
- **How to reproduce (in the UI):**
  1. Copy text inside the document so `state.clip` is set.
  2. Select a range that contains a table paragraph, `[앞][table][뒤]`, by dragging or pressing Ctrl+A twice. The docs say selection and copy are allowed on such ranges.
  3. Press Ctrl+V. `deleteRangeNow` removes the table, `pasteInternal` inserts the text, and nothing is compared.
- **Plain paste is refused:** typing or pasting plain text over the same range is refused (`OBJECT_REFUSAL`).
- **Why the save keeps the loss:**
  - `export` re-checks only text, page count, renders, format targets and the memo author/text list.
  - The original document and the reopened copy both lack the table, so verification passes and the loss is written to disk.
  - Astra's isolated run of the shipped WASM and worker shows the same result: export accepted, table gone after reopening. I confirmed this by reading the code, not by running it.
- **Fix:**
  - Call `objectCounts()` right after `deleteRangeNow(r)`, inside the batch and before `internalPaste`, and refuse plus roll back if anything other than allowed memos is missing.
  - Do not compare after the paste: a clipboard that contains a table could hide the loss.
  - Keep the selection, clipboard and undo state when refusing. The UI fallback retries as plain text, which is then refused too; that is acceptable.
  - Add a worker regression test that uses the same fixture as the table-range test plus `copyText`.

### F-B (P2, confirmed): editing table-cell text that covers a memo's whole anchor deletes the memo silently, while the same edit in body text keeps it
- **Where:**
  - `engine-worker.js:43-44`: for cells, `replace()` uses `deleteTextInCell[ByPath]` followed by `insertTextInCell[ByPath]`. Body text uses `replaceText`, which reaches `replace_range_keeping_memos`.
  - `change` at line 213, `pasteClip` at line 385, `tableGrid` at lines 406–409, and `insertLines` at line 155 (used by `split`/`paste` over a selection) behave the same way.
- **Reproduce:** a memo on the cell text `표 셀 시험`; a `change` or `tableGrid` replacement over the whole anchor leaves the memo count at 0, with no notice.
  - `tableGrid` deliberately tolerates this (`objectsLost(..., memosRemoved)`) and only announces "N칸에 붙여넣었어요".
  - Only the range path announces removed memos (`rangeEdit`, `memosRemoved`).
- **Why P2 and not P1 (Astra rated it P1):**
  - The edit can be undone.
  - The core deletes a memo whose whole anchor is deleted by design, and PC behaves the same way: its editor replaces by delete-then-insert, and `touchesMemoAnchor` exists precisely because the core drops such memos.
  - The defect is that Android is inconsistent with itself and with its own "always announce removed memos" rule. It is not a PC regression.
- **Engine limits:**
  - There is no cell API that keeps the memo and extends it over the new text.
  - `replaceTextInCellDeferredPagination` accepts only 1–8 characters, and it calls plain `delete_text_at` (`text_editing.rs:1943`), which leaves a zero-length memo rather than one covering the new text.
- **Fix, any of:**
  - (a) Port `replace_range_keeping_memos` to the cell and path delete-plus-insert paths in the engine patch.
  - (b) In the worker, call `memos` before replacing, and if any whole anchors fall inside the replaced span, re-insert those memos with `insertMemoByPath` (same author and text) inside the same snapshot.
  - (c) At minimum, return `memosRemoved` from `change`, `paste`, `split`, `pasteClip` and `tableGrid`, and show the same announcement the range path uses.
- **Do not** weaken the save-time memo check.

### F-C (P2, confirmed): one Termux folder reaching its share of the document limit stops the scan for every folder after it
- **Where:**
  - `TermuxWalker.java:105` sets `limited=true` when a folder reaches its quota. The per-folder caps (folders, entries, pending queue) at lines 79, 81, 91, 94 and 100 also set it.
  - `finished()` at line 49 returns `limited||stop`.
  - `TermuxFolders.java:128` stops the loop over connected folders when `walker.finished()` is true.
- **Reproduce:** connect two folders, with the first holding more documents than its share (2,500 of the 5,000 reserved for linked folders). The second folder is never listed. Astra saw the same with a JVM run: room for 4 documents, 2 roots, and only the first root's 2 documents returned.
- **Why the tests miss it:** the existing fairness tests call `walk()` directly and never go through the caller's `finished()` check.
- **Impact:** this defeats the documented guarantee "각 폴더가 남은 한도의 몫을 받습니다". Documents in later folders don't show up.
- **Fix:**
  - Keep a global stop signal (time limit, overall budget used up, user cancel) separate from "this folder was incomplete".
  - Stop the loop only on the global signal.
  - Keep `limited` and `complete()` for reporting, so references are still not pruned after an incomplete scan.
  - Add a JVM test that drives the multi-folder loop itself.

### F-D (P2, confirmed): a real folder can be mistaken for a symlink alias, its contents dropped, and the scan still reported as complete
- **Where:** `TermuxWalker.java:58-63` (the fingerprint is names, kinds, sizes and times) and lines 88–89. A folder that is treated as an alias increments `aliases` but not `skipped`, so `complete()` stays true. `TermuxFolders.java:140` then runs `refs.keySet().retainAll(fresh)`.
- **When it happens:** a descendant folder whose listing matches an ancestor's exactly, for example `x/` holding `[a/, r.hwp]` and `x/a/` holding `[a/, r.hwp]` with the same times. Archive extraction with preserved times can produce this. That folder's descendants are never listed.
- **Impact:**
  - Documents go missing even though the scan reports complete.
  - Previously listed documents under those folders lose their references and can no longer be opened.
  - The trigger is unusual, hence P2.
- **Fix:**
  - At minimum, count a suspected alias as incomplete (or skipped) so references are kept.
  - Make detection stricter, for example by confirming one level deeper or by requiring the folder's own name to appear in its own listing.
  - Never report a scan as complete when content was skipped on a guess.

### F-E (P2, hardening; not a confirmed defect on Android): the cancel callback runs on the caller's thread, so the timeout is not strictly bounded
- **Where:** `TimedCall.java:47-49`. `giveUp` calls `cancel.run()` synchronously.
- **Evidence:** Astra's JVM run with a 20 ms timeout and a 500 ms cancel callback returned after 546 ms.
- **Why not confirmed on Android:** the callbacks used today are `CancellationSignal.cancel()`, which I believe is a one-way binder call, and `InputStream.close()`. Neither normally blocks, so this is a contract weakness rather than an observed hang.
- **Fix:** run the cancel callback on a bounded helper thread with its own short timeout, or document the requirement that it must not block. Do not start an unbounded number of abandoned threads.

### F-F (P2, confirmed, test defect): the new "picker survives process death" Termux scenario can never pass
- **Where:**
  - `tests/android-termux.cjs:54`: `chooseProject()` waits for exactly 2 results for the search `termux-`.
  - Line 94 deletes `termux-remove.hwp` and nothing recreates it.
  - Line 104 deletes the shared `termux-export.hwpx`.
  - The final scenario calls `chooseProject()` at line 110.
- **Effect:** only `termux-nested.hwpx` is left, so the wait times out even if the app reconnects the folder correctly. The scenario is new (it was added for initial-review F13), so it has never passed, and the next installed-APK run will fail on it.
- **Fix:** pass the exact expected document names per scenario (here `['termux-nested.hwpx']`), or restore the fixture before the scenario. Do not replace the exact check with a loose count.

### F-G (P2, confirmed; new in this review): the recovery draft only waits for a pause, so continuous editing is never saved as a draft
- **Where:** in `app.js`, `refreshPages` calls `scheduleDraft()` after every edit, and `scheduleDraft` runs `clearTimeout` and then `setTimeout(...4000+)`. Nothing forces a draft after a maximum delay. The only other trigger is `visibilitychange`, which fires on backgrounding.
- **Reproduce:**
  1. Edit for minutes without ever pausing 4 seconds or longer.
  2. Kill the renderer or the process while the app is in the foreground (OOM, `am force-stop`, a crash).
  3. Nothing typed since the last pause is recoverable.
- **The texts overstate it:**
  - The in-app help says "몇 초마다 … 임시 보관돼요".
  - `DEX-QA.md` says "몇 초 간격".
  - `CHANGES-0.3.0.md` is accurate ("약 4초 쉬면").
- **Fix:** add a maximum wait (for example, write at least every 30 s while the document is dirty, still skipping while IME composition is active or the app is busy), and correct the help text.

## 4. Engine memo patch: semantics checked line by line (no further defects that affect Android)

| Area | What I checked |
|---|---|
| Parsing | `split_tail_lists` and `assign_memo_paragraphs` attach each memo body to the first memo field with the same number and no body yet. Master-page lists are still separated. `link_orphan_field_ends_with` now records `FIELD_MEMO` and the memo number for multi-paragraph memos. `parse_field_control` turns `%unk` + `MEMO/` into `FieldType::Memo`. |
| Control and offset bookkeeping | `insert_memo_field_in_para`: control index, 8-unit begin and end slots, `char_count = gap_end + 16 + 1`, and range ordering are consistent. `remove_memo_field_in_para` undoes this symmetrically. Paragraphs that `raw_slot_gaps` refuses (containing `U+FFFC`, title marks or orphan ends) get a clear error on insert, and on deletion fall back to `drop_memo_control_fallback` + `rebuild_char_offsets`. |
| Typing at the caret | A zero-length memo does not grow when text is typed at its position (`is_caret_memo`). |
| Replace | Body `replaceText` keeps the memo and extends it over the new text (`memos_within` + `regrow_replaced_memos`). An empty replacement counts as a deletion and removes the memo. |
| Saving | The HWP5 memo tail sits directly under the real last paragraph (no extra empty root paragraph, so re-saving no longer adds a paragraph each time). Hancom's 10-byte paragraph header tails are kept. HWPX writes named memo parameters. |
| Clipboard | Pasted memos are renumbered, and memos copied without both their start and end are pruned (`renumber_memos`, `prune_incomplete_memos`). Pasting from outside the document drops memo fields. |
| Not used by Android | `replaceBodyTextLocal` (`text_editing.rs`, the hunk near line 1244) and the deferred cell replace keep a memo only as a zero-length anchor. Android uses neither. |
| Unverified compatibility | Memo lists are written per section; this predates the patch. The HWP5 note says Hancom puts them at the end of the last section. New memos use `MemoShapeIDRef` 65535 when the section defines no memo shape, and have no creation date. Whether real Hancom displays or reopens these correctly has not been checked. |

## 5. Earlier dispositions, checked independently

**Fixes I confirmed in the code:**
- **F1:** the memo jump runs through `guarded`, and is refused while IME composition is active.
- **F2/F14:** ANR guard.
  - Recovery is limited to `com.android.systemui` and `com.google.android.apps.nexuslauncher`.
  - The dialog text must name the same process as the focused window.
  - Recovery is capped at 4 and taps Wait, never Close.
  - Before tapping, it saves `N.xml`, `.png`, `.focus.txt` and `.logcat.txt`, and saves `N.after.png` afterwards.
  - An app ANR, an unknown ANR or a crash dialog fails the suite without touching the dialog, keeping the `failure-N.*` files and `anr-failures.json`.
  - The checks run after each scenario, before each Back key, every 3 s in the background, and at the end of each suite.
  - The end-of-suite check scans the logcat `am_anr` and `ANR in` lines, so an ANR closed by some other means is still caught.
  - `android-suites.cjs` fails the run whenever any failure was recorded.
  - I found no masking.
- **F9:** pinch and Ctrl+wheel share `clampZoom`.
- **F10:** forward Delete at the end of a section does not merge into the next section (line 224).
- **F11 and F12:** keyboard shortcuts no longer fire inside panel fields, and arrow keys no longer move between paragraphs during IME composition.
- **F15:** the engine gate checks the hashes and has no skip switch.
- **F18:** the Termux QA APK is pinned to a SHA-256.

**Fixes that exist but introduced new defects:**
- **F3 and F5:** depth overflow now counts as skipped, and linked folders are scanned first, but the fair-share change introduced F-C.
- **F4:** `complete()` exists, but F-D undermines it.
- **F13:** the code fix is present, but its test is broken (F-F).

**Other areas I checked and found no defect:**
- **Wheel and clicks:** Ctrl+wheel zoom keeps the point under the pointer in place. A plain wheel only scrolls. A click never changes the zoom level.
- **Save race:** `saved` compares the written bytes with what was exported and keeps the document dirty if edits arrived during the save. `state.saving` is checked after the flush, and the sheet makes the content inert.
- **Atomic save:** `FileStore` writes atomically, refuses read-only originals, and cleans up only its own `.hwp-offline-<digits>.tmp` files older than 6 hours.
- **Bridge:** `UNGATED` operations on shared documents still go through `document()`, which checks all-files access again.
- **CSP:** unchanged.

## 6. Unresolved features and verification limits

- **No installed-APK run passes on the current source.** The API 33 software emulator (no KVM) restarted `system_server` and showed "Application Not Responding: system" before any APK was installed. That is an emulator problem, not a product defect. The GitHub API is blocked (CONNECT 403), so no CI run exists for the current source.
- **Local test logs are someone else's claims:** Node 63 passed, FileStore 53, TermuxWalker 30, DraftStore 38, all exit code 0 in `checks-astra-review-baseline/results.tsv` (recorded against HEAD `5986d59` plus the working tree). The browser tests and full build reportedly passed before the last F17 and button changes, so they need to be rerun. None of these tests catch F-A through F-D or F-F.
- **The engine's own Rust tests from the patch are never run in Android builds.** Android engine behaviour is covered only by the JS worker tests.
- **Not implemented:** selection across table or section boundaries; the Hangul-only HTML clipboard; merging cells in nested tables; paragraph formatting inside nested cells; copy and paste between two documents in the engine.
- **Never tested:** real Galaxy Tab S7, Samsung DeX, Samsung IME, Bluetooth input; reopening saved HWP/HWPX files (memos, extended master pages, new memos with shape 65535) in real Hancom software; the real Termux provider's symlink behaviour (H1); real memo-refresh latency on a phone.
````

## 부록 C. 세 번째 Opus 리뷰(수정 뒤 전체 재리뷰) 응답 원문 (수정 없음)

`claude-opus-5-5`(관측값), `--effort high`(CLI가 수락), 읽기 전용. 응답 SHA-256(끝 줄바꿈 제외) `11959e9a79edd7c8c6b0909a8c1b740b39c6a90b2bade4a832ee8a0956a08a2e`. 아래 네 개의 백틱 울타리 안은 응답 파일을 그대로 옮긴 것이며 어떤 문장도 고치거나 줄이지 않았습니다(승인하지 않았다는 결론과 §6의 미통과 목록 포함).

````markdown
# PR #2 re-review (Opus/high, read-only): F-A through F-G fixes plus a pass over the full PR

## 1. How this review was run

| Item | Value |
|---|---|
| Model | Requested `--model opus`; this run identifies as `claude-opus-5-5`. |
| Effort | Requested `--effort high`. I can't see the effort setting from inside the run, so I don't claim it. |
| Tools | Read, Glob and Grep only. No edits, shell commands, test runs, builds or network calls. Every pass/fail below comes from someone else's logs. |
| Base | `origin/main` @ `499477990e1c23f71f4df465a26a2d448c5d564c` |
| Target | `codex/android-dex-termux-pr2` @ `5986d5981be91aaad5085116a0fd1f3bf3df1b74` + all tracked/untracked working-tree changes. Includes the 27 original commits and the intentional deletion of `engine/.rhwp_bg.wasm.my6jCi`. |
| Diff | SHA-256 `711f64784d3b76352b646f8266804950a3e99595adeaceabf304f559d17ce9e4` (861,645 bytes, as given in the manifest) |
| PC reference | `/workspace/hwpxxx` @ `fc87e2af24a98a25b6abac17144d167e1576e505` |
| Generated engine files | `rhwp.js`, `rhwp.d.ts` and `rhwp_bg.wasm` were treated as build output and not read. What I checked instead is listed in §2. |

**Verdict**
- **No P0 and no P1.** The previous P1 (F-A) is fixed in the code.
- **Two new P2s remain:** N1 (recovery draft) and N2 (Termux scan limits). Both are small and fixable locally.
- **I don't approve the PR.** No installed-APK, real Termux, CI, real-device or Hancom check has passed on this source (see §6).

## 2. Coverage and limits

**Read**
- The full attached diff: app, worker, Java, tests, docs and workflow.
- The 4,275-line memo patch, read hunk by hunk again for semantics.

**Checked against the files on disk**
- `engine-worker.js` lines 29–34, 148–159, 340–410.
- `TermuxWalker.java` lines 59–71, 115, 154–176.
- `TimedCall.java` lines 34–118.
- `app.js` lines 217–231 and 655–683.
- `tests/android-termux.cjs` lines 40, 84, 89, 115, 117.
- `build-info.json`: it pins upstream commit `1a76570e…`, patch `5fefe4f2…`, and records hashes for `rhwp.js` (`3371096b…`), `rhwp_bg.wasm` (`4d58fe00…`) and `rhwp.d.ts` (`68416310…`). I could not re-hash the files myself. `verify-engine.mjs` compares them, and its run is logged as exit 0.

**Logs I read (these are recorded results, not runs of mine)**
- `checks-opus2-fixes-final/results.tsv`: all 18 entries exit 0 (engine, fixtures, node, 6 syntax checks, javac, filestore, termux, drafts, 3 browser suites, build, debug signature).
- `checks-followup-java/results.tsv`: javac, filestore, termux and drafts exit 0.
- `emulator-before-apk-anr/guard-check.log`: `ANDROID_ANR_FAILURE … "kind":"unknown-anr" … "package":"system"`, followed by the guard's "nothing was dismissed" error. This was before any APK was installed.

**Limits**
- I did not open the Astra repro or `StrandRepro.java`.
- I did not byte-diff the PC and Android patches beyond what the prior review covered.
- I did not run the mutation tests the Sonnet report describes; those claims are accepted only as claims.

## 3. New findings

### N1 (P2): a draft write that comes due during a save is dropped, and a failed save never reschedules it
- **Where**
  - `app.js:665`: `writeDraft` returns early on `state.saving` without rescheduling.
  - `app.js:220–226`: `saveDocument` / `saveDocumentNow` only reschedule after a successful save (`dropDraft(); … if(state.dirty)scheduleDraft()`). The catch path only calls `abortSave`.
- **When it happens**
  1. The user edits.
  2. The 4 s pause timer or the 30 s deadline fires while the save is still running (export, verification, upload).
  3. The save then fails: an external change ("다른 앱에서 문서가 바뀌었어요"), a read-only original, low storage, or a timeout.
- **Impact**
  - The unsaved edits are in no draft, and no timer is pending.
  - Recovery only resumes on the next edit or when the app goes to the background.
  - A foreground crash or OOM kill in that window loses the edits. The external-change conflict is exactly the case where the user is most likely to stop and read rather than keep typing.
  - The original file and its hash are not affected.
- **Recommended fix**
  - In `writeDraft`, treat `state.saving` like `draftBusy`: `if(state.saving){if(draftSince)scheduleDraft(false,true);return;}`.
  - Alternatively, in `saveDocument`'s `finally`, call `scheduleDraft()` when `state.dirty` and no draft timer is pending.
  - Add a browser test: make `finishSave` fail (external modification), let the draft deadline pass during the save, reload, and check that a draft is offered.

### N2 (P2, hardening): alias-confirmation listings ignore the wall-clock and entry budgets
- **Where:** `TermuxWalker.java:154–156`. `listForVerification` checks only `stop` and `MAX_VERIFY_QUERIES` (240 per walk). It does not check `timeUp()`. It asks for up to `MAX_ENTRIES` (150,000) entries per listing, and these entries count toward neither `treeEntries` nor `entries`.
- **Effect on time**
  - The wall clock is only checked at the top of each directory iteration (line 115).
  - One suspect folder can trigger up to `VERIFY_DEPTH*2 = 6` provider queries. Each can run to `QUERY_TIMEOUT_MS` (20 s).
  - So a slow or adversarial provider can push a walk about 120 s past the 150 s budget, close to the page's 300 s scan timeout.
  - Verification timeouts don't count toward `MAX_CONSECUTIVE_FAILURES`.
- **Effect on memory:** a provider with huge folders can make each confirmation listing materialise and sort up to 150k entries. That is outside the documented 150,000-entry budget (bounded only by 240 × 150k).
- **Effect across folders:** `verifyQueries` is shared by all connected folders. A loop-heavy first folder can use up the budget, so later folders' genuine equal-layout folders are skipped without being verified. They are still counted as skipped, so the scan stays incomplete and no reference is pruned. Nothing is silently lost, but results can be worse than necessary.
- **What it is not:** traversal is still bounded (240 queries, the visited-id set, depth 64, folder/pending caps). This is not a runaway.
- **Recommended fix**
  - Make `listForVerification` throw when `timeUp()` is true.
  - Pass a small cap (for example `Math.min(room, 2000)`) and treat a truncated listing as undecidable (skipped).
  - Add verification entries to the entry counters.
  - Optionally give each folder its own share of `MAX_VERIFY_QUERIES`.
  - Add a JVM test with a provider whose verification listings sleep, asserting the walk finishes near the time budget.

### Low-priority notes (not blocking)
- **History trimming on refusal (existed before this PR, affects every command).** `takeSnapshot` drops the oldest undo entry when history is at its cap of 40, and does so before the command runs. A refused command (F-A refusal, `tableGrid` refusal) then rolls back but cannot bring that entry back. The new tests don't run at the cap. Fix: trim only after the command succeeds.
- **"약 4초" in the help text is only right for small documents.** `draftPause()` grows to 30 s for documents of about 10 MB. The 30 s maximum still holds.
- **Unmeasured cost per reply.** `meta()` now calls `getMemoList()` on every reply. `memoTracker` adds up to two more calls per cell edit. Each call computes a page for every memo. I haven't measured this on a phone with many memos.

## 4. F-A through F-G, assessed independently

| # | Disposition | My evidence (reading the code unless stated) |
|---|---|---|
| **F-A (P1)** | **Resolved** | See below. |
| **F-B (P2)** | **Resolved (accepted semantics)** | See below. |
| **F-C (P2)** | **Resolved** | See below. |
| **F-D (P2)** | **Resolved, with a documented limit and N2** | See below. |
| **F-E (P2, hardening)** | **Resolved** | See below. |
| **F-F (P2, test)** | **Resolved; scenario not run** | See below. |
| **F-G (P2)** | **Mostly resolved; N1 remains; IME interplay unverified** | See below. |

**F-A: range replacement could delete a table and save the loss**
- At `engine-worker.js:354`, object counts are compared immediately after `deleteRangeNow` and before any insertion. This is the same check for plain and internal-clipboard replacement, so a clipboard that carries its own table cannot hide the loss.
- At line 357, nothing may drop below its after-delete count once the insert is done.
- The failure path ends the batch, then `rollback()` restores the snapshot, `selected`, `rangeSel`, `rev`, `fmt` and dirty state. `mark()` is not reached, so the redo list survives. Delete and paste don't touch the engine clipboard.
- `getControls` walks into table cells, so tables nested inside a cell are counted too.
- Formatted replacement without objects still goes through.
- Tests (in the diff): HWP and HWPX, all three paths refused, metadata and range unchanged, the table survives export and reopen, the clipboard-carrying-table case, and the formatted-replacement success case. The mutation run is claimed in the report; I did not run it.
- Remaining gap: the history-cap note in §3.

**F-B: memos removed silently when cell text over the whole anchor was replaced**
- `memoTracker`/`tracked` count removals at each stage, not as a net difference. Every path reports `memosRemoved`: `replace`/`split` via `memoTrack`, `change`, `paste`/`split`/`merge*`, `pasteClip` (counted before the paste), `tableGrid`, and range replace/delete.
- The UI announces it from `refreshPages`; `tableGrid` repeats it in its own message.
- Body text still keeps the memo through `replaceText`.
- Undo restores the original field from the snapshot. No metadata is invented. The save-time `memoSignature` check is unchanged.
- This matches the core and PC behaviour (PC's `touchesMemoAnchor` relies on the engine deleting the memo).
- Accepted limit: a stale `memoHint` can only make the check stricter (the edit is refused), never hide a removal.

**F-C: one folder's quota stopped all later Termux folders**
- `finished()` is now only cancel or time-up. `limited` and `complete()` only report incompleteness.
- `walkAll` is the single loop, and `TermuxFolders.scan` calls `walker.walkAll(roots)` (a test checks the source for this).
- A folder with no remaining share is marked limited without any provider query.
- References are only pruned when `complete()` is true.
- The JVM tests drive the real `walkAll`, including cancel and time limits as global stops and a revoked folder.

**F-D: equal listings treated as proof of a symlink alias**
- An equal fingerprint now only makes a folder a suspect. A difference within 3 levels means the folder is real and is entered.
- A confirmed or undecidable alias counts as `skipped`, so `complete()` is false and nothing is pruned.
- False positives remain only for nested folders that stay identical for more than 3 levels. That is documented, reported as an incomplete scan, and surfaced by the "건너뛰었어요" notice.
- On a real symlink loop (the Termux fixture), every scan will now report as incomplete and show that notice. This is conservative and acceptable.
- Budget gaps: N2.

**F-E: cancel callback ran on the caller's thread**
- `giveUp` only changes state, interrupts the worker and submits the cancel to a fixed pool (2 threads, queue 16, `AbortPolicy`, counted, never run inline).
- Ownership is decided by one atomic state. A value is closed only by the worker that produced it, exactly once (`disposed` compare-and-set), and never on the caller's thread. A blocked or dropped cancel can no longer strand a value; this was the follow-up issue the coordinator raised.
- The caller's interrupt flag is kept.
- When all 8 workers are pinned, new calls fail immediately as "busy".
- The production callers pass `discard=null`: cursors are closed inside the body, and `read` returns a `byte[]`. So the disposal path is defensive.
- This is JVM hardening, not a fix for an observed Android hang.

**F-F: Termux picker scenario expected two files after one was deleted**
- `chooseProject(expected)` waits for the exact sorted list of names (`android-termux.cjs:40`).
- The final scenario expects `['termux-nested.hwpx']` and re-checks it with `deepEqual` (lines 115 and 117).
- The fixture test replays the creations and deletions in source order and confirms it catches the original bare `chooseProject()` call.
- The real provider, SAF and permission paths are untouched.

**F-G: recovery draft waited only for a pause**
- `DRAFT_MAX_WAIT_MS` caps the wait at `min(pause, draftSince + 30 s)`. Composing, a pending commit or a busy state retry every 500 ms while the deadline keeps running. Edits that arrive during a draft write start a new period.
- The original file and its hash are never touched. Help text and docs now say "last successful snapshot".
- N1 remains.
- Both tests (`dex-ui.py` 3b and the unrun APK scenario) use `insertText` without composition events. Under Android Korean IMEs, the composing and commit guards can delay the snapshot past 30 s; commits mostly happen at word boundaries. Exporting the committed engine state does not actually require `composing` or `editTimer` to be clear, so dropping those two guards would make the deadline firmer.

## 5. Other review areas (step 3)

- **Edits during save, atomic replace, backups, conflicts:** OK. `saved` compares the bytes against the export revision. `FileStore` uses a temp file, fsync, a SHA re-read, `ATOMIC_MOVE`, refuses read-only originals and cleans up its own stale temp files. On a conflict the original is not touched and Save As is offered. Draft interaction: N1.
- **Encryption, memos, formatting round trip:** OK as far as the worker tests reach. This includes an encrypted document carrying a memo and the full paragraph-key comparison (H2 could not be reproduced). Reopening in real Hancom has not been checked.
- **Unicode, IME, ranges, history:** OK, apart from the history-cap note in §3 and the F-G IME gap.
- **Cursor, wheel and click zoom:** Ctrl+wheel zooms around the pointer, a plain wheel scrolls, a click never changes zoom, and every zoom path shares `clampZoom`. OK.
- **Lifecycle, drafts, resize:** OK, apart from N1.
- **Termux:** grants survive restarts, are released on failure or disconnect, partial scans keep references, and calls have timeouts and cancellation. The budget gaps are N2. How the real provider reports symlinks (H1) is unverified.
- **Bridge, CSP, offline, WebView compatibility:** unchanged since the previous review, and OK. Ungated operations still recheck all-files access through `document()`.
- **Test fakes:** preview, tablet and review use labelled fake bridges. The installed-APK suites use the real bridge, provider and DocumentsUI. I found no masking.
- **ANR guard:**
  - Only System UI and Pixel Launcher are recovered, at most 4 times, and only when the dialog text names the focused process.
  - Every other ANR (app, unknown, `system`, crash) fails and keeps the original evidence. A recorded failure fails the whole run.
  - The observed pre-install `unknown-anr package system` failure shows the guard is working correctly. It is an environment failure, not a product regression and not an APK pass.

## 6. Remaining gaps (none of these passed)

- **Installed APK on API 33:** blocked. The local software AVD shows a system ANR before any APK is installed. No suite has run on the current source, so these scenarios are unverified: continuous-input draft, picker survives process death, memo jump, large font (H4) and symlink traps (H1).
- **CI:** none for the current source; `api.github.com` is blocked. The PR description has not been updated.
- **Not tested:** real Termux provider symlink behaviour; real Tab S7, Samsung DeX, Samsung IME and Bluetooth; Hancom reopening of saved memos and extended master pages (memo shape 65535, memos without a date); memo-refresh latency on a phone.
- **Not implemented:** keeping a memo when cell text over its whole anchor is replaced (needs an engine patch); selection across table or section boundaries; the Hangul-only HTML clipboard; merging cells in nested tables; paragraph formatting inside nested cells; copy and paste between documents.
- **Engine tests:** the memo patch's own Rust tests are not run in the Android build (`--include=src/**`). Android engine behaviour is covered only by the JS worker tests.

**Bottom line:** F-A through F-F are resolved in the code and F-G mostly is. N1 and N2 are small P2s that are worth fixing before the final commit. Final approval still depends on the coordinator's exact-commit build, installed-APK, real-Termux and CI runs, none of which exist yet.
````


## 2-D. 네 번째 재리뷰 후 조정자 기록

- 검토 대상 전체 diff SHA-256: `84ec64eab5d16c3fafcd6445ae75cb6631260363faa98635f4449eb33fe6e3c2` (`5986d59…` + 당시 작업 트리). 이후 제품 코드·시험 로직은 그대로이며, 이 검토 기록·문서 표현과 `tests/dex-ui.py`의 줄끝 공백 1개만 정리했습니다.
- `checks-n1n2-final/results.tsv` 18개 항목은 모두 종료 코드 0: Node 75 통과·실패 0·건너뜀 0, JVM FileStore 53·TermuxWalker/TimedCall 152·DraftStore 38 검사, 브라우저 3종, 엔진 검증·구문·debug/release 빌드·lintRelease·debug 서명. Sonnet 응답은 일부 백그라운드 시험이 끝나기 전에 종료됐고, 조정자가 남은 시험의 실제 완료를 확인했습니다.
- P3-1 문서의 ‘확인 시간 초과 3번 연속’은 실제 누적 집계에 맞게 고쳤습니다. P3-2는 기존의 드문 실패 경로(`mark` 뒤 `meta` 오류)에서 실행 취소 이력이 줄 수 있다는 제한으로 남습니다. P3-3의 정확히 2,000개인 확인 목록도 불확실로 처리하는 보수적 정책은 유지합니다.
- 실제 Opus 리뷰는 시험을 실행하지 않았습니다. 아래 원문은 원래 응답을 보존하며, 최종 커밋의 CI/APK 통과를 뜻하지 않습니다. API 33 환경의 설치 전 `system` ANR 원본 증거와 엄격한 실패 판정을 유지합니다.
- 최종 커밋별 검증과 PR/CI 상태는 조정자가 별도로 확인해야 합니다. 생성된 엔진 3개 파일은 소스 커밋에서 제외하며, APK에는 고정 빌드·해시 검증을 통과한 생성물이 들어갑니다.

## 부록 D. 네 번째 실제 Opus·high 응답(원문)

`````text
I've finished checking the current N1, N2 and history-trim code on disk and the latest local check log; the review follows.

# PR #2 re-review 4 (Opus/high, read-only): N1, N2 and history-cap fixes

## 1. How this review was run

| Item | Value |
|---|---|
| Model | `--model opus` was requested; this run identifies as `claude-opus-5-5`. |
| Effort | `--effort high` was requested. I can't see the effort setting from inside the run, so I don't claim it. |
| Tools | Read, Glob and Grep only. I made no edits and ran no shell commands, tests, builds, network calls or other models/agents. Every pass/fail result below comes from someone else's log. |
| Base | `499477990e1c23f71f4df465a26a2d448c5d564c` |
| Target | `codex/android-dex-termux-pr2` @ `5986d5981be91aaad5085116a0fd1f3bf3df1b74`, plus all tracked and untracked working-tree changes |
| Diff | SHA-256 `84ec64eab5d16c3fafcd6445ae75cb6631260363faa98635f4449eb33fe6e3c2` (903,224 bytes, from the manifest) |
| Generated files not read | `rhwp.js`, `rhwp.d.ts`, `rhwp_bg.wasm`. No engine pin changed: `config/`, the patch and `build-info.json` are absent from the changed-files list. |

**Verdict**
- N1, N2 and the history-cap note are resolved in the code.
- I found no new P0, P1 or P2. Three P3 notes remain (§4).
- This is a code-review result only, not PR approval. Installed-APK, real-Termux, CI, hardware and Hancom checks are still unverified (§6).

## 2. Coverage

**Re-read on disk**
- `app.js`: lines 220–226 (`saveDocument` / `saveDocumentNow`, `exportedAt`) and 655–683 (`scheduleDraft`, `writeDraft`, `dropDraft`).
- `engine-worker.js`: lines 52–56 (`trimHistory`, `takeSnapshot`, `rollback`, `mark`), plus every `takeSnapshot`/`mark` call site (223–225, 236–243, 249, 258–269, 285–321, 352–362, 369–381, 397–400, 420–423).
- `TermuxWalker.java`: lines 55–216.
- `TermuxFolders.java`: lines 103–137 (`ProviderSource` with the clamped timeout, `SCAN_TIME_BUDGET_MS`, `walkAll`).

**Read in the diff**
- New tests: `TermuxWalkerTest` N2 block, `editor-worker.test.mjs` history-cap test, `dex-ui.py` 3c.
- `preview-server.mjs` `/__delay` hook.
- Docs: CHANGES, DEX-QA, PARITY-AUDIT, CLAUDE-REVIEW §2-C and Appendix C.

**Carried over unchanged from my earlier context**
- My full-diff reading and all 4,275 Rust patch lines, including the memo semantics and PC parity.
- `TimedCall.java` (unchanged).
- ANR guard, Termux suite, FileStore, the bridge and CSP.

**Log read (not run by me)**
- `checks-n1n2-final/results.tsv`: all 18 entries exit 0 (engine, fixtures, node, 6 syntax checks, javac, filestore, termux, drafts, tablet/dex/review browser tests, build, debug-signature).
- The coordinator reports node 75/75 and TermuxWalker 152 checks.
- I did not run the mutation checks; they are accepted only as claims.

## 3. Dispositions

### N1 (P2): draft due during a save that then fails — **Resolved**

**Code** (`app.js:669`): while a save runs, `writeDraft` neither writes nor drops the timer. It calls `scheduleDraft(false,true)`, which keeps `draftSince` because `scheduleDraft` only sets it when it is 0. So a retry runs every 500 ms for as long as the save lasts.

**After a failed save:**
- `saveYes` and `folderConfirm` clear `state.busy`.
- The next retry sees no saving, dirty state, no busy flag and normally no composition, so it writes.
- No new edit and no `visibilitychange` is needed.
- `saveDocumentNow`'s catch path still only calls `abortSave`. The conflict, read-only, backup and hash rules are unchanged, so external bytes are never touched.

**After a successful save** (`app.js:225`):
- `dropDraft` stops the retry and resets the deadline.
- If edits arrived during the save, `draftSince=exportedAt` (captured before the export, line 221) is set before `scheduleDraft()`. Their 30 s deadline therefore counts from the export, which is conservative.
- The pending timer can't write mid-save: it is a macrotask, and `state.saving` stays true until `saveDocument`'s `finally`.

**Safety:**
- The composing, editTimer and busy guards are unchanged.
- Saves and drafts don't overlap: `dropDraft` waits on `draftBusy`, and `writeDraft` defers while `saving`.

**Test** (`dex-ui.py` 3c, read in the diff):
- It drives the real page, the shipped worker and real files in the sandbox.
- The `/__delay` hook is in the test server only and is not shipped.
- It checks: no draft at 5.5 s into the save; a draft appears after the conflict dialog with no input; external bytes and SHA unchanged; no backup; recover and discard both work.
- This is a browser test. `android-emulator.cjs` has no failed-save draft scenario, so the N1 path on the real APK bridge and WebView is untested. The browser test does not stand in for that check; the APK scenario simply doesn't exist yet.

### N2 (P2 hardening): alias confirmation outside the budgets — **Resolved**

**Wall clock**
- `listForVerification` refuses once `timeUp()` is true (line 176).
- Every listing, confirmation and ordinary, receives `msLeft()` (lines 135, 179).
- `ProviderSource` clamps its timeout to `min(20 s, budgetMs)` (`TermuxFolders.java:106`).
- So an overrun past the 150 s budget is bounded by about one `TimedCall` poll (40 ms), not by 6 × 20 s.

**Bounded reads**
- Each confirmation reads at most `VERIFY_MAX_ENTRIES` = 2,000 entries.
- A listing that reaches the cap is treated as undecidable, never as a confirmed alias (line 183).
- Real providers return cursor windows, so only up to 2,000 `Entry` objects are built per confirmation.

**Entry counting**
- Entries read during confirmation are added to `treeEntries` and `entries` after `aliasOf` returns (line 147). This includes the entries of a truncated listing, because they are counted before the cap check.
- Overflow then marks the scan as `limited` through the existing checks at lines 131–132 and 155.

**Failures and timeouts**
- Timeouts increment `verifyTimeouts`. After 3, no more confirmations run.
- Every other exception (busy provider, cancelled, budget used up) returns null, which counts as `undecided`.
- Both `undecided` and `aliases` increment `skipped`, so `complete()` stays false and no references are pruned. A guess is never reported as a complete scan.

**Fairness and global stop**
- `walkAll` gives each remaining folder a share: `verifyLimit = verifyQueries + (240 − used)/(folders left)` (line 110). The total stays ≤ 240.
- `finished()` is still only cancel or time-up. Per-folder `limited` does not stop the folders after it (F-C still holds).

**TimedCall** is unchanged. The fixed pools, the "busy" refusal after 8 pinned workers, and value ownership are as in my previous review. Shorter clamped timeouts only take effect near the deadline, after which no new queries start, so I see no deadlock or extra resource leak. With `discard=null` and the cursor closed inside the call body, there is nothing to leak.

**Java 8:** the new `Source` default method is fine with `compileOptions 1_8`.

### History cap — **Resolved**

**Code**
- `takeSnapshot` no longer trims.
- `trimHistory()` runs only inside `mark()`, after `future` has been cleared (line 56).

**Refusals**
- A refused or failed command throws before `mark`. `rollback()` pops only the snapshot the command added. All 40 undo steps and the redo stack (`future`) survive.

**Successful commands**
- Every success path I checked calls `mark()`: `change` (including popping the snapshot for grouped typing), split, paste and merge, char, para, memo add/update/delete, paste-format, table merge, range replace/delete, range char/para, pasteClip and tableGrid.
- Undo and redo move entries between the two lists without trimming, so the total number of snapshots stays constant.

**Snapshot capacity:** at most 41 history entries plus at most 40 redo entries are held, which stays within the engine's limit of 98 (100 − 2).

**Test:** `editor-worker.test.mjs` runs three refusals at the cap and checks that 40 undo steps remain, then checks that a successful command still trims to 40. The third refusal (`internal:true`) may be refused before any snapshot is taken (the regex allows "복사본"); the first two are sufficient. The test does not check the redo stack after a refusal at the cap, but the code path is clear.

### Help and docs — **Resolved**, with one wording note (P3-1)
- The app help, CHANGES, DEX-QA and PARITY-AUDIT now say "보통 약 4초, 큰 문서는 최대 30초 (≈10 MB)". This matches `draftPause = min(30000, max(4000, size/350))`.
- The failed-save draft behaviour is described accurately.

## 4. Findings

There are no P0, P1 or P2 findings. Three P3 notes, none blocking:

**P3-1: confirmation timeouts are cumulative for the whole scan, but the docs say "consecutive".**
- **Where:** `TermuxWalker.java:70, 176, 180`. CHANGES says "응답 없음이 3번 이어지면".
- **What happens:** `verifyTimeouts` is never reset. It is shared by all connected folders and only counts up. Three confirmation timeouts anywhere disable confirmation for the rest of the scan, so later suspect folders become `undecided`: skipped, scan incomplete, nothing pruned. This is safe but more pessimistic than the wording suggests.
- **Fix:** either reset the counter on a successful confirmation listing, or change the doc wording to "3번 생기면".

**P3-2: when `meta()` fails after `mark()` (existed before these fixes).**
- **Where:** `engine-worker.js:225`, and the success returns at lines 243, 362, 400 and 423.
- **What happens:** the reply's `meta()` runs after `mark()`. If `meta()` throws (for example, more than 500 pages), `rollback` restores the document but cannot restore the redo stack that `mark` already discarded. At the cap, it also cannot restore the oldest undo step that `trimHistory` removed.
- **Fix:** run the page-limit check (`doc.pageCount()`) before `mark()`.

**P3-3: an exact 2,000-entry confirmation listing counts as undecidable.**
- **Where:** the `>=` comparison at line 183.
- **What happens:** a folder with exactly 2,000 entries is treated as truncated, which is conservative. No change needed.

## 5. Earlier review criteria, re-checked
- **F-A through F-F:** still resolved. The changed hunks don't touch them; the refusal paths now also keep their history.
- **F-G:** resolved together with N1. One gap remains: the 30 s maximum under real Android Korean IME composition is unverified, because both tests use `insertText` without composition events.
- **Save, atomic replace, conflict handling, encryption, memos, Rust patch semantics, PC parity, bridge and CSP:** unchanged since my previous review, and still OK.
- **ANR guard:** unchanged and still correct. The observed pre-install `unknown-anr package system` failure is an environment failure, not an APK pass.

## 6. Remaining limits

- **Installed APK on API 33:** blocked; the local AVD shows a system ANR before any APK is installed. Nothing has run in the APK suites: drafts (continuous typing, force-stop, failed save), the memo jump, large font (H4), symlink traps (H1) and picker recreation.
- **CI:** none for this source, because the GitHub API is blocked.
- **Not verified:** the real Termux provider's symlink behaviour; Tab S7, DeX, Samsung IME and Bluetooth; reopening saved files in Hancom (memo shape 65535, memos without a date); memo-refresh cost on a phone; the memo patch's Rust tests, which are not run in the Android build.
- **Not implemented, as documented:** keeping a memo when a cell's whole anchor text is replaced; selection across table or section boundaries; the Hangul-only HTML clipboard; merging cells in nested tables; paragraph formatting in nested cells; copy and paste between documents.

**Bottom line:** in the code, N1, N2 and the history cap are fixed, F-A through F-G hold, and no further P0/P1/P2 defect remains (three P3 notes in §4). That does not approve the PR. Approval still depends on the coordinator's exact-commit local run, installed-APK and real-Termux results on API 33, and CI, none of which exist yet.
`````
