#!/bin/bash
# Makes the mock's sample audio (sample-audio.mp3) and the cover every demo
# track shows (sample-cover.jpg) with the media image's ffmpeg: 10 s of a
# chord, MP3, mono and small; and a picture of 240×240. From the
# repository's root:
#   docker run --rm -v "$PWD/apps/web/src/mocks:/out" --entrypoint bash dfs-media:dev /out/make-sample-audio.sh
set -euo pipefail
cd /out
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=262:sample_rate=22050" \
  -f lavfi -i "sine=frequency=330:sample_rate=22050" \
  -f lavfi -i "sine=frequency=392:sample_rate=22050" \
  -filter_complex "amix=inputs=3,afade=t=in:d=0.5,afade=t=out:st=9:d=1" -t 10 \
  -c:a libmp3lame -b:a 32k -ac 1 -id3v2_version 3 sample-audio.mp3
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "gradients=size=240x240:c0=0x2b4c7e:c1=0xc9724a:seed=7:duration=1" \
  -frames:v 1 -q:v 6 sample-cover.jpg
ls -l sample-audio.mp3 sample-cover.jpg
