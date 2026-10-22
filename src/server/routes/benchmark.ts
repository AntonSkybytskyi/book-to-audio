import type { FastifyInstance } from "fastify";
import {
  BenchmarkBusyError,
  BenchmarkStoppedError,
  type BenchmarkRunner,
} from "../benchmark/runner.js";
import { toBenchmarkView, type BenchmarkView } from "../benchmark/view.js";
import type { BenchmarkRepository, MachineInfo } from "../benchmark/repository.js";
import type { SettingsStore } from "../settings/settings.js";
import type { TtsEngine } from "../tts/engine.js";
import { sendError } from "./errors.js";

export interface BenchmarkRouteDeps {
  runner: Pick<BenchmarkRunner, "status" | "start" | "cancel" | "needsRun" | "busy">;
  repo: BenchmarkRepository;
  engine: TtsEngine;
  settings: Pick<SettingsStore, "workers" | "maxWorkers">;
  machine: () => MachineInfo;
}

/**
 * `GET /api/benchmark`: the latest results and whether a run is going on. `POST /api/benchmark`
 * starts a run (409 while one is going on, or 202 when it takes over a first-start run that is still
 * waiting); `DELETE` cancels it (409 when none is running).
 */
export function registerBenchmarkRoutes(api: FastifyInstance, deps: BenchmarkRouteDeps) {
  const { runner, repo, engine, settings, machine } = deps;
  const view = (): BenchmarkView =>
    toBenchmarkView({
      engine,
      repo,
      status: runner.status(),
      machine: machine(),
      workers: { current: settings.workers(), max: settings.maxWorkers },
      needsRun: runner.needsRun(),
    });

  api.get("/benchmark", async () => view());

  api.post("/benchmark", async (_req, reply) => {
    try {
      runner.start("manual");
    } catch (error) {
      if (error instanceof BenchmarkBusyError) {
        return sendError(reply, 409, "conflict", "A speed test is already running.");
      }
      if (error instanceof BenchmarkStoppedError) {
        return sendError(reply, 503, "shutting_down", "The app is shutting down.");
      }
      throw error;
    }
    return reply.code(202).send(view());
  });

  api.delete("/benchmark", async (_req, reply) => {
    if (!runner.busy) return sendError(reply, 409, "conflict", "No speed test is running.");
    await runner.cancel();
    return view();
  });
}
