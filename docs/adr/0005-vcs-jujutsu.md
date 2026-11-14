# ADR-0005: バージョン管理に Jujutsu を使う

- 状態: Accepted
- 日付: 2026-11-13

## 決定

Jujutsu（`jj`）を **Git colocated モード**で使う（`.jj/` と `.git/` が共存）。

## 理由

- 試験導入が目的。colocated なら GitHub・既存の Git ツール・Claude Code の Git 連携もそのまま使えるため、いつでも Git のみの運用に戻せる。
- ワーキングコピー自体がコミットとして記録されるため、エージェントの作業を細かく取り消し・分割しやすい（`jj undo`, `jj split`, `jj op log`）。

## 運用ルール

- 日常操作は `jj` で行う。`git commit` / `git checkout` / `git rebase` など、履歴を書き換える Git コマンドは直接使わない。
- 詳細な手順は [development.md](../development.md) を参照。
