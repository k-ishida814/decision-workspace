# S-03: `claude -p` でエージェントを動かすスパイク

> S-03 の検証コードは役目を終えたため削除した（2026-11-14）。コードは commit `54a4ecb9` の `spikes/s03-agents/` にある（`jj file show -r 54a4ecb9 spikes/s03-agents/<file>`）。

[tasks.md](../../tasks.md) の S-03。`claude -p --json-schema` で Planner / Explorer の形の出力が安定して取れるか、時間と費用はどれくらいかを確かめた（2026-11-14）。

```sh
bun spikes/s03-agents/run.ts [runs=3] [model=sonnet] [task]   # モデルを呼ぶ
```

## 起動オプション（確定）

```text
claude -p <prompt> --model sonnet --output-format json
  --json-schema <Zod → JSON Schema（target: draft-7）>
  --append-system-prompt <役割と注意>
  --tools "Read,Grep,Glob,WebSearch,WebFetch" --allowedTools "Read,Grep,Glob,WebSearch,WebFetch"
  --max-turns <n> --max-budget-usd <n> --no-session-persistence
  --strict-mcp-config --settings '{"disableAllHooks":true}'
```

## 結果（sonnet）

| タスク                                     | 回数 | 成功 | 所要時間  | 費用        | ターン             |
| ------------------------------------------ | ---- | ---- | --------- | ----------- | ------------------ |
| Planner                                    | 3    | 3    | 13〜17 秒 | $0.05〜0.11 | 3〜4               |
| Explorer（指示なし）                       | 3    | 3    | 10〜11 秒 | $0.08〜0.09 | 4                  |
| Explorer（Web で確認する指示あり）         | 2    | 2    | 19〜20 秒 | $0.10       | 4                  |
| Explorer（Web 確認、ツール呼び出しを記録） | 1    | 1    | —         | $0.16       | 4（WebSearch 3回） |

構造化出力は **9 回中 9 回** スキーマどおりに返った。

## 分かったこと

1. **Zod v4 の JSON Schema はそのままでは通らない。** 既定の `$schema`（draft 2020-12）を CLI の検証器が知らず、`--json-schema is not a valid JSON Schema` で即終了する（モデルは呼ばれない）。`z.toJSONSchema(schema, { target: "draft-7" })` で解決。
2. **`--bare` は使えない。** Hook や MCP を読み込まない点は都合がよいが、OAuth（プランのログイン）を使わず API キーが必須になる。代わりに `--settings '{"disableAllHooks":true}'` と `--strict-mcp-config` で、本ツール自身の Hook や MCP が再帰的に動くのを防ぐ。CLAUDE.md は読み込まれる（プロジェクトの文脈になるので問題ない）。
3. **Explorer は指示しないと Web を調べない。** プロジェクトの設計書を読んで言い直すだけになる。「プロジェクトのファイルは前提であって根拠ではない。推薦の前に Web で現状を確認する」と指示すると検索するようになる（費用は約 1.2〜2 倍）。
4. **`usage.server_tool_use` は Claude Code の WebSearch を数えない**（実際は3回呼んでいても 0）。ツール利用の記録が要るなら `--output-format stream-json --verbose` の transcript から数える。transcript はどのみち保存する（AG-04）ので、T-307 では stream-json で受ける。
5. 読み取り専用ツールだけでも、`permission_denials` は発生しなかった。

## 既定値（設計書 D7 の見直し）

| 項目               | 既定値   | 根拠                                                         |
| ------------------ | -------- | ------------------------------------------------------------ |
| モデル             | `sonnet` | 品質・速度とも十分                                           |
| `--max-budget-usd` | 0.5      | 観測した最大は $0.16。3倍の余裕                              |
| `--max-turns`      | 12       | 観測は 3〜4 ターン。暴走だけ止める（設計時の 20 から下げる） |
| 同時実行数         | 2        | 変更なし                                                     |
