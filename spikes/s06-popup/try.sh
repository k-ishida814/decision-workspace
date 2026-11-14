#!/bin/sh
# S-06: show the popup after a delay (keep typing in this terminal meanwhile) and print what it
# returns.  Usage: spikes/s06-popup/try.sh [delay-seconds] [one|two]
cd "$(dirname "$0")/src-tauri" || exit 1
BIN=target/release/dw-popup-spike
[ -x "$BIN" ] || cargo build --release || exit 1
DELAY=${1:-3}
if [ "${2:-one}" = "two" ]; then
  QUESTIONS='[{"question":"保存先は？","options":[{"label":"SQLite","description":"ローカルで完結"},{"label":"クラウド","description":"複数端末で共有"}]},{"question":"同期の方式は？","options":[{"label":"リアルタイム"},{"label":"手動"}]}]'
else
  QUESTIONS='[{"question":"保存先は？","options":[{"label":"SQLite","description":"ローカルで完結"},{"label":"クラウド","description":"複数端末で共有"}]}]'
fi
echo "popup in ${DELAY}s — keep typing here to see whether it steals the keyboard"
sleep "$DELAY"
printf '{"type":"show","origin":{"project":"notes-app","session":"a1b2c3","at":"%s"},"more":1,"questions":%s}\n' \
  "$(date +%H:%M)" "$QUESTIONS" | "$BIN" 2>/dev/null
echo "(popup exited)"
