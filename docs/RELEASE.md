# 릴리스 절차 (서명 APK 자동 배포)

`v*` 태그를 푸시하면 GitHub Actions가 빌드 → 에뮬레이터 테스트 → **서명 → GitHub 릴리스 게시**까지 자동으로 합니다.
서명 키는 저장소에 없고, 저장소 소유자가 GitHub Secrets로만 등록합니다 (채팅·코드·로그에 키/비밀번호를 남기지 마세요).

## 1. 최초 1회 설정

### 1-1. 서명 키
정식 서명 키는 `hwpxxx-release.p12`(PKCS12, 별칭 `hwpxxx`, 키 비밀번호 = 저장소 비밀번호)입니다.
인증서 SHA-256은 `D7:76:31:91:85:4C:02:A1:E2:58:9D:C6:9C:92:52:1F:10:F0:ED:ED:2E:BD:31:0B:07:D6:5F:B6:9C:B7:F4:C8`이고,
워크플로는 서명 인증서가 이 값과 다르면 릴리스를 거부합니다(키가 바뀌면 설치된 앱이 업데이트되지 않기 때문).

> **v0.2.0(이전 키 `6bed3763…4423`)을 설치한 기기**는 이 키로 서명한 앱 위로 업데이트되지 않습니다. 문서를 내보낸 뒤 앱을 지우고 새로 설치하세요.
> 미리보기 빌드(`kr.offline.hwp.preview`)는 별개 앱이라 영향이 없습니다.
> 키 파일과 비밀번호는 분실하면 같은 앱의 업데이트 서명이 불가능합니다. 키 파일을 PC·클라우드 등 두 곳 이상에 백업하세요. 저장소에는 절대 커밋하지 않습니다(`.gitignore`가 `*.p12`, `*.jks`, `*.keystore`를 막음).

지문 확인 (비밀번호는 `read -s`로 입력, 채팅·로그에 남기지 않기):
```
read -rs KS_PW; export KS_PW
keytool -list -v -keystore hwpxxx-release.p12 -storetype PKCS12 -storepass:env KS_PW | grep -E "Alias|SHA256"; unset KS_PW
```

### 1-2. Secrets 등록 (PC, `gh` 로그인 상태)
```bash
# 리눅스/맥/Git Bash
base64 -w0 hwpxxx-release.p12 | gh secret set RELEASE_KEYSTORE_BASE64 --env release -R moulinnoirai-cell/hwpxxx-android
gh secret set RELEASE_KEYSTORE_PASSWORD --env release -R moulinnoirai-cell/hwpxxx-android   # 비밀번호를 프롬프트에 입력
```
```powershell
# Windows PowerShell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("hwpxxx-release.p12")) | gh secret set RELEASE_KEYSTORE_BASE64 --env release -R moulinnoirai-cell/hwpxxx-android
gh secret set RELEASE_KEYSTORE_PASSWORD --env release -R moulinnoirai-cell/hwpxxx-android
```
`--env release`는 `release` Environment에 등록한다는 뜻입니다. Environment가 없으면 첫 실행 때 자동 생성되지만, 먼저 만들어 두려면:
```
gh api -X PUT repos/moulinnoirai-cell/hwpxxx-android/environments/release
```

### 1-3. Environment 보호 (설정됨)
GitHub → Settings → Environments → `release`에 다음이 걸려 있습니다.
- **Required reviewers**: 저장소 소유자. 태그를 푸시하면 `release` 작업이 서명 직전에 멈추고, Actions 실행 화면에서 **Review deployments → Approve**를 눌러야 서명·게시가 진행됩니다.
- **Deployment branches and tags**: `v*` 태그만. 다른 브랜치·태그의 작업은 서명 키를 쓸 수 없습니다.

### 1-4. 공개 저장소 안전장치
- **커밋 작성자 주소**: `identity` 작업이 이력의 모든 커밋에서 작성자·커미터 주소가 GitHub noreply 주소인지 검사합니다(`scripts/check-commit-identity.sh`). 하나라도 아니면 실패하고 `release` 작업도 진행되지 않습니다.
  이미 푸시된 주소는 되돌릴 수 없으므로, 작업하는 기기에서는 같은 스크립트를 pre-push 훅으로 걸어 푸시 전에 막습니다(스크립트 머리말 참고). 커밋 전에 `git config user.email`이 noreply 주소인지 확인하세요.
