#!/usr/bin/env bash
# Sign the CI-built release APK with the maintainer's key and verify the result.
#   KEYSTORE_PASSWORD=... bash scripts/sign-release.sh <unsigned.apk> <signed.apk> <keystore.jks> [expected-version-name]
# The key alias is 'hwpxxx' and the key password equals the store password (see app/build.gradle). The password is read only from the environment
# (never an argument, never printed). Tools come from $APKSIGNER/$AAPT2 or the newest Android build-tools under $ANDROID_HOME.
set -euo pipefail
unsigned="${1:?unsigned APK}"; signed="${2:?output APK}"; keystore="${3:?keystore file}"; want_version="${4:-}"
: "${KEYSTORE_PASSWORD:?set KEYSTORE_PASSWORD}"
alias_name="${KEY_ALIAS:-hwpxxx}"
tools="$(ls -d "${ANDROID_HOME:-/nonexistent}"/build-tools/*/ 2>/dev/null | sort -V | tail -n 1 || true)"
apksigner="${APKSIGNER:-${tools}apksigner}"; aapt2="${AAPT2:-${tools}aapt2}"
[ -x "$apksigner" ] || command -v "$apksigner" >/dev/null || { echo "apksigner not found (set APKSIGNER or ANDROID_HOME)"; exit 1; }
[ -f "$unsigned" ] || { echo "no such APK: $unsigned"; exit 1; }
[ -f "$keystore" ] || { echo "no such keystore: $keystore"; exit 1; }

# 1. The input must be the unsigned release build of the app (not a debug build, not already signed).
if command -v "$aapt2" >/dev/null 2>&1 || [ -x "$aapt2" ]; then
  badging="$("$aapt2" dump badging "$unsigned")"
  pkg="$(sed -n "s/^package: name='\([^']*\)'.*/\1/p" <<<"$badging")"
  version="$(sed -n "s/^package:.* versionName='\([^']*\)'.*/\1/p" <<<"$badging")"
  code="$(sed -n "s/^package:.* versionCode='\([^']*\)'.*/\1/p" <<<"$badging")"
  [ "$pkg" = "kr.offline.hwp" ] || { echo "unexpected application id '$pkg' (expected kr.offline.hwp: the release build, not the .preview debug build)"; exit 1; }
  if grep -q "application-debuggable" <<<"$badging"; then echo "refusing to sign a debuggable APK"; exit 1; fi
  if [ -n "$want_version" ] && [ "${version#"$want_version"}" = "$version" ]; then echo "APK versionName '$version' does not start with the tag version '$want_version'"; exit 1; fi
  echo "input: $pkg versionName=$version versionCode=$code"
else
  echo "warning: aapt2 not found; skipping the package/version checks"
fi

# 2. Sign (v2/v3 only: minSdk is 30; no v1, no v4 side file) and verify.
KS_PASS="$KEYSTORE_PASSWORD" "$apksigner" sign --ks "$keystore" --ks-key-alias "$alias_name" \
  --ks-pass env:KS_PASS --key-pass env:KS_PASS \
  --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true --v4-signing-enabled false \
  --out "$signed" "$unsigned"
verify_out="$(mktemp)"; trap 'rm -f "$verify_out"' EXIT
"$apksigner" verify --verbose --print-certs "$signed" | tee "$verify_out" | sed -n '1,12p'
grep -q "Verifies" "$verify_out" || { echo "apksigner verify failed"; exit 1; }
# minSdk is 30, so a v3 signature (which covers it) is as good as v2; apksigner 35 reports v2 and v3, newer versions may report only v3.
grep -Eq "Verified using v[23] scheme \(APK Signature Scheme v[23]\): true" "$verify_out" || { echo "no v2/v3 signature found"; exit 1; }
cert="$(sed -n 's/^.*certificate SHA-256 digest: //p' "$verify_out" | head -n 1)"
echo "signer certificate SHA-256: $cert"
if [ -n "${EXPECTED_CERT_SHA256:-}" ] && [ "$cert" != "${EXPECTED_CERT_SHA256,,}" ]; then
  echo "the signing certificate is not the expected one (EXPECTED_CERT_SHA256)"; rm -f "$signed"; exit 1
fi
( cd "$(dirname "$signed")" && sha256sum "$(basename "$signed")" ) | tee "${signed}.sha256"
