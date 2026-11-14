# Deep Dive: an agent researches the options of one decision (calls the model; haiku).
# Run from the repository root: vhs docs/media/tapes/deepdive.tape
Output docs/media/deepdive.gif
Source docs/media/tapes/_settings.tape
Set Height 900

Hide
Type "source docs/media/demo/env.sh" Enter
Sleep 1s
Type "bun $REPO/docs/media/demo/seed.ts explore </dev/null >/dev/null 2>&1; dw tui" Enter
Wait+Screen@15s /How should full-text search work/
Sleep 500ms
Show
Sleep 2s
Type "d"
Wait+Screen@20s /Deep Dive running/
Sleep 1s
Wait+Screen@180s /Recommended:/
Sleep 6s
Hide
Type "q"
