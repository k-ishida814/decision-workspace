# Changing an earlier answer in the Graph: what depends on it is re-checked or skipped.
# Run from the repository root: vhs docs/media/tapes/graph.tape
Output docs/media/graph.gif
Source docs/media/tapes/_settings.tape
Set Height 440

Hide
Type "source docs/media/demo/env.sh" Enter
Sleep 1s
Type "bun $REPO/docs/media/demo/seed.ts plan </dev/null >/dev/null 2>&1; dw tui" Enter
Wait+Screen@15s /Decision Workspace/
Tab 3
Wait+Screen@5s /\(no plan\)|P-1/
Sleep 500ms
Show
Sleep 2.5s
# D-1 "Storage = Cloud" → change it
Type "u"
Wait+Screen@5s /Answer again/
Sleep 1.5s
Type "1"
Sleep 800ms
Enter
Sleep 1.5s
Tab 3
Wait+Screen@5s /condition not met/
Sleep 4s
Hide
Type "q"
