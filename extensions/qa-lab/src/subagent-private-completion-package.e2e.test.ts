import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { promisify } from "node:util";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { writeGatewayRestartIntentSync } from "openclaw/plugin-sdk/qa-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeQaHttpServer } from "./bus-server.js";
import { createQaGatewayChild, type QaGatewayChild } from "./gateway-child.js";
import { QA_SUBAGENT_TERMINAL_MARKERS } from "./providers/mock-openai/mock-openai-contracts.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";
import { waitForQaTransportCondition } from "./qa-transport.js";

const exec = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const candidateTarball = process.env.OPENCLAW_CURRENT_PACKAGE_TGZ;
const releasedVersion = "2026.9.4";
const privateMarker = /QA-PARENT-PRIVATE-CHILD[12]|qa-private-result\.png/u;
const ordinaryMarker = QA_SUBAGENT_TERMINAL_MARKERS.silent;
const png =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAALklEQVR4nO3OoQEAAAyDsP7/9HYGJgJNdtuVDQAAAAAAACAHxH8AAAAAAACAHvBX0fhq85dN7QAAAABJRU5ErkJggg==";

async function holdProviderRequests(baseUrl: string) {
  let armed = false;
  let childHeld = false;
  let mainHeld = false;
  const child = Promise.withResolvers<void>();
  const main = Promise.withResolvers<void>();
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      const input: unknown = body ? JSON.parse(body).input : undefined;
      const latestUser = Array.isArray(input)
        ? input.findLast((item) => item.role === "user")
        : undefined;
      const prompt = JSON.stringify(latestUser?.content ?? "");
      const closed = new Promise<void>((resolve) => res.once("close", resolve));
      if (armed && /Subagent private completion QA worker: first\./u.test(prompt)) {
        childHeld = true;
        await Promise.race([child.promise, closed]);
      } else if (armed && prompt.includes("QA PACKAGE MAIN HOLD")) {
        mainHeld = true;
        await Promise.race([main.promise, closed]);
      }
      if (res.destroyed) return;
      const response = await fetch(`${baseUrl}${req.url}`, {
        method: req.method,
        headers: { "content-type": "application/json" },
        ...(req.method === "POST" ? { body } : {}),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, {
        "content-type": response.headers.get("content-type") ?? "application/json",
      });
      res.end(bytes);
    })().catch((error: unknown) => {
      res.writeHead(500).end(String(error));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("provider hold has no port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    arm: () => {
      armed = true;
    },
    childHeld: () => childHeld,
    mainHeld: () => mainHeld,
    releaseChild: () => child.resolve(),
    release: () => {
      armed = false;
      child.resolve();
      main.resolve();
    },
    stop: () => closeQaHttpServer(server),
  };
}

function rows(databasePath: string, sql: string, ...args: SQLInputValue[]) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
}

function record(value: unknown): Record<string, unknown> {
  expect(isRecord(value)).toBe(true);
  return value as Record<string, unknown>;
}

async function observeChat(gateway: QaGatewayChild, events: unknown[]) {
  let client!: GatewayClient;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("package observer connection timed out")),
        30_000,
      );
      client = new GatewayClient({
        url: gateway.wsUrl,
        token: gateway.token,
        deviceIdentity: null,
        clientName: "gateway-client",
        mode: "backend",
        scopes: ["operator.admin"],
        onHelloOk: () => {
          clearTimeout(timer);
          resolve();
        },
        onConnectError: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        onEvent: (event) => {
          if (event.event === "chat") {
            events.push(structuredClone(event.payload));
          }
        },
      });
      client.start();
    });
  } catch (error) {
    await client?.stopAndWait();
    throw error;
  }
  return client;
}

