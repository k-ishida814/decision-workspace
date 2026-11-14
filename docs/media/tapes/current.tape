# Answering in the Current view: two questions from Claude Code, one at a time, with a reason.
# Run from the repository root: vhs docs/media/tapes/current.tape
Output docs/media/current.gif
Source docs/media/tapes/_settings.tape

Hide
Type "source docs/media/demo/env.sh" Enter
Sleep 1s
# Claude Code asks (as the hook would) shortly after the TUI opens.
Type "(DEMO_DELAY_MS=2500 bun $REPO/docs/media/demo/seed.ts ask </dev/null >/dev/null 2>&1 &) ; dw tui" Enter
Sleep 2s
Show
Wait+Screen@15s /Where should the notes be stored/
Sleep 1.5s
Down Sleep 600ms
Type "w" Sleep 400ms
Type "works offline, nothing to sync yet" Sleep 500ms
Enter Sleep 800ms
Enter
Wait+Screen@5s /Which features go into the first release/
Sleep 1.2s
Type "1" Sleep 500ms
Type "2" Sleep 500ms
Type "4" Sleep 900ms
Enter
Wait+Screen@5s /No open questions/
Sleep 1.2s
Tab 2
Wait+Screen@5s /Plain Markdown files \(why/
Sleep 3s
Hide
Type "q"
Sleep 300ms
