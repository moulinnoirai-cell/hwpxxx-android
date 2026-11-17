#!/usr/bin/env bash
# Public repository guard: every commit must carry a GitHub noreply author and committer address, so a personal name/e-mail
# configured on a developer machine never reaches the published history.
#   bash scripts/check-commit-identity.sh [<rev-range or ref> ...]     (default: HEAD = the whole history of the checked-out commit)
# Exit 0 when every commit in the range passes, 1 otherwise (offending commits are listed without printing the address).
# As a local pre-push hook (.git/hooks/pre-push, executable):
#   #!/bin/sh
#   exec bash "$(git rev-parse --show-toplevel)/scripts/check-commit-identity.sh" --pre-push "$@"
set -euo pipefail

allowed='^([0-9]+\+)?[A-Za-z0-9-]+@users\.noreply\.github\.com$|^noreply@github\.com$'
revs=("$@")
# --pre-push: called from git's pre-push hook; the refs to push come on stdin.
if [ "${1:-}" = "--pre-push" ]; then
  revs=()
  while read -r _local_ref local_sha _remote_ref remote_sha; do
    case "$local_sha" in *[!0]*) ;; *) continue ;; esac            # deleting a ref
    case "$remote_sha" in *[!0]*) revs+=("$remote_sha..$local_sha") ;; *) revs+=("$local_sha") ;; esac
  done
  [ "${#revs[@]}" -gt 0 ] || exit 0
fi
[ "${#revs[@]}" -gt 0 ] || revs=(HEAD)

bad=0
while IFS=$'\t' read -r sha author committer; do
  for address in "$author" "$committer"; do
    if ! printf '%s\n' "$address" | grep -Eq "$allowed"; then
      echo "commit ${sha:0:12}: author or committer address is not a GitHub noreply address" >&2
      bad=1
      break
    fi
  done
done < <(git log --format='%H%x09%ae%x09%ce' "${revs[@]}")

if [ "$bad" -ne 0 ]; then
  echo "Set a noreply identity before committing:  git config user.email '<id>+<login>@users.noreply.github.com'" >&2
  exit 1
fi
echo "commit identity: ok"
