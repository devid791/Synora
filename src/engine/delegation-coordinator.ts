import { randomUUID } from "node:crypto";
import { z } from "zod";

const identity = z.string().min(1);
const timestamp = z.number().int().nonnegative().safe();

export const delegationReviewInputSchema = z
  .object({
    verdict: z.enum(["accepted", "changes_requested"]),
    summary: z
      .string()
      .min(1)
      .max(20000)
      .refine(
        (value) => value.trim().length > 0,
        "Review summary must not be blank",
      ),
    parentThreadId: identity,
    parentTurnId: identity,
    callId: identity,
  })
  .strict();
export type DelegationReviewInput = z.infer<typeof delegationReviewInputSchema>;
const reviewSchema = delegationReviewInputSchema.extend({ at: timestamp });

/** Credential-free durable state. Opaque payloads must be sanitized by the host. */
export const delegationTaskSchema = z
  .object({
    id: identity,
    name: identity,
    workerId: identity,
    parentConversationId: identity,
    parentThreadId: identity,
    parentTurnId: identity,
    callId: identity,
    task: identity,
    status: z.enum([
      "queued",
      "running",
      "completed",
      "failed",
      "cancelled",
      "unknown",
    ]),
    // All times are Unix milliseconds. The original budget survives cold boot.
    createdAt: timestamp,
    updatedAt: timestamp,
    deadlineAt: timestamp,
    result: z.string(),
    error: z.string().optional(),
    threadId: identity.optional(),
    sessionId: identity.optional(),
    turnId: identity.optional(),
    items: z.array(z.unknown()).optional(),
    tokenUsage: z.unknown().optional(),
    approval: z.unknown().optional(),
    review: reviewSchema.optional(),
    revisesTaskId: identity.optional(),
  })
  .strict();

export type DelegationTask = z.infer<typeof delegationTaskSchema>;
export type DelegationStatus = DelegationTask["status"];
export type DelegationStartInput = Pick<
  DelegationTask,
  | "name"
  | "workerId"
  | "parentConversationId"
  | "parentThreadId"
  | "parentTurnId"
  | "callId"
  | "task"
> & { timeoutMs: number; revisesTaskId?: string };
export type DelegationUpdate = Partial<
  Pick<
    DelegationTask,
    | "threadId"
    | "sessionId"
    | "turnId"
    | "items"
    | "tokenUsage"
    | "approval"
    | "result"
  >
>;
export type DelegationPublish = (
  update: DelegationUpdate,
  final?: boolean,
) => void;
export type DelegationExecutor = (
  task: DelegationTask,
  signal: AbortSignal,
  publish: DelegationPublish,
) => Promise<{ result: string }>;

export interface DelegationCoordinatorOptions {
  /** One coordinator exclusively owns this store; save is synchronous/atomic. */
  load: () => DelegationTask[];
  save: (tasks: DelegationTask[]) => void;
  /**
   * Settlement MUST include cleanup, including on abort, rejection and success.
   * An executor needing a hard lifecycle stop must implement it in its abort
   * handler. This coordinator never detaches an unsettled execution promise.
   * Only non-secret, cloneable, persistence-compatible payloads may be published;
   * task text, results and executor error messages must also be credential-free.
   */
  execute: DelegationExecutor;
  /** Trusted host observer, called after persistence with isolated snapshots. */
  onChange?: (tasks: DelegationTask[]) => void;
  /** Positive safe integer limiting occupied executor/cleanup slots; default 2. */
  queueConcurrency?: number;
  /**
   * Same-key executions serialize through cleanup. The host should return a
   * workspace identity to protect shared workspaces across conversations.
   * Captured before ACK; the host must keep this resource assignment stable.
   * Default: `${task.parentConversationId}/${task.workerId}`.
   */
  resourceKey?: (task: DelegationTask) => string;
  /** Trusted, symmetric predicate; e.g. canonical parent/child workspace paths. */
  resourcesConflict?: (left: string, right: string) => boolean;
}

const inputKeys = [
  "name",
  "workerId",
  "parentConversationId",
  "parentThreadId",
  "parentTurnId",
  "callId",
  "task",
] as const;
const updateSchema = delegationTaskSchema
  .pick({
    threadId: true,
    sessionId: true,
    turnId: true,
    items: true,
    tokenUsage: true,
    approval: true,
    result: true,
  })
  .partial()
  .strict();
