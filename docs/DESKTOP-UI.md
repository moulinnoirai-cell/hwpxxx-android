# Android 데스크톱 UI

이번 UI 작업은 Codex가 직접 구현했습니다. Claude CLI를 사용하지 않았습니다.

기준은 PC 1.6.1 (`moulinnoirai-cell/hwpxxx`, `fc87e2af24a98a25b6abac17144d167e1576e505`)의 `config/editor-build.json`입니다. 고정 upstream rHWP `1a76570e833917d15817415a53c09ad61ab3203f`의 Studio 소스에 PC 패치 11개를 해시 확인 후 적용한 격리 참조본을 확인했습니다. PC 저장소/설치본은 수정하지 않았습니다.

- PC와 같은 파일·편집·보기·입력·서식·쪽·표·도구 메뉴 순서, 기본 도구 상자, 서식 줄, 회색 문서 작업 공간, 하단 페이지/편집 모드/배율 표시줄을 사용합니다.
- 주요 도구는 PC의 밝은/어두운 아이콘 스프라이트와 한글 글자 서식 표시를 사용합니다. 스프라이트 출처는 upstream `rhwp-studio/public/images/icon_small_ko{,_dark}.svg`이며 MIT 저작권/허가문은 `branding/DESKTOP-ICONS-LICENSE.txt`에 포함합니다.
- 글자 크기·줄 간격·문단 정렬은 기존 실제 편집 엔진 명령에 연결합니다. 단일 문단과 여러 문단 선택을 유지합니다. 저장·복구·원본 보호·CSP는 기존 경로를 사용합니다.
- 메뉴는 Enter/Space, 위아래/좌우 방향키, Tab, Esc와 바깥 클릭을 지원하고 작은 창에서 화면 밖으로 나가지 않게 위치를 맞춥니다. 도구 상자는 가로 스크롤·접기/펼치기를 지원합니다. 회전/키보드 높이 변경으로 편집 중 DOM을 다시 만들지 않습니다.
- Android 문서함·권한 요청·Termux 연결·폴더 선택은 Android 흐름을 유지합니다. 메뉴에 현재 지원하는 명령을 연결했으며 PC의 모든 명령을 새로 이식한 것은 아닙니다. 글꼴/언어/스타일 관리, 쪽 설정, 새 개체 삽입 등 미지원 엔진 기능은 이번 UI 변경에 포함하지 않았습니다.

## 확인

`tests/desktop-ui.py`: 1920×1080, 1280×800, 700×500, 390×844(터치)에서 모든 메뉴의 화면 내 배치, 키보드/Esc, 도구 상자 접기, 문서 영역 폭/상단 여백, 하단 상태줄, 실제 글자 크기 변경, 메뉴 배율, 어두운 테마와 패널 닫기를 확인합니다. 화면/결과는 `.qa/desktop-*.png`, `.qa/desktop-ui-results.json`입니다.

기존 `tablet-ui.py`의 오른쪽 고정 패널 배치 조건을 새로운 상단 도구 상자·전체 폭 문서 배치 조건으로 교체했습니다. 기존 서식·메모·회전·키보드/저장 조건은 유지합니다. `dex-ui.py`, `review-ui.py`, Node 회귀 및 debug/release 빌드·lintRelease도 실행합니다. 브라우저 시험은 실제 worker/WASM과 미리보기 native 브리지이며 설치 APK/실제 DeX/Samsung IME/Bluetooth 검증을 대신하지 않습니다. 기존 API33 소프트웨어 AVD는 시스템 ANR 문제가 있어 실기기 확인은 남아 있습니다.
