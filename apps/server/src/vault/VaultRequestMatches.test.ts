import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId, TurnItemId, type VaultCreateInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as VaultRequestMatches from "./VaultRequestMatches.ts";
import * as VaultService from "./VaultService.ts";

const threadId = ThreadId.make("thread-1");
const turnItemId = TurnItemId.make("turn-item:secret-request:1");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");

const entry = (overrides: Partial<VaultCreateInput>): VaultCreateInput => ({
  name: "Entry",
  kind: "password",
  domains: [],
  scope: "global",
  value: "v",
  ...overrides,
});

const run = (request: {
  readonly label: string;
  readonly reason?: string;
  readonly previewUrls?: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<VaultCreateInput>;
}) =>
  Effect.gen(function* () {
    const vault = yield* VaultService.VaultService;
    const created = yield* Effect.forEach(request.entries, (input) => vault.create(input));
    const result = yield* VaultRequestMatches.matchesForRequest({ threadId, turnItemId });
    const nameOf = new Map(created.map((summary) => [summary.id, summary.name]));
    return {
      ...result,
      matched: result.matches.map(
        (match) => `${nameOf.get(match.entry.id)}:${match.matchedBy}:${match.inScope}`,
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        VaultService.layer.pipe(
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-vault-match-" })),
          Layer.provide(NodeCrypto.layer),
        ),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: { projectId: projectA },
              turnItems: [
                {
                  id: turnItemId,
                  type: "secret_request",
                  label: request.label,
                  reason: request.reason ?? "",
                  secretStatus: "pending",
                },
              ],
            } as never),
        }),
        Layer.mock(PreviewManager.PreviewManager)({
          list: () =>
            Effect.succeed({
              serverEpoch: "epoch",
              revision: 0,
              sessions: (request.previewUrls ?? []).map((url) => ({
                navStatus: { _tag: "Success", url, title: "" },
              })),
            } as never),
        }),
      ),
    ),
  );

it.layer(NodeServices.layer)("VaultRequestMatches.matchesForRequest", (it) => {
  it.effect("matches by the preview tab's domain and suggests it", () =>
    Effect.gen(function* () {
      const result = yield* run({
        label: "Login password",
        previewUrls: ["https://login.github.com/session"],
        entries: [
          entry({ name: "GitHub", domains: ["github.com"] }),
          entry({ name: "Bob pages", domains: ["bob.github.io"] }),
        ],
      });
      assert.deepEqual(result.matched, ["GitHub:domain:true"]);
      assert.deepEqual(result.suggestedDomains, ["login.github.com"]);
      assert.equal(result.suggestedName, "Login password");
    }),
  );

  it.effect("matches domains named in the request text", () =>
    Effect.gen(function* () {
      const result = yield* run({
        label: "Staging admin",
        reason: "Sign in at https://admin.example.co.uk to finish setup. See README.md.",
        entries: [
          entry({ name: "Example", domains: ["example.co.uk"] }),
          entry({ name: "Other UK", domains: ["other.co.uk"] }),
        ],
      });
      assert.deepEqual(result.matched, ["Example:domain:true"]);
      assert.deepEqual(result.suggestedDomains, ["admin.example.co.uk"]);
    }),
  );

  it.effect("matches similar names, ignoring case, separators and generic words", () =>
    Effect.gen(function* () {
      const result = yield* run({
        label: "GitHub token",
        entries: [
          entry({ name: "GITHUB_TOKEN", kind: "token" }),
          entry({ name: "GitLab token", kind: "token" }),
          entry({ name: "github deploy key", kind: "token" }),
        ],
      });
      assert.sameMembers(result.matched, ["GITHUB_TOKEN:name:true", "github deploy key:name:true"]);
      assert.deepEqual(result.suggestedDomains, []);
    }),
  );

  it.effect("lists other projects' entries after in-scope ones", () =>
    Effect.gen(function* () {
      const result = yield* run({
        label: "Stripe key",
        entries: [
          entry({ name: "Stripe live", scope: { projects: [projectB] } }),
          entry({ name: "Stripe test", scope: { projects: [projectA] } }),
        ],
      });
      assert.deepEqual(result.matched, ["Stripe test:name:true", "Stripe live:name:false"]);
    }),
  );

  it.effect("fails with not_found for a turn item that is not a secret request", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        VaultRequestMatches.matchesForRequest({
          threadId,
          turnItemId: TurnItemId.make("turn-item:other"),
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(VaultService.VaultService)({}),
              Layer.mock(PreviewManager.PreviewManager)({}),
              Layer.mock(ThreadManagementService.ThreadManagementService)({
                getThreadRecords: () =>
                  Effect.succeed({ thread: { projectId: projectA }, turnItems: [] } as never),
              }),
            ),
          ),
        ),
      );
      assert.isTrue(
        Exit.isFailure(exit) &&
          exit.cause.reasons[0]?._tag === "Fail" &&
          exit.cause.reasons[0].error.reason === "not_found",
      );
    }),
  );
});