const pending = (task: DelegationTask) =>
  task.status === "queued" || task.status === "running";
const callKey = (task: Pick<DelegationTask, "parentThreadId" | "callId">) =>
  JSON.stringify([task.parentThreadId, task.callId]);
const describeError = (error: unknown): string => {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "Executor failed with an unreadable error";
  }
};

interface OwnedExecution {
  id: string;
  resourceKey: string;
  controller: AbortController;
  started: boolean;
  finalPublished?: boolean;
  timer?: ReturnType<typeof setTimeout>;
  stop?: { status: "cancelled" | "failed"; error: string };
  settled: Promise<void>;
  resolve: () => void;
}

/**
 * Provider-neutral, single-writer durable FIFO lifecycle. An ACK is not success.
 * Recovered pending work becomes unknown and is never automatically replayed.
 * Public snapshots cannot mutate the coordinator or its persistence snapshots.
 */
export class DelegationCoordinator {
  private tasks = new Map<string, DelegationTask>();
  private calls = new Map<string, string>();
  private reviewCalls = new Map<string, string>();
  private owned = new Map<string, OwnedExecution>();
  private resources = new Set<string>();
  private listeners = new Map<string, Set<() => void>>();
  private faults: Error[] = [];
  private concurrency: number;
  private running = 0;
  private drainScheduled = false;
  private closed = false;
  private disposal?: Promise<void>;

  constructor(private readonly options: DelegationCoordinatorOptions) {
    this.concurrency = options.queueConcurrency ?? 2;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency <= 0)
      throw new Error("queueConcurrency must be a positive safe integer");

