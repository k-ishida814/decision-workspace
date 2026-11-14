# ADR-0004: Daemon 構成と IPC

- 状態: Accepted（S-01 の実機検証を経て 2026-11-13 に確定）
- 日付: 2026-11-13

## 背景

Hook・MCP サーバー・TUI・VS Code 拡張が同じ状態を共有する必要がある。Hook は Claude Code から短命プロセスとして起動され、ユーザーの回答を待つ。

## 決定

- **ユーザー単位で Daemon を1プロセス**だけ動かし、プロジェクトごとに DB を開く。
- IPC は **JSON-RPC 2.0 over Unix Domain Socket**（改行区切り JSON）。Windows は Named Pipe（後回し）。
- ソケットは `$XDG_RUNTIME_DIR/decision-workspace/daemon.sock`（ない場合は `~/.decision-workspace/`）。パーミッションは 0600 にする。
- Daemon は**オンデマンドで起動**する: クライアントが接続に失敗したら Daemon をデタッチ起動し、短時間リトライする。多重起動はロックファイルで防ぐ。
- サーバーからの通知（Decision 追加・更新）は JSON-RPC notification で送る。

## Hook の待機方式

1. Hook が `AskUserQuestion` の入力を受け取り、`decision.askBatch` を呼ぶ。
2. Daemon は各質問を Decision として登録し、すべて回答されたらレスポンスを返す（ロングポーリング）。
3. Hook は `updatedInput.answers` を組み立てて返す。
4. 接続失敗・タイムアウト・ユーザーの「ターミナルで答える」操作の場合は、何も出力せず終了する（フェイルオープン、CC-03）。
5. **Hook が終了させられたら、Daemon は接続の切断を検知して、そのバッチの Decision を取り下げる**（状態を `cancelled` にし、理由を記録）。TUI / VS Code にはイベントで通知し、回答中の画面から外す。
6. Hook の設定には `statusMessage` を入れて、待機中であることと回答場所を Claude Code のスピナーに表示する。あわせて OS 通知を出す（CC-08）。
7. 待機の上限は Claude Code 側の Hook `timeout` に任せる（既定 600 秒、`dw install` で設定可能にする）。Hook 自身は上限を持たず、終了シグナルを受けたら上の 5 で片付ける。

## S-01 での実機検証結果（根拠）

[S-01 の記録](../research/spikes/S-01-hook.md) の結果より。

| 観察                                                                                                        | 設計への反映                                |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `allow` + `updatedInput.answers` で、単一選択・複数選択（`"A, B"`）・複数問・自由入力の回答が Claude に届く | 方式として採用                              |
| 何も出力せずに終了すると、Claude Code の通常の質問 UI が出る                                                | フェイルオープンの受け皿にする              |
| `Esc` で Claude Code は Hook に SIGTERM を送る                                                              | 切断検知による取り下げ（上の 5）            |
| Claude Code 側の `timeout` に達すると SIGTERM → 通常の質問 UI が出る                                        | 待機上限は Claude Code 側に任せる（上の 7） |
| 待機中も Claude Code で文字入力はできる（ブロックされない）                                                 | 特別な対応は不要                            |
| 待機中の表示はスピナーだけで、Claude が考え中なのと区別できない。`statusMessage` で文言を変えられる         | `statusMessage` と OS 通知（上の 6）        |

## 検討した代替案

- **プロジェクト単位 Daemon**: 分離は単純だが、複数プロジェクトを横断する TUI / VS Code の実装が複雑になる。
- **HTTP（localhost）**: デバッグしやすいが、ポート衝突と他ユーザーからのアクセス制御が必要になる。
- **Daemon なし（各プロセスが SQLite を直接開く）**: 実装は最小だが、リアルタイム通知とロングポーリングのために結局ポーリングが必要になる。
