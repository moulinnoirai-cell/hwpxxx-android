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
- 편집(`text_editing.rs`, `search_query.rs`): 메모 앵커를 통째로 지우면 메모도 같이 지우고, 글자로 바꾸면 메모를 새 글자에 유지(`replace_range_keeping_memos`)
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

## 다시 빌드하는 방법 (Windows, 영문 경로 필수)

Rust(1.93.1 gnu + wasm32), MinGW-w64, `wasm-bindgen-cli 0.2.127`, `wasm-pack 0.15.0`은 전역 설치돼 있습니다(`docs/MAINTENANCE.md` 참고). 한글이 들어간 경로에서는 MinGW 링커가 파일을 열지 못하므로 `CARGO_TARGET_DIR`을 영문 경로로 지정합니다.

```sh
git -C <upstream>/rhwp-0.8.7 worktree add --detach <영문경로>/rhwp-engine 1a76570e833917d15817415a53c09ad61ab3203f   # 전체 체크아웃(약 5GB, 파일 본문은 GitHub에서 받음). 빌드가 끝나면 git worktree remove로 지웁니다.
cd <영문경로>/rhwp-engine && git apply --whitespace=nowarn <소스>/patches/rhwp-engine/0001-*.patch
export CARGO_TARGET_DIR=C:/rhwp-target        # 영문 경로
sh scripts/wasm-pack-locked.sh --target web --release --no-opt --out-dir pkg   # pkg/rhwp.js, rhwp_bg.wasm
```

결과(`rhwp.js`, `rhwp_bg.wasm`)는 편집기 빌드의 `--core` 묶음(`scripts/build-editor.mjs`)으로 들어가며, 해시는 `config/editor-build.json`에 고정합니다.
`AI/bin/rhwp-wasm.mjs`는 같은 `rhwp.js`의 복사본입니다(`scripts/build.mjs`가 복사).
네이티브 CLI(`hwpxxx-native.exe`)는 공식 0.8.7을 그대로 씁니다. 이 CLI의 `fields` 등은 HWP5 메모 본문을 읽지 못하므로,
메모 도구는 WASM 엔진을 씁니다.

