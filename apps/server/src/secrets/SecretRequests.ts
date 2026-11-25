// Answers stay in the secret store behind one-use refs; orchestration records only request status.
// Consuming tools keep values out of transcripts, projections, clients and model context.
// A `file` request instead moves its value to an owner-only file for the agent's own shell.
import {
  CommandId,
  SecretRef,
  SecretRequestError,
  VaultEntryId,
  type NodeId,
  type OrchestrationV2SecretRequestVault,
  type OrchestrationV2TurnItem,
  type ProjectId,
  type RunId,
  type SecretRequestAnswerInput,
  type SecretVaultApprovalInput,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac.
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as VaultService from "../vault/VaultService.ts";

const SECRET_REF_PREFIX = "secret-ref:";
const storeName = (ref: SecretRef) => `secret-request-${ref.slice(SECRET_REF_PREFIX.length)}`;
const REF_PATTERN = /^secret-ref:[0-9a-f]{32}$/;
const SECRET_REF_TTL_MS = 24 * 60 * 60 * 1000;
const STORE_NAME_PATTERN = /^(secret-request-[0-9a-f]{32})\.bin$/;
const FILE_NAME_PATTERN = /^[0-9a-f]{32}(\.partial)?$/;

const refFor = (salt: string, threadId: ThreadId, turnItemId: string) =>
  SecretRef.make(
    `${SECRET_REF_PREFIX}${NodeCrypto.createHmac("sha256", salt)
      .update(`${threadId}\u0000${turnItemId}`)
      .digest("hex")
      .slice(0, 32)}`,
  );

const StoredSecret = Schema.fromJsonString(
  Schema.Struct({
    projectId: Schema.String,
    value: Schema.String,
    savedAt: Schema.Number,
    /** fwai: the vault entry the value came from; only these may fill a page. */
    entryId: Schema.optional(VaultEntryId),
  }),
);
const encodeStored = Schema.encodeEffect(StoredSecret);
const decodeStored = Schema.decodeUnknownOption(StoredSecret);

export class SecretRequests extends Context.Service<
  SecretRequests,
  {
    readonly answer: (input: SecretRequestAnswerInput) => Effect.Effect<void, SecretRequestError>;
    /** fwai: the owner allows or denies another account's run one use of an entry. */
    readonly answerVaultApproval: (
      input: SecretVaultApprovalInput,
    ) => Effect.Effect<void, SecretRequestError>;
    /**
     * fwai: an owner's run uses an in-scope entry with no card. Stores it under the
     * request's ref, as a saved answer would be, and records "Used <name>" and the use.
     */
    readonly useVaultEntry: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly nodeId: NodeId;
      readonly turnItemId: TurnItemId;
      readonly projectId: ProjectId;
      readonly entry: { readonly id: VaultEntryId; readonly name: string };
      readonly label: string;
      readonly reason: string;
      readonly placeholder?: string;
      readonly delivery?: "file";
    }) => Effect.Effect<void, SecretRequestError>;
    readonly savedRef: (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: string;
    }) => Effect.Effect<Option.Option<SecretRef>>;
    readonly consume: (input: {
      readonly ref: SecretRef;
      readonly projectId: ProjectId;
    }) => Effect.Effect<string, SecretRequestError>;
    /**
     * Uses a vault-backed ref for a form fill and returns its entry. A ref without one is left
     * unused and yields undefined.
     */
    readonly consumeForFill: (input: {
      readonly ref: SecretRef;
      readonly projectId: ProjectId;
    }) => Effect.Effect<VaultEntryId | undefined, SecretRequestError>;
    /** Moves a saved `file` request's value to an owner-only file and returns its path. */
    readonly saveToFile: (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: string;
    }) => Effect.Effect<string, SecretRequestError>;
  }
