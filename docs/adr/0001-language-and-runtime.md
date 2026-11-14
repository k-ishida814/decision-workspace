# ADR-0001: 言語・ランタイム・モノレポ構成

- 状態: Accepted
- 日付: 2026-11-13

## 背景

Daemon、TUI、Claude Code Hook、MCP サーバー、Agent SDK 呼び出し、VS Code 拡張を作る。これらでスキーマとドメインロジックを共有したい。

## 選択肢

1. TypeScript + Node.js（構想資料の初期案）
2. TypeScript + Bun（VS Code 拡張のみ Node）
3. Go / Rust の Daemon + TypeScript のクライアント群

## 決定

**2. TypeScript + Bun。** モノレポは Bun workspaces で管理する。

## 理由

- TUI に選んだ OpenTUI が Bun 前提であり、Node で統一する案 1 はそもそも成立しにくい。
- `bun:sqlite` が組み込みで、ネイティブアドオンのビルドが不要。
- `bun build --compile` で Hook を単一バイナリにでき、起動時間を抑えられる。
- 案 3 は MCP / Agent SDK / Zod スキーマの共有ができず、二言語の保守負担に見合わない。

## 結果・制約

- VS Code 拡張は Node 上で動くため、`packages/protocol` と `packages/core` は `bun:*` / `node:*` を import しない。CI で Node 上の型検査・テストを通して担保する。
- Bun と Node の挙動差（ソケット、子プロセス）は `ipc-client` に閉じ込める。
