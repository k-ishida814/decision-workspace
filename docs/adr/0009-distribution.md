# ADR-0009: 単一バイナリを Homebrew で配布する

- 状態: Accepted
- 日付: 2026-11-14

## 決定

- `bun build --compile` で、CLI・TUI・Daemon・Hook・MCP サーバーをすべて含む `dw` を1つのバイナリにする（`bun run build` → `dist/dw`）。
- Hook と MCP サーバーは、そのバイナリのサブコマンド（`dw hook` / `dw mcp`）として動かす。
  - `dw install` は自分自身のパスを書き込む。
  - パスは PATH 上の安定したもの（Homebrew なら `/opt/homebrew/bin/dw`）を優先する。バージョンごとに変わる Cellar のパスを書くと、`brew upgrade` のたびに設定が壊れるため。
- 配布は GitHub Releases と Homebrew tap（`<owner>/homebrew-tap`）で行う。
  - タグ `v*` を push すると、`.github/workflows/release.yml` がビルドする。
  - できた tar.gz と、値を埋めた formula をリリースに添付する。formula の tap への反映は、当面は手作業で行う。
- 当面は macOS / Apple Silicon（`bun-darwin-arm64`）だけを配布する。
- ライセンスは MIT。

## 理由

- 利用者に Bun を入れてもらう必要がない。npm 配布だと、Bun が前提になる。
- 計測した起動時間（2026-11-14、M シリーズ Mac）:

  | 方式                              | 時間     |
  | --------------------------------- | -------- |
  | `dw` バイナリ（99MB）、ウォーム時 | 約 50ms  |
  | `dw` バイナリ、初回               | 約 170ms |
  | `bun` でソースを実行              | 約 30ms  |

  ウォーム時は NFR-05 の目標（100ms）に収まる。
- OpenTUI のネイティブライブラリ、`bun:sqlite`、テキストとして import しているファイル（SQL マイグレーション、エージェントのプロンプト）も、バイナリに収まることを確認した。
- Hook と MCP を別のバイナリに分けないのは、`dw install` が書き込むパスを1つにするため。TUI は遅延 import なので、Hook の起動時には読み込まれない。

## 影響

- OpenTUI のネイティブ部分は CPU ごとに別のものが入る。そのため、各プラットフォームのビルドはそのプラットフォームのランナーで行う。Intel Mac と Linux は、必要になったら release の matrix に足す。
- 開発時（ソースから実行）は、`bun <repo>/apps/cli/src/main.ts hook` を書き込む。以前の形式（`apps/hook/src/main.ts` を直接書いたもの）も、uninstall で取り除けるよう引き続き認識する。
- バージョンは、ビルド時に `DW_VERSION` として埋め込む。ソースから実行したときは `dev` になる。