    const loaded = delegationTaskSchema.array().parse(options.load());
    let reconciled = false;
    for (const source of loaded) {
      if (source.deadlineAt <= source.createdAt)
        throw new Error("Delegation deadline must follow creation");
      const task = structuredClone(source);
      const key = callKey(task);
      if (this.tasks.has(task.id) || this.calls.has(key))
        throw new Error("Duplicate durable delegation identity");
      if (pending(task)) {
        task.status = "unknown";
        task.updatedAt = Date.now();
        task.error =
          "Coordinator restarted before settlement; outcome unknown; no replay";
        reconciled = true;
      }
      this.tasks.set(task.id, task);
      this.calls.set(key, task.id);
    }
    for (const task of this.tasks.values()) {
      if (task.review) {
        const key = callKey(task.review);
        if (
          task.status !== "completed" ||
          !task.result.trim() ||
          task.review.parentThreadId !== task.parentThreadId ||
          this.calls.has(key) ||
          this.reviewCalls.has(key)
        )
          throw new Error(
            "Invalid durable delegation review identity or outcome",
          );
        this.reviewCalls.set(key, task.id);
      }
      if (task.revisesTaskId !== undefined) {
        const previous = this.tasks.get(task.revisesTaskId);
        if (
          !previous ||
          previous.id === task.id ||
          previous.parentConversationId !== task.parentConversationId ||
          previous.parentThreadId !== task.parentThreadId ||
          previous.createdAt > task.createdAt ||
          pending(previous) ||
          (previous.status === "completed" &&
            previous.review?.verdict !== "changes_requested")
        )
          throw new Error("Invalid durable delegation revision identity");
        const visited = new Set([task.id]);
        let current: DelegationTask | undefined = previous;
        while (current) {
          if (visited.has(current.id))
            throw new Error("Cyclic durable delegation revision identity");
          visited.add(current.id);
          current = current.revisesTaskId
            ? this.tasks.get(current.revisesTaskId)
            : undefined;
        }
      }
    }
    if (reconciled) {
      options.save(this.list());
      this.notify();
    }
  }

  /** Infrastructure/observer faults are observable here and rejected by dispose. */
  get failure(): AggregateError | undefined {
    return this.faults.length
      ? new AggregateError(
          this.faults.slice(),
          "Delegation coordinator lifecycle failed",
        )
      : undefined;
  }

  /** Synchronous persisted queued ACK; execution begins in a later microtask. */
  start(input: DelegationStartInput): DelegationTask {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("Delegation coordinator is disposed");
    for (const key of inputKeys) identity.parse(input[key]);
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0)
      throw new Error("timeoutMs must be a positive safe integer");
    const key = callKey(input);
    if (this.reviewCalls.has(key))
      throw new Error("Call identity already belongs to a review");
    const previousId = this.calls.get(key);
    if (previousId) {
      const previous = this.tasks.get(previousId)!;
      if (
        inputKeys.some((field) => input[field] !== previous[field]) ||
        input.timeoutMs !== previous.deadlineAt - previous.createdAt ||
        input.revisesTaskId !== previous.revisesTaskId
      )
        throw new Error(
          "Conflicting delegation input for parentThreadId + callId",
        );
      return structuredClone(previous);
    }

    if (input.revisesTaskId !== undefined) {
      identity.parse(input.revisesTaskId);
      const previous = this.get(
        input.revisesTaskId,
        input.parentConversationId,
      );
      if (previous.parentThreadId !== input.parentThreadId)
        throw new Error("Revision must belong to the same supervisor thread");
      if (
        pending(previous) ||
        (previous.status === "completed" &&
          previous.review?.verdict !== "changes_requested")
      )
        throw new Error(
          "Revision requires a terminal failure or an explicit changes-requested review",
        );
    }

    const createdAt = Date.now();
    const task = delegationTaskSchema.parse({
      ...Object.fromEntries(inputKeys.map((field) => [field, input[field]])),
      id: randomUUID(),
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      deadlineAt: createdAt + input.timeoutMs,
      result: "",
      ...(input.revisesTaskId === undefined
        ? {}
        : { revisesTaskId: input.revisesTaskId }),
    });
    const resourceKey = this.options.resourceKey
      ? this.options.resourceKey(structuredClone(task))
      : `${task.parentConversationId}/${task.workerId}`;
    if (typeof resourceKey !== "string" || !resourceKey.length)
      throw new Error("resourceKey must return a nonempty string");
    let resolve!: () => void;
    const execution: OwnedExecution = {
      id: task.id,
      resourceKey,
      controller: new AbortController(),
      started: false,
      settled: new Promise<void>((done) => {
        resolve = done;
      }),
      resolve: () => resolve(),
    };
    this.owned.set(task.id, execution);
    this.calls.set(key, task.id);
    try {
      this.persist(task);
    } catch (error) {
      this.owned.delete(task.id);
      this.calls.delete(key);
      execution.resolve();
      throw error;
    }
    if (this.owned.has(task.id) && !execution.stop) this.armDeadline(execution);
    this.scheduleDrain();
    return structuredClone(task);
  }

  /** Omit owner ONLY for trusted host inventory; tool callers must pass owner. */
  list(owner?: string): DelegationTask[] {
    return structuredClone(
      [...this.tasks.values()].filter(
        (task) => owner === undefined || task.parentConversationId === owner,
      ),
    );
  }

  /** Exact conversation ownership required; absent and foreign IDs both throw. */
  get(id: string, owner: string): DelegationTask {
    const task = this.tasks.get(id);
    if (
      !task ||
      typeof owner !== "string" ||
      task.parentConversationId !== owner
    )
      throw new Error("Delegation task not found for this owner");
    return structuredClone(task);
  }

  /** Owner-checked status only; use get/wait for the full durable task snapshot. */
  status(id: string, owner: string): DelegationStatus {
    return this.get(id, owner).status;
  }

  /** Immutable supervisor decision, distinct from worker completion or human approval. */
  review(
    id: string,
    owner: string,
    input: DelegationReviewInput,
  ): DelegationTask {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("Delegation coordinator is disposed");
    const task = this.get(id, owner),
      request = delegationReviewInputSchema.parse(input);
    if (request.parentThreadId !== task.parentThreadId)
      throw new Error("Review must belong to the same supervisor thread");
    if (task.status !== "completed" || !task.result.trim())
      throw new Error("Only completed worker results can be reviewed");
    const key = callKey(request);
    if (
      this.calls.has(key) ||
      (this.reviewCalls.has(key) && this.reviewCalls.get(key) !== id)
    )
      throw new Error(
        "Review call identity already belongs to another operation",
      );
    if (task.review) {
      if (
        Object.entries(request).some(
          ([field, value]) =>
            task.review![field as keyof DelegationReviewInput] !== value,
        )
      )
        throw new Error("Review is immutable; conflicting replay rejected");
      return task;
    }
    const at = Date.now(),
      next = { ...task, updatedAt: at, review: { ...request, at } };
    // Publish both identities before observers can reenter; failed durable writes undo this reservation.
    this.reviewCalls.set(key, id);
    try {
      this.persist(next);
    } catch (error) {
      this.reviewCalls.delete(key);
      throw error;
    }
    if (this.failure) throw this.failure;
    return this.get(id, owner);
  }

  /**
   * Wait locally for terminal state, or return a current snapshot after 0..25000ms.
   * Aborting this wait rejects it without cancelling the delegated execution.
   */
  async wait(
    id: string,
    owner: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<DelegationTask> {
    const task = this.get(id, owner);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 25_000)
      throw new Error("wait timeoutMs must be an integer from 0 through 25000");
    signal?.throwIfAborted();
    if (!pending(task) || timeoutMs === 0) return task;
    return new Promise<DelegationTask>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.listeners.get(id)?.delete(changed);
        if (!this.listeners.get(id)?.size) this.listeners.delete(id);
      };
      const finish = () => {
        cleanup();
        resolve(this.get(id, owner));
      };
      const changed = () => {
        if (!pending(this.tasks.get(id)!)) finish();
      };
      const abort = () => {
        cleanup();
        reject(signal!.reason);
      };
      const timer = setTimeout(finish, timeoutMs);
      const listeners = this.listeners.get(id) ?? new Set<() => void>();
      listeners.add(changed);
      this.listeners.set(id, listeners);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  /** First stop reason wins. A running task stays nonterminal until cleanup. */
  async cancel(id: string, owner: string): Promise<DelegationTask> {
    this.get(id, owner);
    const execution = this.owned.get(id);
    if (execution) {
      this.stop(execution, "cancelled", "Delegation cancelled by owner");
      await execution.settled;
      if (this.failure) throw this.failure;
    }
    return this.get(id, owner);
  }

  /** Stop admission, cancel all work owned by this instance, and join cleanup. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true;
    const executions = [...this.owned.values()];
    this.disposal = Promise.all(
      executions.map((execution) => execution.settled),
    ).then(() => {
      if (this.failure) throw this.failure;
    });
    for (const execution of executions)
      this.stop(execution, "cancelled", "Delegation coordinator disposed");
    return this.disposal;
  }

  private persist(task: DelegationTask): void {
    const next = new Map(this.tasks);
    next.set(task.id, task);
    // save must not reenter the coordinator. Observers may query/cancel it.
    this.options.save(structuredClone([...next.values()]));
    this.tasks = next;
    this.notify(task.id);
  }

  private notify(id?: string): void {
    if (id)
      for (const listener of [...(this.listeners.get(id) ?? [])]) listener();
    try {
      this.options.onChange?.(this.list());
    } catch (error) {
      this.recordFault(
        new Error("Delegation onChange failed", { cause: error }),
      );
    }
  }

  private recordFault(error: Error): void {
    this.faults.push(error);
    if (this.faults.length !== 1) return;
    this.closed = true;
    for (const execution of [...this.owned.values()])
      this.stop(
        execution,
        "failed",
        "Delegation coordinator infrastructure failed",
      );
  }

  private persistOwned(task: DelegationTask): void {
    try {
      this.persist(task);
    } catch (error) {
      // Never report an unpersisted success. Disk may still contain running state;
      // next boot reconciles it to unknown. Expose the fault without an orphaned
      // background rejection, and still join every executor during shutdown.
      this.tasks.set(task.id, {
        ...task,
        status: "unknown",
        error: "Delegation persistence failed; durable outcome is unknown",
      });
      this.recordFault(
        new Error("Delegation persistence failed", { cause: error }),
      );
      for (const listener of [...(this.listeners.get(task.id) ?? [])])
        listener();
    }
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.closed) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      if (this.closed) return;
      for (const execution of this.owned.values()) {
        if (execution.started || execution.stop) continue;
        if (this.expired(execution)) continue;
        if (this.running >= this.concurrency) break;
        if (
          [...this.resources].some((key) =>
            this.options.resourcesConflict
              ? this.options.resourcesConflict(key, execution.resourceKey)
              : key === execution.resourceKey,
          )
        )
          continue;
        execution.started = true;
        this.running++;
        this.resources.add(execution.resourceKey);
        // run observes executor rejection and always settles the tracked receipt.
        void this.run(execution);
      }
    });
  }

  private armDeadline(execution: OwnedExecution): void {
    const remaining = this.tasks.get(execution.id)!.deadlineAt - Date.now();
    execution.timer = setTimeout(
      () => {
        execution.timer = undefined;
        if (!this.expired(execution) && !execution.stop)
          this.armDeadline(execution);
      },
      Math.min(2_147_483_647, Math.max(0, remaining)),
    );
  }

  private expired(execution: OwnedExecution): boolean {
    if (Date.now() < this.tasks.get(execution.id)!.deadlineAt) return false;
    this.stop(execution, "failed", "Delegation overall deadline exceeded");
    return true;
  }

  private stop(
    execution: OwnedExecution,
    status: "cancelled" | "failed",
    error: string,
  ): void {
    if (execution.stop || !this.owned.has(execution.id)) return;
    execution.stop = { status, error };
    clearTimeout(execution.timer);
    if (execution.started) {
      this.persistOwned({
        ...this.tasks.get(execution.id)!,
        updatedAt: Date.now(),
        error: `${error}; awaiting executor cleanup`,
      });
      execution.controller.abort(new Error(error));
    } else {
      execution.controller.abort(new Error(error));
      this.finish(execution, status, undefined, error);
    }
  }

  private publish(
    execution: OwnedExecution,
    update: DelegationUpdate,
    final = false,
  ): void {
    const task = this.tasks.get(execution.id)!;
    if (
      !this.owned.has(execution.id) ||
      execution.finalPublished ||
      (execution.stop && !final) ||
      !pending(task)
    )
      return;
    if (this.expired(execution) && !final) return;
    try {
      const values = structuredClone(updateSchema.parse(update));
      // The owned executor flushes once AFTER its cleanup, even when cancelled.
      // This retains final command identities/output, never a completed status.
      if (final) execution.finalPublished = true;
      // Updates are snapshots, not deltas; undefined leaves the previous field.
      const defined = Object.fromEntries(
        Object.entries(values).filter(([, value]) => value !== undefined),
      );
      this.persistOwned({ ...task, ...defined, updatedAt: Date.now() });
    } catch (error) {
      this.stop(
        execution,
        "failed",
        `Invalid delegation update: ${describeError(error)}`,
      );
    }
  }

  private async run(execution: OwnedExecution): Promise<void> {
    let result: string | undefined;
    let error: string | undefined;
    try {
      this.persistOwned({
        ...this.tasks.get(execution.id)!,
        status: "running",
        updatedAt: Date.now(),
      });
      if (execution.stop || this.expired(execution)) return;
      const output = await this.options.execute(
        structuredClone(this.tasks.get(execution.id)!),
        execution.controller.signal,
        (update, final) => this.publish(execution, update, final),
      );
      if (!output || typeof output.result !== "string")
        throw new Error("Delegation executor must settle with a string result");
      result = output.result;
    } catch (caught) {
      error = describeError(caught);
    } finally {
      if (!execution.stop) this.expired(execution);
      const stopped = execution.stop;
      this.finish(
        execution,
        stopped?.status ?? (error === undefined ? "completed" : "failed"),
        stopped || error !== undefined ? undefined : result,
        stopped
          ? `${stopped.error}${error === undefined ? "" : `; executor: ${error}`}`
          : error,
      );
    }
  }

  private finish(
    execution: OwnedExecution,
    status: DelegationStatus,
    result?: string,
    error?: string,
  ): void {
    clearTimeout(execution.timer);
    this.owned.delete(execution.id);
    if (execution.started) {
      this.running--;
      this.resources.delete(execution.resourceKey);
    }
    this.persistOwned({
      ...this.tasks.get(execution.id)!,
      status,
      updatedAt: Date.now(),
      ...(result === undefined ? {} : { result }),
      ...(error === undefined ? {} : { error }),
    });
    execution.resolve();
    this.scheduleDrain();
  }
}
