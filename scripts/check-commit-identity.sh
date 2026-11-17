#!/usr/bin/env bash
# Public repository guard: every commit must carry a GitHub noreply author and committer address, so a personal name/e-mail
# configured on a developer machine never reaches the published history.
#   bash scripts/check-commit-identity.sh [<rev-range or ref> ...]     (default: HEAD = the whole history of the checked-out commit)
# Exit 0 when every commit in the range passes, 1 otherwise (offending commits are listed without printing the address).
#
# Private deny list (optional, never committed): a file of extended regular expressions, one per line (# starts a comment), matched
# without regard to case. With one, every commit in the range is also refused when its author/committer name or address, its message,
# a line it adds or a path it touches matches: personal names, private e-mail addresses and the like. The list itself is personal
# data, so it lives outside the tracked tree; the default location is <git dir>/info/identity-denylist (override: IDENTITY_DENYLIST).
# Matches are reported by commit and path only; the matched text is not printed.
#
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
address_bad=0
listed=0
while IFS=$'\t' read -r sha author committer; do
  for address in "$author" "$committer"; do
    if ! printf '%s\n' "$address" | grep -Eq "$allowed"; then
      echo "commit ${sha:0:12}: author or committer address is not a GitHub noreply address" >&2
      bad=1; address_bad=1
      break
    fi
  done
done < <(git log --format='%H%x09%ae%x09%ce' "${revs[@]}")

denylist="${IDENTITY_DENYLIST:-$(git rev-parse --git-path info/identity-denylist)}"
patterns=""
if [ -f "$denylist" ]; then
  patterns="$(mktemp)"; trap 'rm -f "$patterns"' EXIT
  grep -v -E '^[[:space:]]*(#|$)' "$denylist" > "$patterns" || true
fi
if [ -n "$patterns" ] && [ -s "$patterns" ]; then
  while read -r sha; do
    if git show -s --format='%an%n%ae%n%cn%n%ce%n%B' "$sha" | grep -E -i -q -f "$patterns"; then
      echo "commit ${sha:0:12}: the author, committer or message matches the private deny list" >&2
      bad=1; listed=1
    fi
    # Added lines and touched paths, each prefixed with its path so the report can name the file.
    while read -r path; do
      echo "commit ${sha:0:12}: $path adds text (or has a name) that matches the private deny list" >&2
      bad=1; listed=1
    done < <(git show --format= --no-color -U0 --no-ext-diff "$sha" \
      | awk '/^\+\+\+ /{f=substr($0,5); sub(/^b\//,"",f); print f "\t" f; next} /^\+/{print f "\t" substr($0,2)}' \
      | grep -a -E -i -f "$patterns" | cut -f1 | sort -u)
  done < <(git rev-list "${revs[@]}")
fi

if [ "$bad" -ne 0 ]; then
  [ "$address_bad" -eq 0 ] || echo "Set a noreply identity before committing:  git config user.email '<id>+<login>@users.noreply.github.com'" >&2
  [ "$listed" -eq 0 ] || echo "Text matching the private deny list has to be removed from the commits themselves (amend or rebase) before pushing." >&2
  exit 1
fi
if [ -n "$patterns" ] && [ -s "$patterns" ]; then echo "commit identity: ok (addresses and private deny list)"; else echo "commit identity: ok (addresses)"; fi
exit 0
