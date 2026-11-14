# ADR-0007: 質問の表示先は Daemon が mode で振り分ける

- 状態: Accepted
- 日付: 2026-11-14

## 決定

- Claude Code からの質問をどこに出すかは、**mode** で決める（UM-01）。
  - mode は `auto` / `workspace` / `popup` / `off` の4つ。
  - ユーザー設定（`~/.decision-workspace/config.json`）で決め、プロジェクトごとに上書きできる（`<project>/.decision-workspace/config.json`、`dw config set mode … --local`）。
  - 既定は、Popup の配布が始まるまで `workspace`（従来の動作）。始まったら `auto` にする。
- 振り分けは **Daemon** が決める。
  - Hook は `decision.askBatch` に `route: true` を付けるだけ。これで、以前の `requireViewer` は不要になった。
  - 判断は `routeFor(mode, Workspace が見ているか)` という純粋関数で行う（`packages/core`）。
  - 落ちる順は Workspace → Popup → Claude Code の通常 UI。
- Hook は mode を読んで、Daemon に接続する前に2つだけ判断する。
  - `off` なら、何もせずに終了する。
  - `auto` / `popup` なら、Daemon がいなければ起動する。Popup があれば、起動したばかりの Daemon でも質問を出せるため。`workspace` では従来どおり起動しない。
- **Popup は Daemon の子プロセス**にする（ADR-0006、[ui-modes.md](../design/ui-modes.md) §4.5）。
  - **同時に1つ**: 次の Popup は、前の Popup が閉じてから開く。`show` に「あと N 件」を載せる。
  - **起動の失敗は通常 UI に戻す**: 次の場合はすべてフォールバックとする。
    - Popup が見つからない
    - 起動できない
    - 5秒以内に `shown` が来ない
    - 最後のメッセージを書かずに終了した
    - 返した回答を適用できない
  - **ほかで決着したら閉じる**: Workspace で回答されたとき、Claude Code が質問を取り下げたとき（Hook の切断）は、Daemon が Popup に SIGTERM を送る。
  - **「Workspace で検討」**: Workspace が見ていれば、Hook は待ち続ける。それ以降は、Workspace の質問と同じ扱いになる（最後の Workspace が閉じたら通常 UI に戻す）。見ていなければ、通常 UI に戻す。
- Popup の場所: `$DW_POPUP`、なければ `dw` と同じディレクトリの `dw-popup`。

## 理由

- **判断を1か所にまとめる**: 振り分けには「どの UI が今つながっているか」が要る。それを知っているのは Daemon だけなので、Hook には判断を持たせない。
- **フェイルオープンを保つ**: Popup で何が起きても、Claude Code の通常 UI に戻るだけで済む（CC-03）。
- **Rust 側を薄く保つ**: Popup を状態を持たない子プロセスにすれば、Daemon への接続を Rust で書かずに済む。

## 影響

- テストは、偽の Popup（`tests/fixtures/fake-popup.ts`）で振り分けの全経路を確かめる（`tests/integration/popup.test.ts`）。
- テストがユーザーの実際の設定を読まないよう、`tests/setup.ts`（bunfig の preload）で `DW_CONFIG` を一時ファイルに向ける。