- **비공개 금지 목록(작업 기기 전용)**: `.git/info/identity-denylist`에 정규식을 한 줄에 하나씩 적어 두면(실명, 개인 메일 등) pre-push 훅이 푸시할 커밋의 작성자·메시지·추가한 줄·파일 이름을 검사해, 걸리면 푸시를 막습니다. 목록 자체가 개인정보라 저장소에 넣지 않으며 CI는 이 검사를 하지 않습니다. PR 제목·본문·댓글은 git 밖이라 검사 대상이 아닙니다.
- **비밀값 푸시 차단**: 저장소의 Secret scanning과 Push protection이 켜져 있습니다.

## 2. 릴리스하기

1. `app/build.gradle`의 `versionName`을 올리고, `versionCode`는 **이전 릴리스보다 큰 정수**로 올립니다
   (v0.2.0 = 4, v0.3.0 = 5, v0.3.1 = 6, v0.3.2 = 7, v0.3.3 = 8, v0.3.4 = 9, v0.4.0 = 10, v0.4.1 = 11, v0.4.2 = 12, 이후 13, 14, …). PR → `main` 머지.
   병합 커밋 작성자가 계정 기본 메일이 되지 않게, GitHub의 병합 단추나 `gh pr merge`를 쓰지 않습니다(계정 기본 메일이 작성자로 들어가고, `--author-email`은 noreply 주소를 거부합니다).
   대신 noreply 주소로 설정한 작업 기기에서 `git merge --no-ff origin/<브랜치> -m "Merge pull request #N from <owner>/<브랜치>"` 후 `main`을 푸시합니다. PR은 자동으로 병합됨으로 바뀝니다.
2. `main`의 해당 커밋에 태그를 달고 푸시합니다.
   ```bash
   git checkout main && git pull
   git tag v0.3.0
   git push origin v0.3.0
   ```
3. Actions 탭에서 `Android tablet build` 실행을 확인합니다. 모두 통과하면 `release` 작업이 서명 후 릴리스를 만들고 APK와 `.sha256`을 첨부합니다.

규칙:
- 태그의 버전(`v0.3.1-rc.1` → `0.3.1`)이 APK의 `versionName` 앞부분과 같아야 합니다.
- 태그가 `-`를 포함하면(예: `v0.3.1-rc.1`) **사전 릴리스**로 표시됩니다.
- 태그 커밋이 `main`에 포함돼 있지 않으면 거부됩니다.
- 디버그 빌드(`kr.offline.hwp.preview`)나 이미 서명된 APK는 서명 스크립트가 거부합니다.
- 실패한 릴리스 재시도: 태그를 지우고(`git push --delete origin vX`, `git tag -d vX`) 고친 뒤 다시 태그합니다.

로컬에서 같은 검증을 해 보려면 (Android build-tools 필요):
```bash
KEYSTORE_PASSWORD=... EXPECTED_CERT_SHA256=d7763191854c02a1e2589dc69c92521f10f0eded2ebd310b07d65fb69cb7f4c8 \
  bash scripts/sign-release.sh app-release-unsigned.apk hwpxxx-0.3.0.apk hwpxxx-release.p12 0.3.0
```

## 3. rhwp 업스트림 점검 (2주마다)

`.github/workflows/upstream-check.yml`이 매주 월요일 03:17 UTC에 돌고, **짝수 ISO 주에만** 실제 점검합니다(2주 주기).
- 최신 안정 태그(`vX.Y.Z`)가 `config/android-studio.json`의 `upstreamTag`보다 새로우면, 그 태그에 hwpxxx 패치 시리즈를 시험 적용하고
  패치별 적용 결과, `package-lock.json` 해시 변화, wasm-bindgen 버전 변화를 보고합니다.
- 결과는 실행 요약(Step summary)과 이슈 `rhwp vX.Y.Z 업데이트 확인`(이미 열려 있으면 댓글)에 남습니다.
- 코드는 바꾸지 않습니다. 이식은 사람이 합니다: 설정 핀(`upstreamTag`, `commit`, `packageLockSha256`, 엔진 핀) 갱신 → 패치 재생성 → 테스트 → PR.
- 수동 실행: `gh workflow run upstream-check.yml` (특정 태그: `-f tag=v0.9.1`).
