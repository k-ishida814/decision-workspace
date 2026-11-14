import { basename } from "node:path";
import { DwClient } from "@dw/ipc-client";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createElement } from "react";
import { App } from "./App";
import { daemonBackend } from "./backend";

export { App, keyToAction } from "./App";
export { type Backend, daemonBackend } from "./backend";

export type StartOptions = { socketPath: string; project: string; autoStart?: () => void };

/** Open the TUI for one project. Resolves when the user quits. */
export async function startTui(options: StartOptions): Promise<void> {
  const client = await DwClient.connect({
    socketPath: options.socketPath,
    autoStart: options.autoStart,
  });
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const closed = new Promise<void>((resolve) => renderer.on("destroy", () => resolve()));
  // If the daemon goes away, leave instead of showing stale data.
  client.onClose(() => renderer.destroy());
  createRoot(renderer).render(
    createElement(App, {
      backend: daemonBackend(client, options.project),
      title: basename(options.project),
    }),
  );
  await closed;
  client.close();
}
