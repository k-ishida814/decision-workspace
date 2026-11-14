# Sourced by the vhs tapes (docs/media/tapes/*.tape) from the repository root: an isolated
# demo with its own daemon socket, settings and project under /tmp/dwdemo, so recording never
# touches your real decisions. Agents use haiku (fast and cheap) and call the real model.
REPO="$(pwd)"
export DW_SOCKET=/tmp/dwdemo/d.sock
export DW_CONFIG=/tmp/dwdemo/config.json
export DW_NOTIFY=0
dw() { bun "$REPO/apps/cli/src/main.ts" "$@"; }
pkill -f "daemon run --socket /tmp/dwdemo/d.sock" 2>/dev/null
sleep 0.3
rm -rf /tmp/dwdemo
mkdir -p /tmp/dwdemo/notes-app/.git
cd /tmp/dwdemo/notes-app || exit 1
printf '# Notes\n\nOffline-first notes app for macOS, written in Swift. Single user today.\n' > README.md
dw config set agents.model haiku > /dev/null
export PS1='\[\e[38;5;245m\]notes-app\[\e[0m\] $ '
clear
