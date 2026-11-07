# 문서 엔진(rHWP) 이식 패치

`0001-rhwp-pr8269-memo-api-backport-to-v0.8.7.patch` — rHWP **v0.8.7**(`1a76570e833917d15817415a53c09ad61ab3203f`)에
메모 읽기·편집 API를 더합니다. 내용은 rHWP 본가의 열린 PR **#8269**(`feat: add memo read and edit API (#8017)`,
작성자 pblsketch, 헤드 `3cd739252372622bfd8a24b0be43bbe94a9a290d`)를 v0.8.7에 맞게 옮긴 것입니다.
rHWP는 MIT 라이선스이며 원 저작권은 PR 작성자와 rHWP 기여자에게 있습니다(`licenses/`의 rHWP 고지를 유지합니다).

## 왜 이식인가

PR의 기준(devel)은 v0.8.7보다 17,015 커밋 앞서 있어 그대로 적용되지 않습니다(`git apply --3way` 시 7개 파일 8곳 충돌).
v0.8.7에 없는 개발판 함수에 기대는 곳만 손으로 옮겼습니다.

- 파서(`src/parser/body_text.rs`): 구역 끝의 `MEMO_LIST`+`LIST_HEADER`+문단을 읽어 같은 번호의 메모 필드에 붙이고, 확장 바탕쪽과 나눠 읽음
- 문단(`src/model/paragraph.rs`): 개발판의 `rebuild_char_offsets`(와 `control_owns_char`)를 가져오고 `memos_within`·`regrow_replaced_memos` 추가
- 편집(`text_editing.rs`, `search_query.rs`): 메모 앵커를 통째로 지우면 메모도 같이 지우고, 본문 글자로 바꾸면 메모를 새 글자에 유지(`replace_range_keeping_memos`). 표 칸 안의 교체(`deleteTextInCell*`+`insertTextInCell*`)에는 이 보존 경로가 없어 앵커 전체를 바꾸면 메모가 지워지고, Android 앱은 이를 알린다(`memosRemoved`)
- 새 파일 `src/document_core/queries/memo_query.rs`와 `wasm_api.rs`의 `getMemoList`/`insertMemo`/`insertMemoByPath`/`setMemoText`/`removeMemo`는 PR 원본 그대로

## 검증

- `cargo check` (네이티브, `wasm32-unknown-unknown`) 통과
- PR 시험 `tests/cases/issue_8017_memo_api.rs`(20건), `issue_8017_memo_hwp5_roundtrip.rs`(3건) 통과 — 한컴 HWP5 샘플의 메모 본문 읽기 포함
- 라이브러리 단위 시험 4,054건 통과, 실패 0건
- v0.8.7의 기존 통합 회귀 시험 중 HWP5/HWPX 왕복·필드·확장 바탕쪽·메모·치환 영역 70개 묶음: 315건 통과, 1건 불일치.
  불일치는 `ir_field_sweep_baseline`의 `issue5169_viewtext_changetracking.hwp`(발산 2건: 메모 본문 줄 캐시 1→0, 헤더 꼬리).
  원인은 이식이 아니라 읽기 방식 차이입니다. 이 샘플은 본문 영역에 한컴이 화면에 그리지 않는 옛 메모가 남아 있고,
  본가 개발판은 수정 #5169("ViewText가 있으면 그것을 우선해 읽는다")로 그 메모를 읽지 않지만 v0.8.7은 읽습니다.
  같은 샘플·같은 측정 코드를 PR 원본(devel)에서 돌리면 메모가 0개로 읽혀 차이가 나지 않습니다. 저장 때 메모 본문의
  줄 정보를 쓰지 않는 것은 v0.8.7에도 있던 규칙(한컴 방식)이며 내용 손실이 아닙니다.
- 시험 묶음 한도(49 > 48)로 본가 방식의 전체 묶음 실행은 하지 못해, 위처럼 영역별로 골라 직접 실행했습니다.
- 이 패치의 `tests/cases/*.rs`는 본가의 시험 묶음(생성 스위트) 기준이므로 v0.8.7에서 돌릴 때는 `tests/` 바로 아래로 복사하고 `Cargo.toml`에 `[[test]]`를 임시로 등록해야 합니다.

## 다시 빌드하는 방법 (이 저장소: Android 앱 엔진)

이 패치는 PC판(hwpxxx 데스크톱)에서 처음 만들어졌지만, **Android 앱의 엔진은 이 저장소의 스크립트로만 빌드합니다.** PC판의 Windows/MinGW·`wasm-pack`
절차(`scripts/wasm-pack-locked.sh`, `scripts/build-editor.mjs`, `config/editor-build.json`, `AI/bin/rhwp-wasm.mjs`)는 이 저장소에 없고 쓰지 않습니다.
고정 값은 모두 `config/android-engine.json`에 있습니다.

| 항목 | 값 |
|---|---|
| 본가 | `https://github.com/edwardkim/rhwp` v0.8.7, 커밋 `1a76570e833917d15817415a53c09ad61ab3203f` |
| 패치 | `0001-rhwp-pr8269-memo-api-backport-to-v0.8.7.patch`, SHA-256은 `config/android-engine.json`의 `patchSha256` |
| Rust | `nightly-2026-02-01` + `rust-src` + `wasm32-unknown-unknown` (본가 `rust-toolchain.toml`이 아니라 스크립트가 이 툴체인을 명시해 선택) |
| 플래그 | `RUSTFLAGS=-Ctarget-cpu=mvp`, `cargo build -Zbuild-std=std,panic_abort --locked` (표준 라이브러리까지 WebAssembly MVP로: API 30 WebView 호환) |
| wasm-bindgen | CLI `0.2.127` (`--target web`) |

```sh
# 1) 본가를 고정 커밋으로 받습니다(GitHub Actions와 같은 희소 체크아웃). 이미 패치된 체크아웃에는 다시 적용되지 않으므로 새로 받습니다.
git clone --filter=blob:none --sparse --branch v0.8.7 --depth 1 https://github.com/edwardkim/rhwp .build/rhwp
git -C .build/rhwp sparse-checkout set src crates tools bindings vendor scripts assets fonts resources .cargo
git -C .build/rhwp rev-parse HEAD            # 1a76570e833917d15817415a53c09ad61ab3203f 이어야 합니다
mkdir -p .build/rhwp/saved && git -C .build/rhwp show HEAD:saved/blank2010.hwp > .build/rhwp/saved/blank2010.hwp
# 2) 패치 적용 + 빌드 + 설치: 패치 해시와 커밋을 검사하고, 결과를 .build/engine 과 app/src/main/assets/engine 에 둡니다.
bash scripts/build-engine.sh .build/rhwp      # 끝에서 scripts/install-engine.mjs 가 build-info.json(고정 값과 SHA-256)을 만듭니다
# 3) 설치된 엔진이 고정 값과 일치하는지: Gradle 의 verifyMemoEngine 이 매 빌드 전에 같은 검사를 합니다.
node scripts/verify-engine.mjs
```

`build-info.json`은 빌드가 만드는 파일이며 저장소에 넣지 않습니다(`.gitignore`). `app/src/main/assets/engine/`의 `rhwp.js`·`rhwp_bg.wasm`·`rhwp.d.ts`는
빌드 결과이므로 이 파일들을 손으로 바꾸거나 PC판 파일을 복사해 넣으면 `verifyMemoEngine`이 빌드를 막습니다.
`build-engine.sh`는 패치를 되돌리지 않으므로 같은 체크아웃에서 두 번 실행하면 실패합니다. 다시 빌드하려면 1)부터 새 체크아웃으로 시작하세요.
