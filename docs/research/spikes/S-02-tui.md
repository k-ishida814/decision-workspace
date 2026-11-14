# S-02: OpenTUI（React）スパイク

> S-02 の検証コードは役目を終えたため削除した（2026-11-14）。コードは commit `54a4ecb9` の `spikes/s02-tui/` にある（`jj file show -r 54a4ecb9 spikes/s02-tui/<file>`）。

[tasks.md](../../tasks.md) の S-02。OpenTUI + `@opentui/react` で Current / Queue / Help 画面を試作し、ADR-0002 を確定する材料を集める。**捨てるコード**だが、`state.ts`（UI 状態の reducer）は本実装の `packages/core` へ移す前提で書いている。

S-01 の spool（`spikes/s01-hook/.spool`）を読み書きするので、**S-01 の `answer.ts` の代わりにそのまま使える**。

## 起動

```sh
bun install --cwd spikes/s02-tui   # 初回のみ
bun run spike:tui                  # ルートで実行
```

S-01 と組み合わせる場合は、`answer.ts` の代わりにこれを起動しておき、`spikes/s01-hook/playground` で `claude` を起動する。

## キー操作

| キー                 | 動作                                                            |
| -------------------- | --------------------------------------------------------------- |
| `j` / `k`、`↑` / `↓` | 移動                                                            |
| `1`〜`9`             | 選択肢を選ぶ（複数選択では切替）                                |
| `Space`              | 複数選択の切替                                                  |
| `Enter`              | 確定（複数問ある場合は次の問へ。最後の問で Claude Code に送信） |
| `o`                  | 自由入力（`Enter` で送信、`Esc` で戻る）                        |
| `t`                  | この質問を Claude Code の通常 UI で答える（フォールバック）     |
| `Tab`                | Current / Queue 切替                                            |
| `?`                  | ヘルプ                                                          |
| `q` / `Ctrl+C`       | 終了                                                            |

## 実機で見てほしいこと

| #   | 確認内容                                                                         |
| --- | -------------------------------------------------------------------------------- |
| 1   | キー操作の反応速度・ちらつき                                                     |
| 2   | ✅ `o` の自由入力で日本語（IME）が入力できた（2026-11-13 実機確認）              |
| 3   | 質問が届いたときに気づけるか（黄色の通知が3秒表示される）                        |
| 4   | ターミナルの幅を変えたときの表示                                                 |
| 5   | 使っているターミナル（iTerm2 / Ghostty / VS Code 統合ターミナル など）での見た目 |

## 自動テストで確認済みのこと

`bun test spikes/s02-tui` で10件。

- reducer: 単一選択・複数選択（`"VS Code, Zed"` 形式）・複数問・自由入力・フォールバック・処理中の質問の後ろに新着を並べる・Hook が諦めて消えた質問の破棄
- 描画: テスト用レンダラーでの待機画面 → 外部からの質問追加で再描画、`2` → `Enter` での回答、`o` → 入力 → `Enter`、`Tab` / `?`
- 日本語の全角文字が枠からずれずに描画される

## 分かったこと（ADR-0002 / ADR-0001 への入力）

- **テストのしやすさ**: `@opentui/react/test-utils` の `testRender` と、`@opentui/core/testing` の `captureCharFrame` / `mockInput` で、画面を文字列として取り出して検証できる。ただし `waitForFrame` は実時間を待たずに一定回数だけ描画して諦めるため、タイマーで更新する UI には自前の待機ヘルパーが必要だった（`app.test.tsx` の `frameUntil`）。
- **型定義の不具合**: `<input>` の `onSubmit` が `((e: SubmitEvent) => void) & ((value: string) => void)` になっており、`(value) => …` が型エラーになる。`onInput` で値を保持し、引数なしの `onSubmit` で回避した。また tsconfig の `lib` に `DOM` を入れると、同じ衝突が起きる。
- **Node 対応**: `@opentui/core` 0.8.4 の `engines` は `bun >=1.3.14`、`node >=26.4.0` で、Node 用のビルドも同梱されている。「OpenTUI は Bun 必須」という ADR-0001 の前提は、現行版では当てはまらない（Bun を選ぶ理由はほかにもあるので、結論は変わらない）。
- **Windows**: `@opentui/core-win32-x64` / `-arm64` のビルド済みバイナリが配布されている（動作は未確認）。
