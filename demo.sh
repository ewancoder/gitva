#!/usr/bin/env bash
# A guided tour of everything gitva draws. Starts gitva on a throwaway repo in
# ./example, runs the tour against it, and stops gitva when you are done.
#
#   ./demo.sh                             on a 1s timer; enter skips ahead, any other key pauses
#   ./demo.sh [seconds-between-steps]     same, at your own pace
#   ./demo.sh 0                           untimed: enter for each step
#
# q quits, at a step or at a pause.
set -eu

DELAY=${1:-1}
# Zero or less means untimed — one step per keypress.
awk -v d="$DELAY" 'BEGIN { exit !(d > 0) }' || DELAY=
REPO="$(cd "$(dirname "$0")" && pwd)/example"

# The author's global config signs commits, and a signing prompt would hang the tour.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
# ./example sits inside gitva's own checkout, so before `git init` runs, git
# discovery would walk up and answer with *this* repository — gitva would draw
# it, and a step that ran before the init would commit into it. The ceiling
# stops the walk at the folder above.
export GIT_CEILING_DIRECTORIES="$(cd "$(dirname "$0")" && pwd)"
export GIT_AUTHOR_NAME=Ada GIT_AUTHOR_EMAIL=ada@example.com
export GIT_COMMITTER_NAME=Ada GIT_COMMITTER_EMAIL=ada@example.com

bold=$(printf '\033[1m'); dim=$(printf '\033[2m'); off=$(printf '\033[0m')
n=0

quit_if_q() {
	if [ "${1-}" = q ]; then printf '\nstopped.\n'; exit 0; fi
}

pause_or_wait() {
	if [ ! -t 0 ]; then
		if [ -n "$DELAY" ]; then sleep "$DELAY"; fi
		return 0
	fi
	local key=
	if [ -z "$DELAY" ]; then                    # untimed: one step per keypress
		printf '%s    [enter to run it, q to quit]%s\n' "$dim" "$off"
		read -rsn1 key || true
		quit_if_q "$key"
		return 0
	fi
	if read -rsn1 -t "$DELAY" key; then         # timed: enter skips on, anything else pauses
		quit_if_q "$key"
		if [ -n "$key" ]; then
			printf '%s    [paused — any key to resume, q to quit]%s\n' "$dim" "$off"
			read -rsn1 key || true
			quit_if_q "$key"
		fi
	fi
	return 0
}

queued=()

# The commands are shown when the step is announced and only run after the pause,
# so the reader knows what is about to happen to the repo before it happens.
flush() {
	[ "${#queued[@]}" -gt 0 ] || return 0
	local line
	for line in "${queued[@]}"; do eval "$line"; done
	queued=()
}

step() {                      # step "what to look for on screen"
	if [ "$n" -gt 0 ]; then pause_or_wait; flush; fi
	n=$((n + 1))
	printf '\n%s%2d. %s%s\n' "$bold" "$n" "$1" "$off"
}

run() {                       # run "shell line"  — echoed now, executed after the pause
	printf '%s    $ %s%s\n' "$dim" "$1" "$off"
	queued+=("$1")
}

# The tour starts before the repository does, so `git init` itself is a step on
# screen. Empty the folder rather than remove it: gitva is about to watch it.
mkdir -p "$REPO"
find "$REPO" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/dist/src/cli.js" ] || (cd "$HERE" && npm run build)

LOG=$(mktemp)
gitva_pid=
stop_gitva() { [ -n "$gitva_pid" ] && kill "$gitva_pid" 2>/dev/null; rm -f "$LOG"; }
trap stop_gitva EXIT

# --port 0 so a second copy of the tour does not collide; --fresh so the
# recording starts at this run rather than replaying the last one.
node "$HERE/dist/src/cli.js" "$REPO" --port 0 --learning --fresh > "$LOG" 2>&1 &
gitva_pid=$!
URL=
for _ in 1 2 3 4 5 6 7 8 9 10; do
	URL=$(sed -n 2p "$LOG"); [ -n "$URL" ] && break
	sleep 0.5
done
[ -n "$URL" ] || { cat "$LOG"; echo "gitva did not start"; exit 1; }

cd "$REPO"

echo "gitva demo — repo: $REPO, watching at $URL"
if [ -n "$DELAY" ]; then
	echo "${DELAY}s between steps — enter skips ahead, any other key pauses, q quits"
else
	echo "enter for each step, q quits"
fi

step "A fresh empty repository: nothing but HEAD, pointing at a branch that does not exist yet."
run "git init -q -b main ."
run "git config user.name Ada; git config user.email ada@example.com"

