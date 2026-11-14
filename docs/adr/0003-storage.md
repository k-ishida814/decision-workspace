# ADR-0003: 永続化

- 状態: Accepted
- 日付: 2026-11-13

## 決定

- **SQLite**（`bun:sqlite`）を使い、WAL モードで運用する。
- ORM は使わない。`packages/storage` にリポジトリ層を置き、SQL を直接書く。
- マイグレーションは連番 SQL ファイル + `PRAGMA user_version` で管理する。
  - 0.1.0 の公開前に、開発中に積み重ねた 001〜005 を `001_init.sql` の1本にまとめた（2026-11-14）。公開後は、リリース済みのファイルを書き換えず、新しい番号のファイルを足す。
- 書き込みは Daemon だけが行う（単一ライター）。他プロセスは IPC 経由で操作する。
- 同時確定は `decisions.revision` の楽観ロックで検出する（DQ-07）。

## 理由

- ローカル完結・トランザクション・単一ファイルで、プロジェクト単位の分離（DQ-08）と相性が良い。
- テーブル数が少なく（Decision, Option, Dependency, Revision, Session, AgentRun, Event）、ORM の利点が小さい。
- 単一ライターにすると、ロック競合と二重確定（NFR-02）の問題を Daemon 内で解決できる。

## 保存場所（暫定）

- プロジェクトの DB: `<project>/.decision-workspace/decisions.db`（`.gitignore` 対象）
- 確定事項を Git 管理したい場合は Decision Export（Markdown / ADR 出力）で対応する。
