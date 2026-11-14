# ADR-0006: Popup のネイティブウィンドウは Tauri 2 で作る

- 状態: Accepted
- 日付: 2026-11-14

## 決定

- Popup（質問が来たら開く簡易回答画面）は **Tauri 2** で作る。
  - 画面は TypeScript / React で書き、`packages/core` の UI reducer を Workspace（TUI）と共有する。
  - Rust 側は stdin / stdout と画面の橋渡しだけにする。Daemon とのやり取りは stdin / stdout の JSON Lines で行う（[ui-modes.md](../design/ui-modes.md) §4.5）。
- 誤入力は「フォーカスを奪わない」ことで防ぐ（§4.3 の案 A。S-07 の結論）。
  - `focus: false` でウィンドウを作り、アプリは Accessory にする（Dock に出さず、アプリとしてもアクティブにしない）。
  - ユーザーはウィンドウをクリックしてから答える。
- 対象はまず macOS（Apple Silicon）。

## 理由

[S-06 の記録](../../spikes/s06-popup/README.md)より。

- 表示までの時間は 380〜500ms で、目標（500ms 以内）を満たした。
- バイナリは 4.3MB で、配布の負担が小さい。
- `focus: false` と Accessory で、表示してもターミナルのキー入力を奪わないことを実機で確認した。予備案の SwiftUI に切り替える理由はなかった。
- stdin / stdout の橋渡しは Rust で約80行に収まった。

## 影響

- Popup のビルドに Rust のツールチェーンが要る。リリースのワークフローに Rust を足す。
- Popup は `dw` とは別のバイナリになる。Homebrew では同じ formula に同梱し、`dw` から見つけられる場所に置く（T-603 で決める）。
- 表示までの時間は、目標ぎりぎりで余裕がない。遅いと感じたら、常駐させる案（[ui-modes.md](../design/ui-modes.md) の U6）を検討する。
