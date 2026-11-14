# S-06: Tauri 2 の1問 Popup（macOS）

> S-06 の検証コードは、本実装の `apps/popup`（T-603）ができたので削除した（2026-11-14）。コードは commit `4d231047` の `spikes/s06-popup/` にある。

[tasks.md](../../tasks.md) の S-06 と S-07。設計案は [design/ui-modes.md](../../design/ui-modes.md)。stdin で質問の JSON を受け取り、ウィンドウに出して、回答を stdout に1行の JSON で返す。**捨てるコード**。本実装（T-603）では画面を React と `packages/core` の reducer で作り直す。

```sh
spikes/s06-popup/try.sh          # 3秒後に1問の Popup。そのあいだターミナルで打ち続けて、フォーカスを見る
spikes/s06-popup/try.sh 3 two    # 2問
```

| ファイル                    | 内容                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src-tauri/src/main.rs`     | stdin → 画面（イベント `message`）、画面 → stdout（コマンド `show` / `reply`）。Dock に出ない（Accessory） |
| `src-tauri/tauri.conf.json` | `focus: false`、`visible: false`（描画してから表示）、`alwaysOnTop`                                        |
| `ui/index.html`             | 画面（素の HTML / JS）。数字・`Enter`・`j` / `k`・`o`（自由入力）・`s`・`Esc`                              |

## 結果（2026-11-14、Apple Silicon）

| 項目                     | 結果                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| 表示までの時間           | 起動から表示まで **380〜500ms**（4回）。目標の 500ms にぎりぎり収まる                                |
| バイナリのサイズ         | **4.3MB**（release、strip・LTO・`opt-level = "s"`）                                                  |
| ビルド                   | 初回 1分22秒、2回目以降 約50秒。Rust 1.97 は導入済みだったので準備の手間なし                         |
| stdin / stdout の橋渡し  | Rust は約80行。画面の準備ができるまで stdin のメッセージをためておく必要がある（`ready` コマンド）   |
| フォーカス（§4.3 案 A）  | `focus: false` と Accessory で、表示してもターミナルのキー入力を奪わない。表示は目に入るので気づける |
| 隠れたウィンドウでの描画 | 非表示の間は `requestAnimationFrame` が動かない。表示の合図は `setTimeout` で送る                    |

## 決めたこと

- **ADR-0006**: Popup は Tauri 2 で作る。SwiftUI の予備案は使わない。
- **S-07（誤入力の防止）**: 案 A（フォーカスを奪わない）に決定。ユーザーが Popup をクリックしてから答える。案 B（入力を遅らせる）・案 C（2段階の確定）は採らない。

## 本実装で確かめること（T-603）

- 日本語 IME での自由入力（変換確定の `Enter` で送信しない。`isComposing` で判定している）
- クリック後のキー操作、`Esc` でのフォールバック
- 見た目（大きさ・位置・ダークモード）
