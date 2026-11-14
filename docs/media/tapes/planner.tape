# Planner: describe what to build; an agent lists the decisions with dependencies (haiku).
# Run from the repository root: vhs docs/media/tapes/planner.tape
Output docs/media/planner.gif
Source docs/media/tapes/_settings.tape
Set Height 440

Hide
Type "source docs/media/demo/env.sh" Enter
Sleep 1s
Type "dw tui" Enter
Wait+Screen@15s /Waiting for Claude Code/
Sleep 500ms
Show
Sleep 1.5s
Type "p"
Sleep 800ms
Type "Let users share a notebook with other people"
Sleep 800ms
Enter
Wait+Screen@240s /Planning P-1 finished/
Sleep 2.5s
Tab 3
Sleep 6s
Hide
Type "q"