step "A blob written by hand, that nothing points at: a ghost from the moment it exists."
run "printf 'a stray thought\n' | git hash-object -w --stdin"

step "git add a.txt b.txt — two blobs, two index entries, wired to the blobs they stage."
run "printf 'alpha\n' > a.txt; printf 'beta\n' > b.txt"
run "git add a.txt b.txt"

step "git reset b.txt — the index entry goes; the blob survives, now a ghost."
run "git reset -q b.txt"

step "Staged again, and committed: a commit, its tree, and the two blobs under it."
run "git add b.txt"
run "git commit -q -m 'alpha and beta'"

step "A nested directory — a tree inside a tree."
run "mkdir -p lib; printf 'def f(): pass\n' > lib/f.py"
run "git add lib/f.py; git commit -q -m 'add lib/f.py'"

step "Change one file: a new commit, a new tree, and the untouched blobs shared with the parent."
run "printf 'alpha, revised\n' > a.txt"
run "git add a.txt; git commit -q -m 'revise alpha'"

step "Plumbing by hand: write-tree + commit-tree, the commit git makes for you, made yourself."
run "printf 'from plumbing\n' > c.txt; git add c.txt"
run "TREE=\$(git write-tree); C=\$(git commit-tree \$TREE -p HEAD -m 'commit-tree by hand'); git update-ref refs/heads/main \$C"
run "git reset -q --mixed HEAD"

step "An annotated tag — a real object with its own sha — and a lightweight one, just a ref."
run "git tag -a v1 -m 'version one'"
run "git tag v1-lightweight HEAD~1"

step "A second branch, and a commit on it: the graph forks into lanes."
run "git checkout -q -b feature"
run "printf 'feature work\n' > feature.txt; git add feature.txt; git commit -q -m 'start the feature'"

step "Another author, so search-by-author has something to find."
run "printf 'more feature work\n' >> feature.txt"
run "GIT_AUTHOR_NAME=Grace GIT_AUTHOR_EMAIL=grace@example.com git commit -q -am 'continue the feature'"

step "Back on main, a commit of its own: two lanes, both ahead of where they split."
run "git checkout -q main"
run "printf 'main moves on\n' > d.txt; git add d.txt; git commit -q -m 'main moves on'"

step "git merge --no-ff — a merge commit with two parents."
run "git merge -q --no-ff -m 'merge feature' feature"

step "A conflicting merge: three staged versions of one path, drawn dashed."
run "git checkout -q -b spike HEAD~2"
run "printf 'spike version\n' > a.txt; git commit -q -am 'spike edits alpha'"
run "git checkout -q main"
run "printf 'main version\n' > a.txt; git commit -q -am 'main edits alpha'"
run "git merge spike || true"

step "Resolved: the stages collapse into one entry, and the merge commit closes the fork."
run "printf 'both versions reconciled\n' > a.txt; git add a.txt"
run "git commit -q --no-edit"

step "A commit thrown away by reset --hard: it keeps its tree and its parents, all ghosts now."
run "printf 'this will be discarded\n' > doomed.txt; git add doomed.txt; git commit -q -m 'a commit to discard'"
run "git reset -q --hard HEAD~1"

step "Detached HEAD: HEAD holds a sha instead of pointing at a branch."
run "git checkout -q --detach HEAD~2"

step "Attached again."
run "git checkout -q main"

step "A remote-tracking ref, coloured as what it is."
run "git update-ref refs/remotes/origin/main refs/heads/main"

step "git pack-refs — the branch files vanish into .git/packed-refs; the pointers do not change."
run "git pack-refs --all"

step "git gc — everything packed. To git there is no difference, and the picture says so."
run "git gc -q"   # no --prune: the ghosts have to survive, they are half the picture

step "One last bare blob, so the change signal has to notice an object nothing points at."
run "printf 'the last word\n' | git hash-object -w --stdin"

pause_or_wait
flush

echo
echo "${bold}done.${off} ${n} steps. Things to try by hand now, at $URL:"
echo "  · click a blob, a tree, a commit, a tag, a ref chip — read the panel"
echo "  · double-click a commit or a tree to expand it, right-click to mark, drag to pin"
echo "  · view toolbar: expand/collapse all · index · unreachable · links from unreachable"
echo "  · f fit · [ ] step through the recording · space pause · i index"
echo
printf '%s[enter to stop gitva]%s\n' "$dim" "$off"
[ -t 0 ] && read -r _ || true
