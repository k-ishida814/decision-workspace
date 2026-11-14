/** MCP tools against a real daemon, through an MCP client (T-311). */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Daemon, startDaemon } from "@dw/daemon";
import { DwClient } from "@dw/ipc-client";
import { createMcpServer, LIST_LIMIT } from "@dw/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let dir: string;
let project: string;
let daemon: Daemon;
let dw: DwClient;
let mcp: Client;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dw-mcp-"));
  project = join(dir, "p");
  const socketPath = join(dir, "d.sock");
  daemon = await startDaemon({ socketPath });
  dw = await DwClient.connect({ socketPath });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(dw, project).connect(serverSide);
  mcp = new Client({ name: "test", version: "0" });
  await mcp.connect(clientSide);
});

afterEach(async () => {
  await mcp.close();
  dw.close();
  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>) {
  const r = await mcp.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
  return { text, isError: r.isError === true };
}

test("the three tools are offered, and decision_ask explains when to use it", async () => {
  const { tools } = await mcp.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual([
    "decision_ask",
    "decision_get",
    "decision_list",
  ]);
  expect(tools.find((t) => t.name === "decision_ask")?.description).toContain(
    "instead of AskUserQuestion",
  );
});

test("decision_ask queues a plan with dependencies and conditions by label, without waiting", async () => {
  const r = await call("decision_ask", {
    title: "同期機能の設計",
    decisions: [
      {
        key: "where",
        title: "保存先",
        question: "保存先は？",
        options: [{ label: "ローカル" }, { label: "クラウド", description: "複数端末" }],
        recommended: "クラウド",
      },
      {
        key: "sync",
        question: "同期方式は？",
        dependsOn: [{ ref: "where", whenOptions: ["クラウド"] }],
      },
      { key: "db", question: "DB は？", dependsOn: [{ ref: "where" }] },
    ],
  });
  expect(r.isError).toBe(false);
  expect(r.text).toContain('Queued 3 decision(s) as P-1 "同期機能の設計"');
  expect(r.text).toContain("where = D-1 [ready]");
  expect(r.text).toContain("sync = D-2 [pending]");

  const all = await dw.call("decision.list", { project });
  expect(all.map((d) => [d.id, d.origin, d.planId])).toEqual([
    ["D-1", "plan", "P-1"],
    ["D-2", "plan", "P-1"],
    ["D-3", "plan", "P-1"],
  ]);
  expect(all[0]?.options[1]).toMatchObject({
    id: "2",
    label: "クラウド",
    recommended: true,
    source: "claude",
  });
  expect(all[1]?.dependsOn).toEqual([{ id: "D-1", whenOptions: ["2"] }]);
  expect(all[1]?.kind).toBe("text");
  expect((await dw.call("plan.list", { project }))[0]).toMatchObject({
    id: "P-1",
    source: "claude",
  });
});

test("decision_ask can build on existing decisions; mistakes come back as tool errors", async () => {
  await call("decision_ask", {
    title: "A",
    decisions: [
      {
        key: "where",
        question: "保存先は？",
        options: [{ label: "ローカル" }, { label: "クラウド" }],
      },
    ],
  });
  const ok = await call("decision_ask", {
    title: "B",
    decisions: [
      { key: "x", question: "暗号化は？", dependsOn: [{ ref: "D-1", whenOptions: ["クラウド"] }] },
    ],
  });
  expect(ok.text).toContain("x = D-2 [pending]");

  const badLabel = await call("decision_ask", {
    title: "C",
    decisions: [
      { key: "y", question: "Q?", dependsOn: [{ ref: "D-1", whenOptions: ["オンプレ"] }] },
    ],
  });
  expect(badLabel.isError).toBe(true);
  expect(badLabel.text).toContain('no option "オンプレ" (has: ローカル, クラウド)');

  const cycle = await call("decision_ask", {
    title: "D",
    decisions: [
      { key: "a", question: "A?", dependsOn: [{ ref: "b" }] },
      { key: "b", question: "B?", dependsOn: [{ ref: "a" }] },
    ],
  });
  expect(cycle.isError).toBe(true);
  expect(cycle.text).toContain("cycle");
  expect(await dw.call("decision.list", { project })).toHaveLength(2); // nothing half-created
});

test("decision_list and decision_get return compact text", async () => {
  await call("decision_ask", {
    title: "A",
    decisions: [
      {
        key: "where",
        question: "保存先は？",
        options: [{ label: "ローカル" }, { label: "クラウド" }],
      },
      { key: "sync", question: "同期方式は？", dependsOn: [{ ref: "where" }] },
    ],
  });
  expect((await call("decision_list", {})).text).toBe(
    "D-1 [ready] 保存先は？\nD-2 [pending] [waiting on D-1] 同期方式は？",
  );
  await dw.call("decision.answer", {
    project,
    id: "D-1",
    expectedVersion: 1,
    answer: { selected: ["2"] },
    rationale: "複数端末",
  });
  expect((await call("decision_list", { status: "decided" })).text).toBe(
    "D-1 保存先は？ → クラウド (reason: 複数端末)",
  );
  const get = await call("decision_get", { id: "D-1" });
  expect(get.text).toContain("- クラウド");
  expect(get.text).not.toContain("Not decided yet.");
  expect((await call("decision_get", { id: "D-9" })).isError).toBe(true);
});

test(`decision_list stops at ${LIST_LIMIT} items (NFR-06)`, async () => {
  await call("decision_ask", {
    title: "many",
    decisions: Array.from({ length: 35 }, (_, i) => ({ key: `k${i}`, question: `Q${i}?` })),
  });
  const list = (await call("decision_list", {})).text.split("\n");
  expect(list).toHaveLength(LIST_LIMIT + 1);
  expect(list.at(-1)).toBe("…and 5 more.");
});
