import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  VaultEntryId,
  type VaultCreateInput,
  type VaultScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as VaultService from "./VaultService.ts";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const projectC = ProjectId.make("project-c");
const VALUE = "hunter2-very-secret";

const layerConfig = () => ServerConfig.layerTest(process.cwd(), { prefix: "t3-vault-test-" });
// A fresh store and service over the configured directory, as after a server restart.
const layerVault = VaultService.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provide(NodeCrypto.layer),
);

const withVault = <A, E, R>(
  body: (vault: VaultService.VaultService["Service"]) => Effect.Effect<A, E, R>,
) => Effect.flatMap(VaultService.VaultService, body).pipe(Effect.provide(layerVault));

const entry = (overrides: Partial<VaultCreateInput> = {}): VaultCreateInput => ({
  name: "GitHub",
  kind: "password",
  username: "octocat",
  domains: ["github.com"],
  scope: "global",
  value: VALUE,
  ...overrides,
});

const failureReason = <A>(exit: Exit.Exit<A, { readonly reason: string }>) =>
  Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
    ? exit.cause.reasons[0].error.reason
    : undefined;

it.layer(NodeServices.layer)("VaultService", (it) => {
  it.effect("keeps entries across a restart", () =>
    Effect.gen(function* () {
      const created = yield* withVault((vault) => vault.create(entry()));
      const listed = yield* withVault((vault) => vault.list());
      assert.deepEqual(listed, { entries: [created], unreadable: 0 });
      assert.equal(yield* withVault((vault) => vault.readValue(created.id)), VALUE);
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("counts a corrupted entry as unreadable without breaking the list", () =>
    withVault((vault) =>
      Effect.gen(function* () {
        const store = yield* ServerSecretStore.ServerSecretStore;
        const kept = yield* vault.create(entry());
        yield* store.set("vault-entry-broken", new TextEncoder().encode("{not json"));
        yield* store.set(`vault-usage-${kept.id}`, new TextEncoder().encode("garbage"));
        const listed = yield* vault.list();
        assert.equal(listed.unreadable, 1);
        assert.deepEqual(
          listed.entries.map((summary) => summary.id),
          [kept.id],
        );
        assert.isUndefined(listed.entries[0]?.lastUse);
        assert.equal(
          failureReason(yield* Effect.exit(vault.get(VaultEntryId.make("broken")))),
          "store_failed",
        );
        yield* vault.delete(VaultEntryId.make("broken"));
        assert.equal((yield* vault.list()).unreadable, 0);
      }),
    ).pipe(Effect.provide(layerConfig())),
  );

  it.effect("refuses a name another entry visible to the same project has", () =>
    withVault((vault) =>
      Effect.gen(function* () {
        const scoped = (projects: ReadonlyArray<ProjectId>): VaultScope => ({ projects });
        const inA = yield* vault.create(entry({ name: "Deploy", scope: scoped([projectA]) }));
        const inB = yield* vault.create(entry({ name: "Deploy", scope: scoped([projectB]) }));
        const taken = (input: VaultCreateInput) =>
          Effect.exit(vault.create(input)).pipe(Effect.map(failureReason));
        assert.equal(yield* taken(entry({ name: "Deploy" })), "name_taken", "global sees both");
        assert.equal(
          yield* taken(entry({ name: "Deploy", scope: scoped([projectA, projectC]) })),
          "name_taken",
        );
        assert.equal(
          failureReason(
            yield* Effect.exit(vault.allowProject({ id: inB.id, projectId: projectA })),
          ),
          "name_taken",
        );
        assert.equal(
          failureReason(yield* Effect.exit(vault.update({ id: inB.id, scope: "global" }))),
          "name_taken",
        );
        const other = yield* vault.create(entry({ name: "Other", scope: scoped([projectA]) }));
        assert.equal(
          failureReason(yield* Effect.exit(vault.update({ id: other.id, name: "Deploy" }))),
          "name_taken",
        );
        // Renaming an entry to its own name is not a collision.
        yield* vault.update({ id: inA.id, name: "Deploy" });
        assert.isFalse((yield* vault.list()).entries.some((summary) => summary.nameConflict));
      }),
    ).pipe(Effect.provide(layerConfig())),
  );

  it.effect("keeps the value when an update omits it and bumps version, not on use", () =>
    withVault((vault) =>
      Effect.gen(function* () {
        const created = yield* vault.create(entry());
        assert.equal(created.version, 1);
        const renamed = yield* vault.update({
          id: created.id,
          name: "GitHub work",
          username: null,
        });
        assert.equal(renamed.version, 2);
        assert.equal(renamed.name, "GitHub work");
        assert.isUndefined(renamed.username);
        assert.equal(yield* vault.readValue(created.id), VALUE);

        yield* vault.update({ id: created.id, value: "rotated" });
        assert.equal(yield* vault.readValue(created.id), "rotated");

        const usage = {
          at: "2026-11-24T10:00:00.000Z",
          threadId: ThreadId.make("thread-1"),
          delivery: "secretRef" as const,
        };
        yield* vault.recordUse(created.id, usage);
        const used = yield* vault.get(created.id);
        assert.equal(used.version, 3);
        assert.deepEqual(used.lastUse, usage);
      }),
    ).pipe(Effect.provide(layerConfig())),
  );

  it.effect("finds entries by name and scope from a project", () =>
    withVault((vault) =>
      Effect.gen(function* () {
        const global = yield* vault.create(entry({ name: "Shared" }));
        const onlyA = yield* vault.create(
          entry({ name: "A only", scope: { projects: [projectA] } }),
        );
        assert.deepEqual(
          (yield* vault.entriesForProject(projectB)).map((summary) => summary.id),
          [global.id],
        );
        assert.equal((yield* vault.findByName({ projectId: projectA, name: "A only" })).type, "ok");
        assert.equal(
          (yield* vault.findByName({ projectId: projectB, name: "A only" })).type,
          "out_of_scope",
        );
        assert.equal(
          (yield* vault.findByName({ projectId: projectB, name: "missing" })).type,
          "not_found",
        );

        const allowed = yield* vault.allowProject({ id: onlyA.id, projectId: projectB });
        assert.deepEqual(allowed.scope, { projects: [projectA, projectB] });
        assert.equal(allowed.version, 2);
        assert.equal((yield* vault.findByName({ projectId: projectB, name: "A only" })).type, "ok");
        const unchanged = yield* vault.allowProject({ id: global.id, projectId: projectB });
        assert.equal(unchanged.version, 1);
      }),
    ).pipe(Effect.provide(layerConfig())),
  );

  it.effect("reports a synced duplicate name as ambiguous and marks both", () =>
    withVault((vault) =>
      Effect.gen(function* () {
        const store = yield* ServerSecretStore.ServerSecretStore;
        const first = yield* vault.create(entry({ name: "Twin" }));
        // Sync can bring in a second entry with a taken name; nothing local can.
        yield* store.set(
          "vault-entry-synced-twin",
          new TextEncoder().encode(JSON.stringify({ ...first, id: "synced-twin", value: "x" })),
        );
        const lookup = yield* vault.findByName({ projectId: projectA, name: "Twin" });
        assert.equal(lookup.type, "ambiguous_name");
        const listed = yield* vault.list();
        assert.deepEqual(
          listed.entries.map((summary) => summary.nameConflict),
          [true, true],
        );
      }),
    ).pipe(Effect.provide(layerConfig())),
  );

  it.effect("applies a remote version only over the local entry it was decided against", () =>
    withVault((vault) =>
      Effect.gen(function* () {
        const created = yield* vault.create(entry());
        const remote = (value: string) => ({
          ...VaultService.entryContent({ ...created, value }),
          updatedAt: "2030-01-01T00:00:00.000Z",
        });
        const edited = yield* vault.update({ id: created.id, value: "edited-meanwhile" });
        assert.isFalse(
          yield* vault.applyRemote(created.id, remote("remote"), {
            keepPrevious: false,
            expectedVersion: created.version,
          }),
        );
        assert.isFalse(
          yield* vault.applyRemoteDelete(created.id, {
            keepPrevious: false,
            expectedVersion: created.version,
          }),
        );
        assert.equal(yield* vault.readValue(created.id), "edited-meanwhile");

        const narrowed = yield* vault.update({ id: created.id, scope: { projects: [projectA] } });
        assert.isFalse(
          yield* vault.applyRemote(created.id, remote("remote"), {
            keepPrevious: false,
            expectedVersion: narrowed.version,
          }),
        );
        assert.deepEqual((yield* vault.get(created.id)).scope, { projects: [projectA] });

        const widened = yield* vault.update({ id: created.id, scope: "global" });
        assert.isTrue(edited.version < widened.version);
        assert.isTrue(
          yield* vault.applyRemote(created.id, remote("remote"), {
            keepPrevious: false,
            expectedVersion: widened.version,
          }),
        );
        assert.equal(yield* vault.readValue(created.id), "remote");
        assert.isFalse(
          yield* vault.applyRemote(created.id, remote("again"), {
            keepPrevious: false,
            expectedVersion: null,
          }),
        );
      }),
    ).pipe(Effect.provide(layerConfig())),
  );

  it.effect("checks the origin against the entry's domains", () =>
    withVault((vault) =>
      Effect.gen(function* () {
        const bound = yield* vault.create(entry());
        const unbound = yield* vault.create(entry({ name: "Token", kind: "token", domains: [] }));
        assert.isTrue(
          yield* vault.originAllowed({ id: bound.id, url: "https://gist.github.com/new" }),
        );
        assert.isFalse(yield* vault.originAllowed({ id: bound.id, url: "http://github.com" }));
        assert.isFalse(yield* vault.originAllowed({ id: unbound.id, url: "https://github.com" }));
      }),
    ).pipe(Effect.provide(layerConfig())),
  );

  it.effect("treats ids that are not file-safe as missing", () =>
    withVault((vault) =>
      Effect.gen(function* () {
        for (const id of ["../session-signing-key", "a/b", "x.y"]) {
          const exit = yield* Effect.exit(vault.readValue(VaultEntryId.make(id)));
          assert.equal(failureReason(exit), "not_found");
          assert.equal(
            failureReason(yield* Effect.exit(vault.delete(VaultEntryId.make(id)))),
            "not_found",
          );
        }
      }),
    ).pipe(Effect.provide(layerConfig())),
  );

  it.effect("never puts a value in a result or a span", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const results = yield* withVault((vault) =>
        Effect.gen(function* () {
          const created = yield* vault.create(entry());
          const updated = yield* vault.update({ id: created.id, value: `${VALUE}-2` });
          return [
            created,
            updated,
            yield* vault.get(created.id),
            yield* vault.list(),
            yield* vault.entriesForProject(projectA),
            yield* vault.findByName({ projectId: projectA, name: "GitHub" }),
          ];
        }),
      ).pipe(Effect.withTracer(tracer));
      assert.notInclude(JSON.stringify(results), VALUE);
      assert.notInclude(JSON.stringify(results), '"value"');
      const recorded = spans.flatMap((span) => [
        span.name,
        ...Array.from(span.attributes.values(), String),
      ]);
      assert.include(recorded, "VaultService.create");
      assert.isFalse(recorded.some((value) => value.includes(VALUE)));
    }).pipe(Effect.provide(layerConfig())),
  );
});
