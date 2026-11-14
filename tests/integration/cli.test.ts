import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@dw/cli";
import { type Daemon, startDaemon } from "@dw/daemon";
import { DwClient } from "@dw/ipc-client";

let dir: string;
let socket: string;
let project: string;
let daemon: Daemon | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dw-cli-"));
  socket = join(dir, "d.sock");
  project = join(dir, "project");
  daemon = await startDaemon({ socketPath: socket });
});

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** Run `dw` in-process; returns exit code and captured output. */
async function dw(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(
    [...argv, "--socket", socket, "--project", project],
    {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    },
    { autoStart: () => {} },
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("dw (T-106)", () => {
  test("add → list → answer → show, using only the CLI", async () => {
    expect(
      (await dw("add", "どの DB を使う？", "-o", "SQLite", "-o", "Postgres", "--title", "DB")).out,
    ).toBe("added D-1");
    expect((await dw("add", "補足は？")).out).toBe("added D-2");

    const list = await dw("list");
    expect(list.out).toContain("D-1   ready     [DB] どの DB を使う？");
    expect(list.out).toContain("D-2   ready     補足は？");

    expect((await dw("answer", "D-1", "sqlite", "-w", "オフラインで使う")).out).toBe(
      "D-1 decided: SQLite",
    );
    expect((await dw("answer", "D-2", "特になし")).out).toBe("D-2 decided: 特になし");

    const show = await dw("show", "D-1");
    expect(show.out).toContain("● 1. SQLite");
    expect(show.out).toContain("why: オフラインで使う");
    expect((await dw("list")).out).toBe("no open decisions");
  });

  test("revisit and re-answer keeps the history (DQ-05)", async () => {
    await dw("add", "DB?", "-o", "SQLite", "-o", "Postgres");
    await dw("answer", "D-1", "1");
    expect((await dw("revisit", "D-1")).out).toBe("D-1 → revisit");
    await dw("answer", "D-1", "Postgres", "-t", "マネージドで", "-w", "要件変更");
    const show = (await dw("show", "D-1")).out;
    expect(show).toContain("answer: Postgres (マネージドで)");
    expect(show).toMatch(/#1 .* SQLite/);
    expect(show).toMatch(/#2 .* Postgres \/ マネージドで {2}\(要件変更\)/);
  });

  test("multi-select, hold ordering, skip, --json", async () => {
    await dw("add", "A?", "-o", "x", "-o", "y", "--multi");
    await dw("add", "B?", "-o", "x");
    await dw("add", "C?", "-o", "x");
    await dw("hold", "D-1");
    await dw("skip", "D-3", "-w", "不要");
    expect((await dw("list")).out.split("\n").map((l) => l.slice(0, 4))).toEqual(["D-2 ", "D-1 "]);
    expect((await dw("answer", "D-1", "1", "2")).out).toBe("D-1 decided: x, y");
    const all = JSON.parse((await dw("list", "--all", "--json")).out);
    expect(all.map((d: { status: string }) => d.status)).toEqual(["decided", "ready", "skipped"]);
  });

  test("errors: bad option → 2, unknown id → 1, invalid answer → 1", async () => {
    await dw("add", "DB?", "-o", "SQLite", "--no-other");
    expect((await dw("answer", "D-1", "Oracle")).code).toBe(2);
    expect((await dw("show", "D-9")).code).toBe(1);
    const invalid = await dw("answer", "D-1", "1", "-t", "note");
    expect(invalid.code).toBe(1);
    expect(invalid.err).toContain("free text is not allowed");
    expect((await dw("frobnicate")).code).toBe(2);
  });
});

describe("dependencies from the CLI (T-304)", () => {
  test("--after with a condition, show, diff after changing the answer", async () => {
    await dw("add", "保存先は？", "-o", "ローカル", "-o", "クラウド");
    expect((await dw("add", "同期方式は？", "--after", "D-1=クラウド")).out).toBe(
      "added D-2 (waiting)",
    );
    await dw("add", "DB は？", "--after", "D-1");
    expect((await dw("list")).out).toContain("D-2   pending   (waiting: D-1) 同期方式は？");

    const show = (await dw("show", "D-2")).out;
    expect(show).toContain("after: D-1 = クラウド (ready)");
    expect((await dw("show", "D-1")).out).toContain("needed by: D-2 (pending), D-3 (pending)");

    await dw("answer", "D-1", "クラウド");
    await dw("answer", "D-2", "CRDT");
    await dw("revisit", "D-1");
    await dw("answer", "D-1", "ローカル", "-w", "オフライン優先");
    const diff = (await dw("diff", "D-1")).out;
    expect(diff).toContain("#1 → #2: クラウド → ローカル");
    expect(diff).toContain("why: オフライン優先");
    expect(diff).toContain("D-2   skipped   同期方式は？ (condition-unmet)");
    expect(diff).toContain("D-3   ready     DB は？");
  });

  test("bad --after specs are usage errors", async () => {
    await dw("add", "A?", "-o", "x");
    expect((await dw("add", "B?", "--after", "nope")).code).toBe(2);
    expect((await dw("add", "B?", "--after", "D-1=zzz")).code).toBe(2);
    expect((await dw("add", "B?", "--after", "D-9")).code).toBe(1); // unknown id: daemon rejects
  });
});

describe("resume after restart (T-110, NFR-01)", () => {
  test("answer 5 of 10, restart the daemon, the remaining 5 are still open", async () => {
    for (let i = 1; i <= 10; i++) await dw("add", `Q${i}?`, "-o", "yes", "-o", "no");
    for (let i = 1; i <= 5; i++) await dw("answer", `D-${i}`, "yes");

    await daemon?.close();
    daemon = await startDaemon({ socketPath: socket });

    const open = JSON.parse((await dw("list", "--json")).out) as { id: string }[];
    expect(open.map((d) => d.id)).toEqual(["D-6", "D-7", "D-8", "D-9", "D-10"]);
    expect((await dw("show", "D-3")).out).toContain("answer: yes");
  });
});

describe("real process", () => {
  test("`dw list` starts the daemon when it is not running", async () => {
    await daemon?.close();
    daemon = undefined;
    const sock = join(dir, "auto.sock");
    const proc = Bun.spawnSync(
      [
        "bun",
        join(import.meta.dir, "../../apps/cli/src/main.ts"),
        "list",
        "--socket",
        sock,
        "-p",
        project,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(proc.stderr.toString()).toBe("");
    expect(proc.stdout.toString().trim()).toBe("no open decisions");
    expect(proc.exitCode).toBe(0);

    const client = await DwClient.connect({ socketPath: sock });
    const { pid } = await client.call("daemon.ping", {});
    client.close();
    expect(pid).not.toBe(process.pid); // a separate, detached daemon
    process.kill(pid, "SIGTERM");
  });
});

describe("dw graph (T-315)", () => {
  test("text and mermaid over a real daemon, filtered by plan", async () => {
    await dw("add", "保存先は？", "-o", "ローカル", "-o", "クラウド", "--title", "保存先");
    await dw("add", "同期方式は？", "--after", "D-1=クラウド", "--title", "同期");
    await dw("answer", "D-1", "ローカル");
    const text = (await dw("graph")).out;
    expect(text).toBe(
      [
        "(no plan)",
        "└─ D-1 [decided] 保存先 → ローカル",
        "   └─ D-2 [skipped: condition-unmet] 同期  (when D-1 = クラウド)",
      ].join("\n"),
    );
    const mermaid = (await dw("graph", "--format", "mermaid")).out;
    expect(mermaid).toContain('D1 -- "クラウド" --> D2');
    expect((await dw("graph", "--plan", "P-1")).out).toBe("no decisions in P-1");
    expect((await dw("graph", "--format", "svg")).code).toBe(2);
    expect((await dw("graph", "--plan", "1")).code).toBe(2);
  });
});
