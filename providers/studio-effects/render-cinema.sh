#!/bin/zsh
# SLIT-SCAN CINEMA. One COMPLETE SWEEP becomes ONE FRAME.
#
# This cannot run in real time and that is intrinsic, not a limitation to
# engineer away: a sweep takes seconds and a frame lasts 1/12 of one. So it is an
# OFFLINE RENDER — run a short sweep, keep the finished tape as a frame, run the
# next one. The source keeps playing throughout, so consecutive frames are built
# from consecutive stretches of footage and the film moves.
# $1 label  $2 source  $3 spec  $4 frames
S=fx
rm -rf cine-$1 && mkdir -p cine-$1
SPEC=$(cat "$3")
for n in $(seq -f "%03g" 1 $4); do
  curl -s -m 5 -X POST http://127.0.0.1:9342/api/effects/drive -H 'content-type: application/json' \
    -d "{\"scanner\":{\"source\":\"$2\",\"spec\":$SPEC,\"clear\":true,\"record\":true}}" >/dev/null
  for i in {1..40}; do
    sleep 1
    agent-browser --session $S eval 'document.querySelector("#status").textContent.slice(0,20)' 2>/dev/null | tail -1 | grep -q "clip ready" && break
  done
  agent-browser --session $S eval --stdin > /tmp/cf.json <<'EOF'
document.querySelectorAll('canvas')[1].toDataURL('image/png')
EOF
  python3 -c "
import json,base64,pathlib
s=json.loads(pathlib.Path('/tmp/cf.json').read_text().strip())
pathlib.Path('cine-$1/f$n.png').write_bytes(base64.b64decode(s.split(',',1)[1]))"
done
ffmpeg -v error -y -framerate 12 -pattern_type glob -i "cine-$1/*.png" -c:v libx264 -pix_fmt yuv420p -crf 18 "$HOME/Desktop/studio-workspace/media/exp-cinema-$1.mp4"
echo "cinema $1: $(ls cine-$1/*.png | wc -l | tr -d ' ') sweeps -> exp-cinema-$1.mp4"
