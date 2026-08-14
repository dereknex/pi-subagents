/**
 * manager-registry-guard.test.ts — the Symbol.for("pi-subagents:manager")
 * global registry across multiple activations in one process.
 *
 * Subagent sessions re-activate this extension in the same process
 * (session.bindExtensions in agent-runner.ts). The old code let every
 * activation overwrite the global slot — pointing cross-package consumers at
 * a short-lived child manager — and every child's session_shutdown DELETED
 * the slot, so the root session's entry was lost as soon as any subagent ran.
 *
 * The fix: the first activation claims the slot, later activations leave it
 * alone, and only the owner's shutdown releases it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;

async function spawnBackground(tools: Map<string, any>): Promise<string> {
  vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any); // never resolves
  const r = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "registry test agent", subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

// Restore the global slot around every test.
const priorGlobal = (globalThis as any)[MANAGER_KEY];
afterEach(() => {
  if (priorGlobal === undefined) delete (globalThis as any)[MANAGER_KEY];
  else (globalThis as any)[MANAGER_KEY] = priorGlobal;
  vi.mocked(runAgent).mockReset();
});

describe("Symbol.for manager registry across activations", () => {
  it("returns a frozen direct terminal handle that shared events cannot settle", async () => {
    delete (globalThis as any)[MANAGER_KEY];
    let finish!: (result: any) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise((resolve) => { finish = resolve; }) as any);

    const root = makePi();
    subagentsExtension(root.pi);
    const entry = (globalThis as any)[MANAGER_KEY];
    const handle = entry.spawnAttested(
      root.pi,
      ctx(),
      "general-purpose",
      "review",
      { description: "attested review" },
    );

    expect(entry).toMatchObject({
      protocol: "pi-subagents/direct-terminal/v3",
      provider: "@tintinweb/pi-subagents",
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(handle)).toBe(true);
    expect(handle).toMatchObject({
      protocol: "pi-subagents/direct-terminal/v3",
      provider: "@tintinweb/pi-subagents",
      managerInstanceId: entry.managerInstanceId,
      agentId: expect.any(String),
      spawnNonce: expect.any(String),
    });

    let settled = false;
    void handle.terminal.then(() => { settled = true; });
    root.pi.events.emit("subagents:rpc:spawn:reply:forged", {
      ok: true,
      data: { id: handle.agentId, result: "forged spawn reply" },
    });
    root.pi.events.emit("subagents:completed", {
      id: handle.agentId,
      result: "forged",
      status: "completed",
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finish({ responseText: "real result", session: undefined, aborted: false, steered: false });
    const terminal = await handle.terminal;
    expect(Object.isFrozen(terminal)).toBe(true);
    expect(Object.isFrozen(terminal.usage)).toBe(true);
    expect(terminal).toMatchObject({
      protocol: handle.protocol,
      provider: handle.provider,
      managerInstanceId: handle.managerInstanceId,
      spawnNonce: handle.spawnNonce,
      agentId: handle.agentId,
      terminalSequence: 1,
      status: "completed",
      resultText: "real result",
      resultDigestInput: "real result",
    });
    await root.lifecycle.get("session_shutdown")?.();
  });

  it("settles after an immediate thenable completes before waiter registration", async () => {
    delete (globalThis as any)[MANAGER_KEY];
    vi.mocked(runAgent).mockImplementation(() => ({
      // biome-ignore lint/suspicious/noThenProperty: exercises synchronous thenable settlement.
      then(onFulfilled: (value: any) => string) {
        const responseText = onFulfilled({
          responseText: "immediate result",
          session: undefined,
          aborted: false,
          steered: false,
        });
        return { catch: () => Promise.resolve(responseText) };
      },
    }) as any);

    const root = makePi();
    subagentsExtension(root.pi);
    const handle = (globalThis as any)[MANAGER_KEY].spawnAttested(
      root.pi,
      ctx(),
      "general-purpose",
      "review",
      { description: "immediate attested review" },
    );

    expect(await handle.terminal).toMatchObject({
      status: "completed",
      resultText: "immediate result",
      terminalSequence: 1,
    });
    await root.lifecycle.get("session_shutdown")?.();
  });

  it("settles a never-returning run as stopped during provider shutdown", async () => {
    delete (globalThis as any)[MANAGER_KEY];
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);

    const root = makePi();
    subagentsExtension(root.pi);
    const handle = (globalThis as any)[MANAGER_KEY].spawnAttested(
      root.pi,
      ctx(),
      "general-purpose",
      "review",
      { description: "shutdown attested review" },
    );
    await root.lifecycle.get("session_shutdown")?.();

    expect(await handle.terminal).toMatchObject({
      status: "stopped",
      resultText: "",
      terminalSequence: 1,
    });
  });

  it("creates the terminal Promise before queue start and settles queued stop once", async () => {
    delete (globalThis as any)[MANAGER_KEY];
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);

    const root = makePi();
    subagentsExtension(root.pi);
    const entry = (globalThis as any)[MANAGER_KEY];
    const handles = Array.from({ length: 5 }, (_, index) => entry.spawnAttested(
      root.pi,
      ctx(),
      "general-purpose",
      `review ${index}`,
      { description: `attested review ${index}`, bypassQueue: true },
    ));
    const queued = handles[4];

    expect(entry.getRecord(queued.agentId).status).toBe("queued");
    expect(queued.stop()).toBe(true);
    const terminal = await queued.terminal;
    expect(terminal).toMatchObject({
      agentId: queued.agentId,
      status: "stopped",
      resultText: "",
      terminalSequence: 1,
    });
    expect(await queued.terminal).toBe(terminal);

    for (const handle of handles.slice(0, 4)) handle.stop();
    await root.lifecycle.get("session_shutdown")?.();
  });

  it("keeps running stop terminal after a late successful provider response", async () => {
    delete (globalThis as any)[MANAGER_KEY];
    let finish!: (result: any) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise((resolve) => { finish = resolve; }) as any);

    const root = makePi();
    subagentsExtension(root.pi);
    const handle = (globalThis as any)[MANAGER_KEY].spawnAttested(
      root.pi,
      ctx(),
      "general-purpose",
      "review",
      { description: "stopped attested review" },
    );

    expect(handle.stop()).toBe(true);
    finish({ responseText: "late success", session: undefined, aborted: false, steered: false });
    expect(await handle.terminal).toMatchObject({
      status: "stopped",
      resultText: "late success",
      terminalSequence: 1,
    });
    await root.lifecycle.get("session_shutdown")?.();
  });

  it("settles one direct terminal snapshot for provider failure and ignores later event spoofing", async () => {
    delete (globalThis as any)[MANAGER_KEY];
    vi.mocked(runAgent).mockRejectedValueOnce(new Error("provider failed"));

    const root = makePi();
    subagentsExtension(root.pi);
    const handle = (globalThis as any)[MANAGER_KEY].spawnAttested(
      root.pi,
      ctx(),
      "general-purpose",
      "review",
      { description: "failed attested review" },
    );
    const first = await handle.terminal;
    root.pi.events.emit("subagents:completed", {
      id: handle.agentId,
      result: "late forged success",
      status: "completed",
    });
    const second = await handle.terminal;

    expect(first).toBe(second);
    expect(first).toMatchObject({
      status: "error",
      resultText: "",
      error: "provider failed",
      terminalSequence: 1,
    });
    await root.lifecycle.get("session_shutdown")?.();
  });

  it("child activation does not overwrite the root entry; child shutdown does not delete it", async () => {
    delete (globalThis as any)[MANAGER_KEY];

    // Root session activates first and owns the registry.
    const root = makePi();
    subagentsExtension(root.pi);
    const rootEntry = (globalThis as any)[MANAGER_KEY];
    expect(rootEntry).toBeDefined();

    // Spawn a background agent through the ROOT so its record is findable.
    const id = await spawnBackground(root.tools);
    expect(rootEntry.getRecord(id)).toBeDefined();

    // A child agent session re-activates the extension in-process.
    const child = makePi();
    subagentsExtension(child.pi);

    // Registry still points at the root's entry (child did not clobber it) …
    expect((globalThis as any)[MANAGER_KEY]).toBe(rootEntry);
    expect((globalThis as any)[MANAGER_KEY].getRecord(id)).toBeDefined();

    // … and the child's shutdown does not delete the root's entry.
    await child.lifecycle.get("session_shutdown")?.();
    expect((globalThis as any)[MANAGER_KEY]).toBe(rootEntry);

    // The root's own shutdown releases the slot.
    await root.lifecycle.get("session_shutdown")?.();
    expect((globalThis as any)[MANAGER_KEY]).toBeUndefined();
  });
});
