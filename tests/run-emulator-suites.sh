#!/bin/sh
# Legacy-fallback suites first (unchanged baseline), then the shared-Studio suite on its own so it cannot disturb them.
# Both always run; the job fails if either failed.
node tests/legacy-webview-driver.cjs && node tests/android-suites.cjs
legacy=$?
node tests/android-studio-suite.cjs
studio=$?
echo "EMULATOR_SUITES legacy=$legacy studio=$studio"
[ "$legacy" -eq 0 ] && [ "$studio" -eq 0 ]
