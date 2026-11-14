# Architecture Decision Records

主要な技術判断を1件1ファイルで記録する。形式は簡略版 MADR。

- 状態: `Proposed`（暫定・検証待ち） / `Accepted` / `Superseded by NNNN`
- 判断を変えるときは既存 ADR を書き換えず、新しい ADR を追加して旧 ADR を `Superseded` にする。

| #                                    | タイトル                                            | 状態     |
| ------------------------------------ | --------------------------------------------------- | -------- |
| [0001](0001-language-and-runtime.md) | 言語・ランタイム・モノレポ構成                      | Accepted |
| [0002](0002-tui-framework.md)        | TUI フレームワーク                                  | Accepted |
| [0003](0003-storage.md)              | 永続化                                              | Accepted |
| [0004](0004-daemon-and-ipc.md)       | Daemon 構成と IPC                                   | Accepted |
| [0005](0005-vcs-jujutsu.md)          | バージョン管理に Jujutsu を使う                     | Accepted |
| [0006](0006-popup-window.md)         | Popup のネイティブウィンドウは Tauri 2 で作る       | Accepted |
| 0007                                 | UI の振り分けモード（T-602 で作成）                 | 予定     |
| [0008](0008-agent-execution.md)      | サブエージェントは `claude -p` を子プロセスで動かす | Accepted |
| [0009](0009-distribution.md)         | 単一バイナリを Homebrew で配布する                  | Accepted |
