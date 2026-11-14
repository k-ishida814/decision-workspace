/**
 * Daemon client (T-105). Uses node:net so it runs on Bun (CLI, TUI, hook, MCP) and Node
 * (VS Code extension).
 */
import { connect as netConnect, type Socket } from "node:net";
import {
  DwEvent,
  type MethodName,
  methods,
  type ParamsOf,
  type ResultOf,
  type RpcResponse,
  RunEvent,
} from "@dw/protocol";
import { encode, LineDecoder } from "./framing";

export class RpcCallError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcCallError";
  }
}

export class DaemonUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonUnavailableError";
  }
}

export type ConnectOptions = {
  socketPath: string;
  /** Called once if nothing is listening; should start the daemon in the background. */
  autoStart?: () => void;
  /** How long to keep retrying after autoStart (ms). */
  startTimeoutMs?: number;
};

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; method: MethodName };

export class DwClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(e: DwEvent) => void>();
  private readonly runListeners = new Set<(e: RunEvent) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;

  private constructor(private readonly socket: Socket) {
    const decoder = new LineDecoder();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      for (const line of decoder.push(chunk)) this.receive(line);
    });
    socket.on("close", () => this.handleClose());
    socket.on("error", () => this.handleClose());
  }

  static async connect(options: ConnectOptions): Promise<DwClient> {
    try {
      return new DwClient(await openSocket(options.socketPath));
    } catch (error) {
      if (!options.autoStart || !isNotListening(error)) {
        throw new DaemonUnavailableError(`cannot connect to daemon: ${(error as Error).message}`);
      }
    }
    options.autoStart();
    const deadline = Date.now() + (options.startTimeoutMs ?? 3000);
    let last: unknown;
    while (Date.now() < deadline) {
      await sleep(50);
      try {
        return new DwClient(await openSocket(options.socketPath));
      } catch (error) {
        last = error;
      }
    }
    throw new DaemonUnavailableError(
      `daemon did not start: ${(last as Error)?.message ?? "timeout"}`,
    );
  }

  call<M extends MethodName>(
    method: M,
    params: ParamsOf<M>,
    options: { timeoutMs?: number } = {},
  ): Promise<ResultOf<M>> {
    if (this.closed) return Promise.reject(new DaemonUnavailableError("connection closed"));
    const id = this.nextId++;
    return new Promise<ResultOf<M>>((resolve, reject) => {
      const timer = options.timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new RpcCallError(-32000, `${method} timed out after ${options.timeoutMs}ms`));
          }, options.timeoutMs)
        : undefined;
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as ResultOf<M>);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.socket.write(encode({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /** Receive `event` notifications. Call `events.subscribe` first. */
  onEvent(listener: (e: DwEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Agent runs starting / finishing (Deep Dive etc.). Call `events.subscribe` first. */
  onRun(listener: (e: RunEvent) => void): () => void {
    this.runListeners.add(listener);
    return () => this.runListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    this.socket.end();
    this.handleClose();
  }

  private receive(line: string): void {
    let msg: { id?: number | null; method?: string; params?: unknown } & Partial<RpcResponse>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method === "run") {
      const parsed = RunEvent.safeParse(msg.params);
      if (parsed.success) for (const l of this.runListeners) l(parsed.data);
      return;
    }
    if (msg.method === "event") {
      const parsed = DwEvent.safeParse(msg.params);
      if (parsed.success) for (const l of this.listeners) l(parsed.data);
      return;
    }
    if (typeof msg.id !== "number") return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if ("error" in msg && msg.error) {
      pending.reject(new RpcCallError(msg.error.code, msg.error.message, msg.error.data));
      return;
    }
    const result = methods[pending.method].result.safeParse((msg as { result: unknown }).result);
    if (result.success) pending.resolve(result.data);
    else pending.reject(new RpcCallError(-32603, `invalid ${pending.method} result from daemon`));
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values())
      p.reject(new DaemonUnavailableError("connection closed"));
    this.pending.clear();
    for (const l of this.closeListeners) l();
  }
}

function openSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(path);
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function isNotListening(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
