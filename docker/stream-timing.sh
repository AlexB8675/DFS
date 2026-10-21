#!/usr/bin/env bash
# Times a video's start and its seeks through a share link, read the way a
# player reads it (DESIGN.md §6.2): the playback call, the file's head, the
# index at its end, a stretch of play, then seeks, each read at 15 MB/s (a
# 120 Mbit/s video) for a few seconds. Run it on the VPS against the lab, the
# frame cache cleared first for a cold run, then again at once for a warm one.
# The reads of a run group as one stream session (one address and user agent,
# the run's label in it), which `dfs timelines` lists and `dfs timeline` reads
# back with each read's first byte, sources and waits. Reads ask for a preview
# (`?preview=1`), so they don't count as downloads of the link.
#
# With `burst` after the label, it reads as a viewer dragging the seek bar
# does instead: ten reads at scattered places, each given up after 0.3 s, so
# the session's timeline shows whether any of them set the server reading
# ahead (§6.2: a read must send 2 MiB first).
#
# Usage: stream-timing.sh <base-url> <link-token> <node-id> <size> [label] [burst]
set -euo pipefail

if [ "$#" -lt 4 ]; then
  echo "usage: $0 <base-url> <link-token> <node-id> <size> [label] [burst]" >&2
  exit 2
fi
base=$1 token=$2 node=$3 size=$4 label=${5:-run} mode=${6:-play}
files="$base/api/s/$token/files/$node"
agent="dfs-stream-timing ($label)"

# One read: its label, its range, and optionally a rate and a time limit. A read
# cut off by its time limit (curl's exit 28) is what a player that seeks does.
read_range() {
  local name=$1 range=$2 rate=${3:-} seconds=${4:-}
  local limits=()
  if [ -n "$rate" ]; then limits+=(--limit-rate "$rate"); fi
  if [ -n "$seconds" ]; then limits+=(--max-time "$seconds"); fi
  printf '%-8s %-22s ' "$name" "$range"
  curl -sS -o /dev/null -A "$agent" -r "$range" "${limits[@]}" \
    -w '%{http_code} first=%{time_starttransfer}s bytes=%{size_download} rate=%{speed_download}B/s\n' \
    "$files/content?preview=1" 2>/dev/null || true
}

at() { echo $((size * $1 / 100)); }

if [ "$mode" = burst ]; then
  for percent in 12 47 23 81 35 66 9 58 92 74; do
    read_range "s-$percent" "$(at "$percent")-" 15M 0.3
  done
  exit 0
fi

printf '%-8s %-22s ' playback ''
curl -sS -o /dev/null -A "$agent" -w '%{http_code} total=%{time_total}s\n' "$files/playback"
read_range head 0-65535
read_range index -131072
read_range play 65536- 15M 8
read_range seek-40 "$(at 40)-" 15M 4
read_range seek-75 "$(at 75)-" 15M 4
read_range back-41 "$(at 41)-" 15M 2
read_range seek-20 "$(at 20)-" 15M 4
