# README hero: the logo. Run from the repository root: vhs docs/media/tapes/hero.tape
Output docs/media/.out/hero.gif
Set Shell "bash"
Set FontFamily "Menlo"
Set FontSize 18
Set Width 1000
Set Height 500
Set Padding 24
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful
Set WindowBarSize 36

Hide
Type "clear; tput civis; bun docs/media/demo/logo.ts; sleep 30" Enter
Sleep 1.5s
Show
Sleep 0.5s
Screenshot docs/media/hero.png
