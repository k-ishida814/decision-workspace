/**
 * The page's side of the Rust bridge (src-tauri/src/main.rs): `message` events carry stdin lines;
 * commands show the window and write the final line on stdout. Uses the global Tauri API
 * (withGlobalTauri), so the page has no Tauri npm dependency.
 */
type TauriGlobal = {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  event: {
    listen: (event: string, handler: (e: { payload: string }) => void) => Promise<() => void>;
  };
};

const tauri = (): TauriGlobal | undefined => (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__;

export type Bridge = {
  /** Calls back with each stdin line. */
  onMessage: (handler: (line: string) => void) => void;
  /** Rendered: fit the height and show the window (without taking focus). */
  shown: (height: number) => void;
  fit: (height: number) => void;
  /** The final message; the Popup exits after it. */
  reply: (line: string) => void;
};

export function tauriBridge(): Bridge {
  return {
    onMessage: (handler) => {
      const t = tauri();
      if (!t) return;
      // Listen first, then ask for what arrived before (main.rs keeps it until `ready`).
      void t.event.listen("message", (e) => handler(e.payload)).then(() => t.core.invoke("ready"));
    },
    shown: (height) => void tauri()?.core.invoke("show", { height }),
    fit: (height) => void tauri()?.core.invoke("fit", { height }),
    reply: (line) => void tauri()?.core.invoke("reply", { line }),
  };
}
