#!/bin/bash
# Makes the mock's sample video (sample-video.mp4) with the media image's
# ffmpeg: 12 s of a test picture and a beep, H.264 and AAC, its index at the
# start, as small as it plays. From the repository's root:
#   docker run --rm -v "$PWD/apps/web/src/mocks:/out" --entrypoint bash dfs-media:dev /out/make-sample-video.sh
set -euo pipefail
cd /out
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i testsrc2=size=384x216:rate=15 \
  -f lavfi -i "sine=frequency=440:sample_rate=44100:beep_factor=4" -t 12 \
  -c:v libx264 -preset veryslow -crf 40 -pix_fmt yuv420p -profile:v high \
  -c:a aac -b:a 32k -ac 1 -movflags +faststart sample-video.mp4
ls -l sample-video.mp4
