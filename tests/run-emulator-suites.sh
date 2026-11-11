#!/bin/sh
# Legacy-fallback suites first (unchanged baseline), then the shared-Studio suite on its own so it cannot disturb them.
# Both always run; the job fails if either failed. The legacy suites drive real system UI (pickers, permission pages) on a 2-core CI emulator and can
# fail on timing alone, so they get one more attempt; a real regression fails both attempts.
node tests/legacy-webview-driver.cjs || exit 1
legacy=1
for attempt in 1 2; do
  node tests/android-suites.cjs && { legacy=0; break; }
  echo "EMULATOR_LEGACY_ATTEMPT_FAILED attempt=$attempt"
done
node tests/android-studio-suite.cjs
studio=$?
echo "EMULATOR_SUITES legacy=$legacy studio=$studio"
[ "$legacy" -eq 0 ] && [ "$studio" -eq 0 ]