// Package acceptance supplies one attested candidate; ordinary test runs do not download releases.
describe.skipIf(!candidateTarball)("private completion installed-package compatibility", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("keeps ordinary state usable without publishing private completion replies through released-runtime reopen", async () => {
    const prefix = tempDirs.make("openclaw-private-package-");
    const installedRoot = path.join(prefix, "lib", "node_modules", "openclaw");
    const cli = path.join(installedRoot, "openclaw.mjs");
    const evidenceDir = path.join(repoRoot, ".crabbox", "captures", "issue-27445-package");
    await mkdir(evidenceDir, { recursive: true });
    const candidateSha256 = createHash("sha256")
      .update(await readFile(candidateTarball!))
      .digest("hex");
    const sourceTree = (
      await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: repoRoot })
    ).stdout.trim();
    const candidateVersion = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"))
      .version as string;
    const published = JSON.parse(
      (await exec("npm", ["view", `openclaw@${releasedVersion}`, "version", "dist", "--json"]))
        .stdout,
    ) as { version: string; dist: { integrity: string; tarball: string } };
    expect(published.version).toBe(releasedVersion);
    expect(published.dist.integrity).toMatch(/^sha512-/u);
    const phases: Record<string, unknown>[] = [];
    const events: unknown[] = [];
    const mock = await startQaMockOpenAiServer();
    const heldProvider = await holdProviderRequests(mock.baseUrl);
    let owner: ReturnType<typeof createQaGatewayChild> | undefined;
    let observer: GatewayClient | undefined;
    let gateway: QaGatewayChild;
    let agentDb: string;
    let stateDb: string;
    let passed = false;

    async function install(spec: string) {
      await exec("npm", ["install", "-g", "--prefix", prefix, spec, "--no-fund", "--no-audit"], {
        timeout: 300_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const manifest = JSON.parse(
        await readFile(path.join(installedRoot, "package.json"), "utf8"),
      ) as {
        version: string;
      };
      expect(manifest.version).toBe(
        spec === `openclaw@${releasedVersion}` ? releasedVersion : candidateVersion,
      );
      const version = (
        await exec(process.execPath, [cli, "--version"], { cwd: prefix })
      ).stdout.trim();
      expect(version).toContain(manifest.version);
      return { packageVersion: manifest.version, cliVersion: version };
    }

    async function start() {
      owner = createQaGatewayChild();
      const started = await owner.start({
        repoRoot,
        command: {
          executablePath: process.execPath,
          argsPrefix: [cli],
          cwd: prefix,
          usePackagedPlugins: true,
        },
        providerMode: "mock-openai",
        providerBaseUrl: `${heldProvider.baseUrl}/v1`,
        forcedRuntime: "openclaw",
        transport: { requiredPluginIds: [], createGatewayConfig: () => ({}) },
        transportBaseUrl: "http://127.0.0.1",
        controlUiEnabled: false,
        mutateConfig: (cfg) => ({
          ...cfg,
          agents: { ...cfg.agents, defaults: { ...cfg.agents?.defaults, maxConcurrent: 1 } },
          tools: { ...cfg.tools, deny: [...(cfg.tools?.deny ?? []), "message"] },
          plugins: {
            ...cfg.plugins,
            allow: cfg.plugins?.allow?.filter((id) => id !== "qa-lab" && id !== "memory-core"),
            entries: Object.fromEntries(
              Object.entries(cfg.plugins?.entries ?? {}).filter(
                ([id]) => id !== "qa-lab" && id !== "memory-core",
              ),
            ),
            slots: { ...cfg.plugins?.slots, memory: "none" },
          },
          memory: { ...cfg.memory, search: { ...cfg.memory?.search, enabled: false } },
        }),
      });
      expect(started.runtimeEnv.OPENCLAW_DEV_SOURCE_ROOT).toBeUndefined();
      expect(started.runtimeEnv.OPENCLAW_BUNDLED_PLUGINS_DIR).toBeUndefined();
      observer = await observeChat(started, events);
      return {
        gateway: started,
        agentDb: path.join(
          started.runtimeEnv.OPENCLAW_STATE_DIR!,
          "agents",
          "qa",
          "agent",
          "openclaw-agent.sqlite",
        ),
        stateDb: path.join(started.runtimeEnv.OPENCLAW_STATE_DIR!, "state", "openclaw.sqlite"),
      };
    }

    async function tasks(sessionKey: string) {
      const result = record(await gateway.call("tasks.list", { agentId: "qa", limit: 100 }));
      expect(Array.isArray(result.tasks)).toBe(true);
      return (result.tasks as Record<string, unknown>[]).filter(
        (task) => task.sessionKey === sessionKey,
      );
    }

    async function send(sessionKey: string, message: string) {
      await gateway.call("sessions.create", { key: sessionKey });
      const accepted = record(
        await gateway.call("chat.send", { sessionKey, message, idempotencyKey: randomUUID() }),
      );
      expect(accepted.runId).toBeTruthy();
      return accepted;
    }

    async function history(sessionKey: string) {
      return await gateway.call("chat.history", {
        sessionKey,
        agentId: "qa",
        limit: 100,
        maxChars: 100_000,
      });
    }

    // Tool arguments remain normal operator-visible transcript context. This
    // checks reply text/media, not confidentiality from the parent-session UI.
    function replies(messages: unknown[]) {
      return messages
        .filter(isRecord)
        .filter((message) => message.role === "assistant")
        .map((message) => ({
          text: message.text,
          content: Array.isArray(message.content)
            ? message.content.filter(
                (block) =>
                  !isRecord(block) ||
                  !["toolCall", "toolcall", "tool_use", "thinking", "reasoning"].includes(
                    String(block.type),
                  ),
              )
            : message.content,
          attachments: message.attachments,
          mediaUrl: message.mediaUrl,
          mediaUrls: message.mediaUrls,
        }));
    }

    function assertPrivateReplies(messages: unknown[]) {
      const rendered = replies(messages);
      expect(JSON.stringify(rendered)).not.toMatch(privateMarker);
      expect(JSON.stringify(rendered)).not.toMatch(/\bNO_REPLY\b/u);
      for (const reply of rendered) {
        if (Array.isArray(reply.content)) {
          expect(
            reply.content.every(
              (block) => isRecord(block) && ["text", "output_text"].includes(String(block.type)),
            ),
          ).toBe(true);
        }
        expect(reply.attachments ?? []).toEqual([]);
        expect(reply.mediaUrl).toBeUndefined();
        expect(reply.mediaUrls ?? []).toEqual([]);
      }
    }

    async function assertPrivateHistory(sessionKey: string) {
      const page = record(await history(sessionKey));
      expect(page.pendingInputs).toEqual({ items: [], total: 0 });
      expect(Array.isArray(page.messages)).toBe(true);
      const messages = page.messages as unknown[];
      expect(
        JSON.stringify(messages.filter((message) => isRecord(message) && message.role === "user")),
      ).not.toMatch(privateMarker);
      assertPrivateReplies(messages);
    }

    function capturedReplies(since = 0) {
      return events
        .slice(since)
        .filter(isRecord)
        .map((event) => event.message);
    }

    async function privateChain(sessionKey: string) {
      await writeFile(path.join(gateway.workspaceDir, "qa-private-result.png"), png, "base64");
      const eventCursor = events.length;
      const kickoff = await send(
        sessionKey,
        "Subagent terminal reply QA check: private. Review the first child internally, use its result to start a second child, and remain silent after each completion.",
      );
      const children = await waitForQaTransportCondition(
        async () => {
          const children = await tasks(sessionKey);
          return children.length === 2 &&
            children.every(
              (task) => task.status === "completed" && task.deliveryStatus === "delivered",
            )
            ? children
            : undefined;
        },
        120_000,
        100,
      );
      const receipts = rows(
        agentDb,
        "SELECT * FROM session_input_completions WHERE session_key = ? ORDER BY run_id",
        sessionKey,
      );
      expect(receipts.filter((receipt) => receipt.succeeded === 1).length).toBeGreaterThanOrEqual(
        2,
      );
      expect(
        rows(agentDb, "SELECT * FROM session_pending_inputs WHERE session_key = ?", sessionKey),
      ).toEqual([]);
      const stored = rows(
        stateDb,
        "SELECT payload_json FROM subagent_runs WHERE requester_session_key = ? ORDER BY run_id",
        sessionKey,
      );
      expect(stored.length).toBeGreaterThanOrEqual(2);
      expect(
        stored.every((row) => record(JSON.parse(String(row.payload_json))).parentCompletion),
      ).toBe(true);
      await assertPrivateHistory(sessionKey);
      await waitForQaTransportCondition(
        () =>
          events
            .slice(eventCursor)
            .some(
              (event) =>
                isRecord(event) &&
                event.runId === kickoff.runId &&
                event.state === "final" &&
                JSON.stringify(replies([event.message])).includes("Worker started."),
            ) || undefined,
        30_000,
        100,
      );
      assertPrivateReplies(capturedReplies());
      return { sessionKey, children, receipts };
    }

    async function ordinaryChild(sessionKey: string) {
      const eventCursor = events.length;
      await send(
        sessionKey,
        "Subagent terminal reply QA check: silent. Spawn one native worker, then report its completion to this conversation. Do not use ACP.",
      );
      const child = await waitForQaTransportCondition(
        async () => {
          const child = (await tasks(sessionKey)).find(
            (task) => task.title === "qa-terminal-silent",
          );
          return child?.status === "completed" && child.deliveryStatus === "delivered"
            ? child
            : undefined;
        },
        120_000,
        100,
      );
      await waitForQaTransportCondition(
        async () =>
          JSON.stringify(replies(record(await history(sessionKey)).messages as unknown[])).includes(
            ordinaryMarker,
          ) || undefined,
        30_000,
        100,
      );
      // A positive live event qualifies the observation interval after startup.
      await waitForQaTransportCondition(
        () =>
          events
            .slice(eventCursor)
            .some(
              (event) =>
                isRecord(event) &&
                event.sessionKey === sessionKey &&
                JSON.stringify(replies([event.message])).includes(ordinaryMarker),
            ) || undefined,
        30_000,
        100,
      );
      return child;
    }

    async function switchPackage(spec: string, interruptedInput?: Record<string, SQLInputValue>) {
      await observer?.stopAndWait();
      observer = undefined;
      let identity: Awaited<ReturnType<typeof install>> | undefined;
      const originalState = gateway.runtimeEnv.OPENCLAW_STATE_DIR;
      if (interruptedInput) {
        const info = record(await gateway.call("system.info", {}));
        expect(info.pid).toBe(gateway.pid);
        expect(
          writeGatewayRestartIntentSync({
            env: gateway.runtimeEnv,
            targetPid: Number(info.pid),
            reason: "qa-package-version-cycle",
            intent: { force: true },
          }),
        ).toBe(true);
      }
      await gateway.restartAfterStateMutation(async ({ stateDir }) => {
        expect(stateDir).toBe(originalState);
        if (interruptedInput) {
          const stopped = rows(
            agentDb,
            "SELECT * FROM session_pending_inputs WHERE input_id = ?",
            interruptedInput.input_id,
          )[0];
          expect(stopped).toMatchObject({ ...interruptedInput, state: "interrupted" });
          expect(
            rows(
              agentDb,
              "SELECT * FROM session_input_completions WHERE run_id = ? AND succeeded = 1",
              interruptedInput.run_id,
            ),
          ).toEqual([]);
          expect(gateway.logs()).toMatch(/restart shutdown|external-restart/u);
          heldProvider.release();
        }
        identity = await install(spec);
      });
      expect(gateway.runtimeEnv.OPENCLAW_STATE_DIR).toBe(originalState);
      observer = await observeChat(gateway, events);
      return identity;
    }

    try {
      const freshIdentity = await install(candidateTarball!);
      ({ gateway, agentDb, stateDb } = await start());
      const fresh = await privateChain("agent:qa:package-fresh-private");
      phases.push({
        phase: "fresh-candidate",
        ...freshIdentity,
        privateChildren: fresh.children.length,
        processingReceipts: fresh.receipts.length,
      });
      await observer?.stopAndWait();
      observer = undefined;
      expect(
        (await owner!.stop({ preserveToDir: path.join(evidenceDir, "fresh") })).errors,
      ).toEqual([]);
      owner = undefined;

      const releasedIdentity = await install(`openclaw@${releasedVersion}`);
      ({ gateway, agentDb, stateDb } = await start());
      const ordinarySession = "agent:qa:package-released-ordinary";
      const ordinary = await ordinaryChild(ordinarySession);
      const originalSession = rows(
        agentDb,
        "SELECT current_session_id FROM session_nodes WHERE session_key = ?",
        ordinarySession,
      )[0];
      const originalTranscript = rows(
        agentDb,
        "SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq",
        String(originalSession.current_session_id),
      );
      expect(originalTranscript.length).toBeGreaterThan(0);
      phases.push({
        phase: "released-created-state",
        ...releasedIdentity,
        ordinaryTaskId: ordinary.taskId,
        sessionId: originalSession.current_session_id,
      });

      const upgradedIdentity = await switchPackage(candidateTarball!);
      const privateState = await privateChain("agent:qa:package-upgraded-private");
      phases.push({
        phase: "candidate-upgrade",
        ...upgradedIdentity,
        privateChildren: privateState.children.length,
        processingReceipts: privateState.receipts.length,
      });

      // Subagent execution has its own lane. Hold unrelated Main work so private
      // admission is durable while its parent has not begun consuming the result.
      const pendingSession = "agent:qa:package-pending-private";
      heldProvider.arm();
      const kickoff = await send(
        pendingSession,
        "Subagent terminal reply QA check: private. Review the first child internally and remain silent.",
      );
      await waitForQaTransportCondition(() => heldProvider.childHeld() || undefined, 30_000, 50);
      await waitForQaTransportCondition(
        () =>
          events.some(
            (event) => isRecord(event) && event.runId === kickoff.runId && event.state === "final",
          ) || undefined,
        30_000,
        50,
      );
      await send(
        "agent:qa:package-main-blocker",
        "QA PACKAGE MAIN HOLD. repeated request queued reply gateway qa check",
      );
      await waitForQaTransportCondition(() => heldProvider.mainHeld() || undefined, 30_000, 50);
      heldProvider.releaseChild();
      const pendingInput = await waitForQaTransportCondition(
        () =>
          rows(
            agentDb,
            "SELECT * FROM session_pending_inputs WHERE session_key = ? AND state = 'queued'",
            pendingSession,
          ).find((row) => String(row.message_json).includes("QA-PARENT-PRIVATE-CHILD1-")),
        60_000,
        50,
      );
      expect(pendingInput.consumed_event_id).toBeNull();
      expect(record(JSON.parse(String(pendingInput.message_json))).display).toBe(false);
      const pendingNonce = /QA-PARENT-PRIVATE-CHILD1-[A-F0-9]{32}/u.exec(
        String(pendingInput.message_json),
      )?.[0];
      expect(pendingNonce).toBeTruthy();
      expect(
        JSON.stringify(
          rows(
            agentDb,
            "SELECT event_json FROM transcript_events WHERE session_id = ?",
            pendingInput.session_id,
          ),
        ),
      ).not.toContain(pendingNonce);
      expect(
        rows(
          agentDb,
          "SELECT * FROM session_input_completions WHERE run_id = ?",
          pendingInput.run_id,
        ),
      ).toEqual([]);
      phases.push({
        phase: "candidate-queued-private-input",
        sessionId: pendingInput.session_id,
        runId: pendingInput.run_id,
        state: pendingInput.state,
        display: false,
        consumed: false,
      });

      const requestCursor = record(
        await (await fetch(`${mock.baseUrl}/debug/request-cursor`)).json(),
      ).cursor;
      const downgradedIdentity = await switchPackage(`openclaw@${releasedVersion}`, pendingInput);
      await ordinaryChild("agent:qa:package-downgraded-ordinary");
      await assertPrivateHistory(privateState.sessionKey);
      await assertPrivateHistory(pendingSession);
      assertPrivateReplies(capturedReplies());
      expect(
        rows(
          agentDb,
          "SELECT current_session_id FROM session_nodes WHERE session_key = ?",
          ordinarySession,
        )[0],
      ).toEqual(originalSession);
      expect(
        rows(
          agentDb,
          "SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq",
          String(originalSession.current_session_id),
        ),
      ).toEqual(originalTranscript);
      expect((await tasks(ordinarySession)).some((task) => task.taskId === ordinary.taskId)).toBe(
        true,
      );
      expect(
        rows(
          agentDb,
          "SELECT * FROM session_input_completions WHERE session_key = ? ORDER BY run_id",
          privateState.sessionKey,
        ),
      ).toEqual(privateState.receipts);
      const requests: unknown = await (
        await fetch(`${mock.baseUrl}/debug/requests?after=${requestCursor}`)
      ).json();
      expect(JSON.stringify(requests)).not.toMatch(privateMarker);
      phases.push({
        phase: "released-downgrade",
        ...downgradedIdentity,
        ordinaryStatePreserved: true,
        hiddenInterruptedInput: true,
        privateReplayCount: 0,
        observedOrdinaryReply: true,
      });

      const reopenCursor = record(
        await (await fetch(`${mock.baseUrl}/debug/request-cursor`)).json(),
      ).cursor;
      const reopenedIdentity = await switchPackage(candidateTarball!);
      await ordinaryChild("agent:qa:package-reopened-ordinary");
      expect(
        rows(
          agentDb,
          "SELECT * FROM session_input_completions WHERE session_key = ? ORDER BY run_id",
          privateState.sessionKey,
        ),
      ).toEqual(privateState.receipts);
      await assertPrivateHistory(privateState.sessionKey);
      assertPrivateReplies(capturedReplies());
      expect(
        rows(
          agentDb,
          "SELECT current_session_id FROM session_nodes WHERE session_key = ?",
          ordinarySession,
        )[0],
      ).toEqual(originalSession);
      expect(
        JSON.stringify(
          await (await fetch(`${mock.baseUrl}/debug/requests?after=${reopenCursor}`)).json(),
        ),
      ).not.toMatch(privateMarker);
      phases.push({
        phase: "candidate-reopen",
        ...reopenedIdentity,
        ordinaryStatePreserved: true,
        processingReceiptsPreserved: true,
        privateReplayCount: 0,
        observedOrdinaryReply: true,
      });
      expect(phases).toHaveLength(6);
      passed = true;
    } finally {
      heldProvider.release();
      await observer?.stopAndWait();
      if (owner) {
        expect(
          (await owner.stop({ preserveToDir: path.join(evidenceDir, "cycle") })).errors,
        ).toEqual([]);
      }
      await mock.stop();
      await heldProvider.stop();
      await writeFile(
        path.join(evidenceDir, "verdict.json"),
        `${JSON.stringify({ passed, sourceTree, candidateSha256, released: published, phases, proof: "actual installed packages, ordinary WebChat and native subagents, interrupted unconsumed private admission, read-only backing-store observations", limitation: "owned restart intent before package switching; abrupt crash-window fault injection is covered separately by Gateway/SQLite tests; downgrade can discard pending private handoffs; chat observers cover connected post-startup intervals, supplemented by durable history and provider request records; parent-session tool arguments remain visible to its operator" }, null, 2)}\n`,
      );
    }
  }, 1_500_000);
});
