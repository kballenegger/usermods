#!/bin/sh
# One frame every 3 seconds of a rendered video, tiled 4 across in time order (left to right,
# top to bottom: 0:00, 0:03, 0:06, ...), for review. No text labels, so it needs no drawtext.
#   sh scripts/contact-sheet.sh out/usermods-launch.mp4 out/contact-sheet.png [every-seconds]
set -eu
in="$1"
out="$2"
every="${3:-3}"
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$in")
n=$(awk -v d="$dur" -v e="$every" 'BEGIN { n = int(d / e); if (n * e < d) n++; print n }')
rows=$(( (n + 3) / 4 ))
ffmpeg -v error -y -i "$in" -vf "select='isnan(prev_selected_t)+gte(t-prev_selected_t\,${every})',scale=480:-1:flags=lanczos,tile=4x${rows}:padding=6:margin=6:color=0x030b16" -fps_mode vfr -frames:v 1 "$out"
echo "$out ($n frames, every ${every}s)"
