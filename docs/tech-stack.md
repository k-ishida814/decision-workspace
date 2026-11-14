# 技術選定

> 作成日: 2026-11-13
> ステータス: Draft v0.1（Phase 0 のスパイク結果で確定する）

構想資料 §8 の「TypeScript で統一」を基本線とし、調査で判明した制約を反映した。個別の判断理由は [adr/](adr/) に記録する。

## 1. 結論

| レイヤー          | 採用                                                                              | 状態                | ADR                                      |
| ----------------- | --------------------------------------------------------------------------------- | ------------------- | ---------------------------------------- |
| 言語              | TypeScript（strict, ESM）                                                         | 確定                | [0001](adr/0001-language-and-runtime.md) |
| ランタイム        | **Bun 1.4 系**（Daemon / CLI / TUI / Hook / MCP）、Node（VS Code 拡張ホストのみ） | 確定                | [0001](adr/0001-language-and-runtime.md) |
| モノレポ          | Bun workspaces                                                                    | 確定                | [0001](adr/0001-language-and-runtime.md) |
| TUI               | OpenTUI（`@opentui/react`）                                                       | 確定                | [0002](adr/0002-tui-framework.md)        |
| 永続化            | SQLite（`bun:sqlite`、WAL）、ORM なし・自前マイグレーション                       | 確定                | [0003](adr/0003-storage.md)              |
| プロセス構成・IPC | ユーザー単位の Daemon ＋ JSON-RPC 2.0 over Unix Domain Socket                     | 暫定（S-01）        | [0004](adr/0004-daemon-and-ipc.md)       |
| スキーマ / 検証   | Zod v4（IPC・MCP・エージェント出力で共通）                                        | 確定                | —                                        |
| Claude 連携       | Hooks（command 型）＋ MCP（`@modelcontextprotocol/sdk`, stdio）                   | 確定                | —                                        |
| 深掘り実行        | `claude -p` を子プロセスで起動（`--json-schema`）                                 | 決定（S-03 で確認） | [0008](adr/0008-agent-execution.md)      |
| テスト            | `bun test`（unit / integration）、VS Code 拡張は `@vscode/test-cli`               | 確定                | —                                        |
| Lint / Format     | Biome                                                                             | 確定                | —                                        |
| 型検査            | `tsc --noEmit`（project references）                                              | 確定                | —                                        |
| VCS               | Jujutsu（Git colocated）                                                          | 確定                | [0005](adr/0005-vcs-jujutsu.md)          |

## 2. 主な判断の要約

### なぜ Bun か

- OpenTUI の開発・実績は Bun が中心（S-02 時点の 0.8.4 では Node >=26.4 にも対応しているため、必須ではなくなった。ADR-0002 参照）。
- `bun:sqlite` が組み込みで、ネイティブアドオン（better-sqlite3 等）のビルド問題を避けられる。
- `bun build --compile` で Hook 用の単一バイナリを作れ、起動レイテンシを抑えやすい（NFR-05、S-04 で計測）。
- テストランナー・バンドラ・ワークスペースが一体で、ツールチェーンが小さい。

### Node との境界

VS Code 拡張は拡張ホスト（Node / Electron）で動くため Bun API を使えない。そこで次のルールを置く。

- `packages/protocol`・`packages/core` は**ランタイム非依存**（`bun:*` / `node:*` を import しない）。
- Bun 固有の実装（SQLite、ソケットサーバー）は `packages/storage`・`apps/daemon` に閉じ込める。
- VS Code 拡張は Daemon に IPC で接続する薄いクライアントにとどめる（DB を直接開かない）。

### Go / Rust を採らない理由

Daemon 単体なら Go/Rust にも利点（単一バイナリ、常駐の安定性）がある。ただし MCP SDK・Agent SDK・VS Code 拡張・Zod スキーマを TypeScript で共有できる利点が大きい。Hook の起動速度が問題になった場合のみ、Hook クライアントだけを別言語化する余地を残す。

## 3. パッケージ構成

構想資料 §8 の案を、ランタイム境界に合わせて調整した。

```text
decision-workspace/
├── apps/
│   ├── daemon/         # Bun: IPC サーバー、Decision Store の唯一の書き手
│   ├── cli/            # Bun: `dw` コマンド（TUI 起動、非対話操作、install）
│   ├── tui/            # Bun: OpenTUI 画面（cli から起動）
│   ├── hook/           # Bun: Claude Code Hook 用エントリ（単一バイナリ化）
│   ├── mcp/            # Bun: MCP サーバー（stdio、Daemon のクライアント）
│   └── vscode/         # Node: VS Code 拡張（Phase 5）
├── packages/
│   ├── protocol/       # ランタイム非依存: Zod スキーマ、JSON-RPC メソッド定義
│   ├── core/           # ランタイム非依存: 状態遷移、Graph 演算、ドメインロジック
│   ├── storage/        # Bun: SQLite リポジトリ、マイグレーション
│   ├── ipc-client/     # ランタイム非依存寄り: Daemon 接続クライアント（Bun/Node 両対応）
│   ├── agent-runner/   # Bun: `claude -p` の起動と出力検証（Phase 3、ADR-0008）
│   └── detection/      # ランタイム非依存: 意思決定要求の検出ルール（Phase 4）
├── agents/             # Planner / Explorer / Reviewer のプロンプト定義
├── docs/
└── tests/
    ├── integration/
    └── e2e/
```

## 4. 主要な依存ライブラリ（予定）

| 用途         | パッケージ                                                   |
| ------------ | ------------------------------------------------------------ |
| TUI          | `@opentui/core`, `@opentui/react`（または `@opentui/solid`） |
| スキーマ     | `zod`                                                        |
| MCP          | `@modelcontextprotocol/sdk`                                  |
| エージェント | なし（ユーザーの `claude` CLI を起動。ADR-0008）             |
| Lint/Format  | `@biomejs/biome`                                             |
| 型           | `typescript`, `@types/bun`                                   |

バージョンは導入時点の最新安定版を固定し、`bun.lock` をコミットする。