>()("t3/secrets/SecretRequests") {}

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const vault = yield* VaultService.VaultService;
  // Beside the store's own files so the same owner-only directory and cleanup rules apply.
  const filesDir = store.directory === undefined ? undefined : path.join(store.directory, "files");

  const salt = Buffer.from(
    yield* store.getOrCreateRandom("secret-request-salt", 32).pipe(Effect.orDie),
  ).toString("hex");

  const storeNameFor = (threadId: ThreadId, turnItemId: string) =>
    storeName(refFor(salt, threadId, turnItemId));

  // Create, never overwrite, so racing answers cannot replace a value or show saved before storage.
  // An existing value on a pending card finishes an earlier save whose recording failed.
  const storeValue = Effect.fnUntraced(function* (
    name: string,
    record: {
      readonly projectId: ProjectId;
      readonly value: string;
      readonly entryId?: VaultEntryId;
    },
  ) {
    const encoded = yield* encodeStored({
      ...record,
      savedAt: yield* Clock.currentTimeMillis,
    }).pipe(Effect.orDie);
    yield* store.create(name, new TextEncoder().encode(encoded)).pipe(
      Effect.catchIf(ServerSecretStore.isSecretAlreadyExistsError, () => Effect.void),
      Effect.mapError((error) => new SecretRequestError({ reason: "store_failed", cause: error })),
    );
  });

  const storeFromVault = Effect.fnUntraced(function* (
    name: string,
    input: { readonly projectId: ProjectId; readonly entryId: VaultEntryId },
  ) {
    const value = yield* vault
      .readValue(input.entryId)
      .pipe(Effect.mapError(() => new SecretRequestError({ reason: "vault_entry_unavailable" })));
    yield* storeValue(name, { projectId: input.projectId, value, entryId: input.entryId });
  });

  const assertEntryInScope = Effect.fnUntraced(function* (
    entryId: VaultEntryId,
    projectId: ProjectId,
  ) {
    const entry = yield* vault
      .get(entryId)
      .pipe(Effect.mapError(() => new SecretRequestError({ reason: "vault_entry_unavailable" })));
    if (entry.scope !== "global" && !entry.scope.projects.includes(projectId)) {
      return yield* new SecretRequestError({ reason: "vault_entry_unavailable" });
    }
  });

  // Usage is bookkeeping: a failed write must not take back a value already handed over.
  const recordVaultUse = (
    entryId: VaultEntryId,
    usage: {
      readonly threadId: ThreadId;
      readonly accountId: string | undefined;
      readonly delivery: "file" | undefined;
    },
  ) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        vault.recordUse(entryId, {
          at: DateTime.formatIso(now),
          threadId: usage.threadId,
          ...(usage.accountId === undefined ? {} : { accountId: usage.accountId }),
          delivery: usage.delivery === "file" ? "file" : "secretRef",
        }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("Could not record a vault entry use", { reason: error.reason }),
      ),
    );

  const loadPending = Effect.fnUntraced(function* (threadId: ThreadId, turnItemId: string) {
    const records = yield* threadManagement
      .getThreadRecords(threadId, ["runs", "turnItems"], {
        turnItemTypes: ["secret_request"],
        messageRoles: [],
      })
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })));
    const item = records.turnItems.find((candidate) => candidate.id === turnItemId);
    if (item?.type !== "secret_request" || item.runId === null || item.nodeId === null) {
      return yield* new SecretRequestError({ reason: "not_found" });
    }
    if (item.secretStatus !== "pending") {
      return yield* new SecretRequestError({ reason: "already_answered" });
    }
    const run = records.runs.find((candidate) => candidate.id === item.runId);
    if (run === undefined || ThreadManagementService.isTerminalRunStatus(run.status)) {
      return yield* new SecretRequestError({ reason: "agent_stopped" });
    }
    return {
      item,
      run,
      runId: item.runId,
      nodeId: item.nodeId,
      projectId: records.thread.projectId,
    };
  });

  type SecretRequestItem = Extract<OrchestrationV2TurnItem, { readonly type: "secret_request" }>;

  /**
   * Records the card's new status, then makes sure it stuck: the wait may have closed the card,
   * and no one receives the ref of an unrecorded answer, so its value is deleted.
   */
  const recordStatus = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly nodeId: NodeId;
    readonly item: Pick<
      SecretRequestItem,
      "id" | "label" | "reason" | "placeholder" | "delivery" | "vault"
    >;
    readonly secretStatus: "saved" | "declined";
    readonly vault?: OrchestrationV2SecretRequestVault;
  }) {
    const { item } = input;
    const name = storeNameFor(input.threadId, item.id);
    const vaultRecord = input.vault ?? item.vault;
    yield* threadManagement
      .dispatch({
        type: "secret_request.record",
        commandId: CommandId.make(`secret-request:${item.id}:${input.secretStatus}`),
        threadId: input.threadId,
        runId: input.runId,
        nodeId: input.nodeId,
        turnItemId: item.id,
        label: item.label,
        reason: item.reason,
        ...(item.placeholder === undefined ? {} : { placeholder: item.placeholder }),
        ...(item.delivery === undefined ? {} : { delivery: item.delivery }),
        secretStatus: input.secretStatus,
        ...(vaultRecord === undefined ? {} : { vault: vaultRecord }),
      })
      .pipe(
        Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })),
        // Clear failed saves so the pending card can be answered again.
        Effect.tapError(() => (input.secretStatus === "saved" ? removeLogged(name) : Effect.void)),
      );
    if (input.secretStatus !== "saved") return;
    const recorded = yield* threadManagement
      .getThreadRecords(input.threadId, ["turnItems"], {
        turnItemTypes: ["secret_request"],
        messageRoles: [],
      })
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })));
    const card = recorded.turnItems.find((candidate) => candidate.id === item.id);
    if (card?.type === "secret_request" && card.secretStatus !== "saved") {
      yield* removeLogged(name);
      return yield* new SecretRequestError({ reason: "agent_stopped" });
    }
  });

  const answer: SecretRequests["Service"]["answer"] = Effect.fn("SecretRequests.answer")(
    function* (input) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.thread_id": input.threadId,
        "secret_request.answer": input.answer.type,
      });
      const pending = yield* loadPending(input.threadId, input.turnItemId);
      const { item, projectId } = pending;
      // A vault approval is answered with answerVaultApproval, never with a value.
      if (item.vault !== undefined) return yield* new SecretRequestError({ reason: "not_found" });
      const name = storeNameFor(input.threadId, item.id);
      const answer = input.answer;
      switch (answer.type) {
        case "decline":
          return yield* recordStatus({
            ...pending,
            threadId: input.threadId,
            secretStatus: "declined",
          });
        case "vault": {
          if (answer.alsoAllowProject === true) {
            yield* vault.allowProject({ id: answer.entryId, projectId }).pipe(
              Effect.mapError(
                (error) =>
                  new SecretRequestError({
                    reason:
                      error.reason === "not_found" ? "vault_entry_unavailable" : "store_failed",
                  }),
              ),
            );
          }
          yield* assertEntryInScope(answer.entryId, projectId);
          yield* storeFromVault(name, { projectId, entryId: answer.entryId });
          yield* recordStatus({ ...pending, threadId: input.threadId, secretStatus: "saved" });
          return yield* recordVaultUse(answer.entryId, {
            threadId: input.threadId,
            accountId: pending.run.actingAccountId,
            delivery: item.delivery,
          });
        }
        case "save": {
          // The typed answer and its vault copy succeed or fail together: a vault failure leaves
          // the card pending, and a failed answer removes the entry it created.
          const saveToVault = answer.saveToVault;
          const created =
            saveToVault === undefined
              ? undefined
              : yield* vault.create({ ...saveToVault, value: answer.secret }).pipe(
                  Effect.mapError(
                    (error) =>
                      new SecretRequestError({
                        reason:
                          error.reason === "name_taken" ? "vault_name_taken" : "vault_save_failed",
                      }),
                  ),
                );
          return yield* Effect.gen(function* () {
            yield* storeValue(name, {
              projectId,
              value: answer.secret,
              ...(created === undefined ? {} : { entryId: created.id }),
            });
            yield* recordStatus({ ...pending, threadId: input.threadId, secretStatus: "saved" });
          }).pipe(
            Effect.tapError(() =>
              created === undefined ? Effect.void : vault.delete(created.id).pipe(Effect.ignore),
            ),
          );
        }
      }
    },
  );

  const answerVaultApproval: SecretRequests["Service"]["answerVaultApproval"] = Effect.fn(
    "SecretRequests.answerVaultApproval",
  )(function* (input) {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.thread_id": input.threadId,
      "secret_request.decision": input.decision,
    });
    const pending = yield* loadPending(input.threadId, input.turnItemId);
    const approval = pending.item.vault;
    if (approval?.requestedByAccountId === undefined) {
      return yield* new SecretRequestError({ reason: "not_found" });
    }
    if (input.decision === "deny") {
      return yield* recordStatus({
        ...pending,
        threadId: input.threadId,
        secretStatus: "declined",
      });
    }
    yield* assertEntryInScope(approval.entryId, pending.projectId);
    yield* storeFromVault(storeNameFor(input.threadId, pending.item.id), {
      projectId: pending.projectId,
      entryId: approval.entryId,
    });
    yield* recordStatus({ ...pending, threadId: input.threadId, secretStatus: "saved" });
    yield* recordVaultUse(approval.entryId, {
      threadId: input.threadId,
      accountId: pending.run.actingAccountId,
      delivery: pending.item.delivery,
    });
  });

  const useVaultEntry: SecretRequests["Service"]["useVaultEntry"] = Effect.fn(
    "SecretRequests.useVaultEntry",
  )(function* (input) {
    yield* Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId });
    yield* storeFromVault(storeNameFor(input.threadId, input.turnItemId), {
      projectId: input.projectId,
      entryId: input.entry.id,
    });
    yield* recordStatus({
      threadId: input.threadId,
      runId: input.runId,
      nodeId: input.nodeId,
      item: {
        id: input.turnItemId,
        label: input.label,
        reason: input.reason,
        ...(input.placeholder === undefined ? {} : { placeholder: input.placeholder }),
        ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
      },
      secretStatus: "saved",
      vault: { entryId: input.entry.id, entryName: input.entry.name },
    });
    yield* recordVaultUse(input.entry.id, {
      threadId: input.threadId,
      accountId: undefined,
      delivery: input.delivery,
    });
  });

  const savedRef: SecretRequests["Service"]["savedRef"] = Effect.fn("SecretRequests.savedRef")(
    function* (input) {
      const ref = refFor(salt, input.threadId, input.turnItemId);
      const stored = yield* store.get(storeName(ref)).pipe(Effect.orElseSucceed(Option.none));
      return Option.map(stored, () => ref);
    },
  );

  const removeLogged = (name: string) =>
    store.remove(name).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("Could not delete a secret request value", {
          errorTag: error._tag,
        }).pipe(Effect.as(false)),
      ),
    );

  // Serialize get/remove so concurrent consumers cannot read the same one-use ref.
  const consumeLock = yield* Semaphore.make(1);
  const consume: SecretRequests["Service"]["consume"] = (input) =>
    consumeRef(input).pipe(
      consumeLock.withPermits(1),
      Effect.tap(() => Metrics.increment(Metrics.secretRefsConsumedTotal, { result: "used" })),
      Effect.tapError(() =>
        Metrics.increment(Metrics.secretRefsConsumedTotal, { result: "rejected" }),
      ),
      Effect.withSpan("SecretRequests.consume"),
    );

  /** A live ref's record, left in the store. */
  const readRef = Effect.fn("SecretRequests.readRef")(function* (input: {
    readonly ref: SecretRef;
    readonly projectId: ProjectId;
  }) {
    if (!REF_PATTERN.test(input.ref))
      return yield* new SecretRequestError({ reason: "invalid_ref" });
    const stored = yield* store
      .get(storeName(input.ref))
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "read_failed", cause })));
    const decoded = Option.flatMap(stored, (bytes) =>
      decodeStored(new TextDecoder().decode(bytes)),
    );
    if (Option.isNone(decoded) || decoded.value.projectId !== input.projectId) {
      return yield* new SecretRequestError({ reason: "ref_unavailable" });
    }
    if ((yield* Clock.currentTimeMillis) - decoded.value.savedAt > SECRET_REF_TTL_MS) {
      yield* removeLogged(storeName(input.ref));
      return yield* new SecretRequestError({ reason: "ref_expired" });
    }
    return decoded.value;
  });

  const consumeRef = Effect.fn("SecretRequests.consumeRef")(function* (input: {
    readonly ref: SecretRef;
    readonly projectId: ProjectId;
  }) {
    const { value } = yield* readRef(input);
    // One use: the value moves into whatever consumed it. If it cannot be
    // deleted, it is not handed out, so a ref is never used twice.
    if (!(yield* removeLogged(storeName(input.ref)))) {
      return yield* new SecretRequestError({ reason: "consume_failed" });
    }
    return value;
  });

  const consumeForFill: SecretRequests["Service"]["consumeForFill"] = Effect.fn(
    "SecretRequests.consumeForFill",
  )(
    function* (input) {
      const { entryId } = yield* readRef(input);
      if (entryId === undefined) return undefined;
      if (!(yield* removeLogged(storeName(input.ref)))) {
        return yield* new SecretRequestError({ reason: "consume_failed" });
      }
      return entryId;
    },
    consumeLock.withPermits(1),
    Effect.tap((entryId) =>
      entryId === undefined
        ? Effect.void
        : Metrics.increment(Metrics.secretRefsConsumedTotal, { result: "used" }),
    ),
    Effect.tapError(() =>
      Metrics.increment(Metrics.secretRefsConsumedTotal, { result: "rejected" }),
    ),
  );

  const saveToFile: SecretRequests["Service"]["saveToFile"] = Effect.fn(
    "SecretRequests.saveToFile",
  )(function* (input) {
    const records = yield* threadManagement
      .getThreadRecords(input.threadId, ["turnItems"], {
        turnItemTypes: ["secret_request"],
        messageRoles: [],
      })
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })));
    const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
    // Only a card that told the user the agent's commands can read the value may write it out.
    if (
      item?.type !== "secret_request" ||
      item.secretStatus !== "saved" ||
      item.delivery !== "file"
    ) {
      return yield* new SecretRequestError({ reason: "not_a_file_request" });
    }
    if (filesDir === undefined) return yield* new SecretRequestError({ reason: "store_failed" });
    const ref = refFor(salt, input.threadId, item.id);
    const file = path.join(filesDir, ref.slice(SECRET_REF_PREFIX.length));
    return yield* Effect.gen(function* () {
      // One use: the file counts as delivered only once the stored copy is gone. A retry with the
      // same clientRequestId gets the file the first call wrote and finishes that removal.
      const removeStored = removeLogged(storeName(ref)).pipe(
        Effect.flatMap((removed) =>
          removed ? Effect.succeed(file) : new SecretRequestError({ reason: "consume_failed" }),
        ),
      );
      if (yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false))) {
        return yield* removeStored;
      }
      // The stored value goes only after the file is complete, so a failed write can retry.
      const { value } = yield* readRef({ ref, projectId: records.thread.projectId });
      const partial = `${file}.partial`;
      yield* fileSystem.makeDirectory(filesDir, { recursive: true, mode: 0o700 }).pipe(
        Effect.andThen(fileSystem.chmod(filesDir, 0o700)),
        Effect.andThen(fileSystem.remove(partial, { force: true })),
        // `wx` never follows or replaces an existing path.
        Effect.andThen(
          fileSystem.writeFile(partial, new TextEncoder().encode(value), {
            flag: "wx",
            mode: 0o600,
          }),
        ),
        Effect.andThen(fileSystem.rename(partial, file)),
        Effect.mapError((cause) => new SecretRequestError({ reason: "store_failed", cause })),
      );
      return yield* removeStored;
    }).pipe(consumeLock.withPermits(1));
  });

  const sweepExpired = Effect.gen(function* () {
    if (store.directory === undefined) return;
    const now = yield* Clock.currentTimeMillis;
    const names = (yield* fileSystem.readDirectory(store.directory)).flatMap((file) => {
      const match = STORE_NAME_PATTERN.exec(file);
      return match?.[1] === undefined ? [] : [match[1]];
    });
    let removed = 0;
    for (const name of names) {
      const stored = yield* store.get(name).pipe(Effect.orElseSucceed(Option.none));
      const decoded = Option.flatMap(stored, (bytes) =>
        decodeStored(new TextDecoder().decode(bytes)),
      );
      if (Option.isSome(decoded) && now - decoded.value.savedAt <= SECRET_REF_TTL_MS) continue;
      if (yield* removeLogged(name)) removed += 1;
    }
    yield* Effect.annotateCurrentSpan({ "secret_request.expired_removed": removed });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not sweep expired secret refs", cause)),
    Effect.withSpan("SecretRequests.sweepExpired"),
  );
  const sweepExpiredFiles = Effect.gen(function* () {
    if (filesDir === undefined || !(yield* fileSystem.exists(filesDir))) return;
    const now = yield* Clock.currentTimeMillis;
    let removed = 0;
    for (const name of yield* fileSystem.readDirectory(filesDir)) {
      if (!FILE_NAME_PATTERN.test(name)) continue;
      const file = path.join(filesDir, name);
      const { mtime } = yield* fileSystem.stat(file);
      if (Option.exists(mtime, (time) => now - time.getTime() <= SECRET_REF_TTL_MS)) continue;
      yield* fileSystem.remove(file);
      removed += 1;
    }
    yield* Effect.annotateCurrentSpan({ "secret_request.expired_files_removed": removed });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not sweep expired secret files", cause)),
    Effect.withSpan("SecretRequests.sweepExpiredFiles"),
  );
  const sweep = Effect.andThen(sweepExpired, sweepExpiredFiles);
  yield* sweep;
  yield* sweep.pipe(
    Effect.delay("1 hour"),
    Effect.repeat(Schedule.spaced("1 hour")),
    Effect.forkScoped,
  );

  return SecretRequests.of({
    answer,
    answerVaultApproval,
    useVaultEntry,
    savedRef,
    consume,
    consumeForFill,
    saveToFile,
  });
});

export const layer = Layer.effect(SecretRequests, make);
