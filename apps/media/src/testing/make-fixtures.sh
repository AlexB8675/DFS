#!/bin/bash
# Makes the media service's test files with the image's own ffmpeg, from its
# test sources: nothing binary is kept in the repository. Each is a second or
# two. Run inside the media image: bash make-fixtures.sh <directory>
set -euo pipefail
out=$1
mkdir -p "$out"
cd "$out"
ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }

# A cover picture and chapters, for the files below.
ff -f lavfi -i color=c=red:s=64x64 -frames:v 1 cover.png
cat > chapters.txt <<'EOF'
;FFMETADATA1
title=Chapters
[CHAPTER]
TIMEBASE=1/1000
START=0
END=1000
title=Opening
[CHAPTER]
TIMEBASE=1/1000
START=1000
END=2000
title=Ending
EOF
printf '1\n00:00:00,000 --> 00:00:01,000\nHello\n' > subtitles.srt

# A phone's video: MP4 with H.264 and AAC, held upright, so its picture is
# to be turned a quarter clockwise (ffmpeg keeps the turn only on a copy).
ff -f lavfi -i testsrc2=size=320x240:rate=25 \
  -f lavfi -i sine=frequency=440:sample_rate=48000 -t 2 \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -b:a 64k -shortest upright.mp4
ff -display_rotation -90 -i upright.mp4 -c copy phone.mp4
rm upright.mp4

# A film: MKV with 10-bit HEVC in HDR (PQ), AC-3 in 5.1, a subtitle and chapters.
ff -f lavfi -i testsrc2=size=320x240:rate=24 \
  -f lavfi -i "sine=frequency=220:sample_rate=48000" -i subtitles.srt -i chapters.txt -t 2 \
  -map 0:v -map 1:a -map 2:s -map_metadata 3 -map_chapters 3 \
  -c:v libx265 -preset ultrafast -pix_fmt yuv420p10le \
  -x265-params log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc \
  -c:a ac3 -ac 6 -c:s srt \
  -metadata:s:a:0 language=eng -metadata:s:s:0 language=ita -metadata:s:s:0 title=Italiano \
  -disposition:s:0 forced -shortest film.mkv

# An old download: AVI with MPEG-4 Part 2 and MP3, which no browser plays.
ff -f lavfi -i testsrc2=size=320x240:rate=25 -f lavfi -i sine=frequency=330:sample_rate=44100 \
  -t 2 -c:v mpeg4 -c:a libmp3lame -shortest old.avi

# Music: MP3 with tags and a cover; FLAC with Vorbis comments.
ff -f lavfi -i sine=frequency=550:sample_rate=44100 -i cover.png -t 2 \
  -map 0:a -map 1:v -c:a libmp3lame -c:v png -disposition:v attached_pic -id3v2_version 3 \
  -metadata title='Song' -metadata artist='Artist' -metadata album='Album' \
  -metadata album_artist='Various' -metadata genre='Rock' -metadata track='3/12' \
  -metadata disc='1/2' -metadata date='2019-05-01' song.mp3
ff -f lavfi -i sine=frequency=660:sample_rate=48000 -t 2 -c:a flac \
  -metadata TITLE='Track' -metadata ARTIST='Band' -metadata TRACKNUMBER=5 \
  -metadata DATE=2001 track.flac

# Not audio or video at all; and a picture, which ffmpeg would open as a
# video, but which isn't one of the containers DFS plays.
printf 'Just some notes.\n' > notes.txt
cp cover.png picture.png

# Files that name other files: a playlist and a concat list. ffmpeg must not
# open either (ffprobe.ts), or it would read what they name.
printf '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nfile:///etc/passwd\n#EXTINF:2,\nhttp://127.0.0.1:1/elsewhere\n#EXT-X-ENDLIST\n' > playlist.m3u8
printf "ffconcat version 1.0\nfile 'file:/etc/passwd'\n" > list.ffconcat

rm cover.png chapters.txt subtitles.srt
ls
