# 開発ガイド

## 前提ツール

| ツール         | バージョン | 用途                               |
| -------------- | ---------- | ---------------------------------- |
| Bun            | 1.4 系     | ランタイム・パッケージ管理・テスト |
| Jujutsu (`jj`) | 0.47 系    | バージョン管理（Git colocated）    |
| Claude Code    | 最新       | 連携対象・動作確認                 |

```sh
brew install jj   # 未導入の場合
```

## Jujutsu の使い方

このリポジトリは `jj git init --colocate` で初期化している。`.jj/` と `.git/` が共存し、Git のツールからも同じ履歴が見える。

### Git との考え方の違い

- **ワーキングコピー自体がコミット（`@`）。** `git add` もステージングもない。ファイルを変更すると、`@` に自動で記録される。
- **ブランチの代わりにブックマーク。** 名前は必要なとき（push するとき）だけ付ける。
- **何をしても `jj undo` で戻せる。** 操作履歴は `jj op log` で確認できる。

### 日常の流れ

```sh
jj st                          # 状態確認（git status 相当）
jj diff                        # 変更差分
jj describe -m "feat: ..."     # 今の変更（@）に説明を付ける
jj new                         # 新しい空の変更を作って次の作業へ（= コミット確定）
# または
jj commit -m "feat: ..."       # describe + new を1回で行う

jj log                         # 履歴
jj undo                        # 直前の操作を取り消す
```

### よく使う操作

| やりたいこと                       | コマンド                                               |
| ---------------------------------- | ------------------------------------------------------ |
| 1つ前の変更を修正したい            | `jj edit <change-id>` で移動して編集 → `jj new` で戻る |
| 今の変更の一部を前の変更へ移したい | `jj squash -i`                                         |
| 今の変更を2つに分けたい            | `jj split`                                             |
| 作業を並行して進めたい             | `jj new <base>` で分岐（ブランチ名は不要）             |
| リモートへ push                    | `jj bookmark set main -r @-` → `jj git push`           |
| リモートを取り込む                 | `jj git fetch` → `jj rebase -d main`                   |

### ルール

- 履歴を書き換える Git コマンド（`git commit`, `git checkout`, `git rebase`, `git reset`）は使わない。読み取り系（`git log`, `git blame`）は使ってよい。
- コミットメッセージは Conventional Commits（`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`）に従う。
- 1つの変更（change）は1つの目的にする。混ざったら `jj split` で分ける。

## コマンド

```sh
bun install
bun run check      # lint + 型検査 + テスト
bun test           # テストのみ
bun run dw -- list # dw CLI（Daemon は必要なとき自動で起動する）
bun run e2e        # 本物の Claude Code での E2E（モデルを呼ぶので bun test には含めない）
```

`bun run e2e` は `tests/e2e/` のすべてを実行する。Hook（`claude -p` 2回）、Deep Dive（Explorer 1回）、MCP での登録（1回）、登録→回答→次のプロンプトで受け取る往復（2回）、Planner（1回）、Reviewer（1回）。どれも `haiku` で、合計 $0.05 程度。モデルは `DW_E2E_MODEL` で変更可。`-p` では permission host がないと `AskUserQuestion` が使えないため、何でも拒否するだけのスタブ MCP（`tests/e2e/permission-stub.ts`）を `--permission-prompt-tool` に渡している。Hook が先に回答するので、スタブに `AskUserQuestion` の問い合わせが来ないこともテストで確認している。

開発中に本物の `~/.decision-workspace/` を汚したくないときは、`DW_SOCKET=/tmp/dw-dev.sock` のようにソケットを分ける。DB は各プロジェクトの `.decision-workspace/` にできる。
