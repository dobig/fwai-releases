import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { makeFakeFwaiGateway } from "@t3tools/shared/testing/fwaiGatewayFake";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopFwaiAccount from "./DesktopFwaiAccount.ts";

const gateway = "https://api.fwai.space";
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

describe("allowedFwaiGatewayUrl", () => {
  const allowed = (url: string, method = "POST") =>
    Option.isSome(DesktopFwaiAccount.allowedFwaiGatewayUrl({ url, method }, gateway));

  it("allows only account endpoints on the configured gateway", () => {
    assert.isTrue(allowed(`${gateway}/v1/auth/login`));
    assert.isTrue(allowed(`${gateway}/v1/auth/login/verify`));
    assert.isTrue(allowed(`${gateway}/oauth/token`));
    assert.isTrue(allowed(`${gateway}/v1/account/logout`));
    assert.isTrue(allowed(`${gateway}/v1/auth/introspect`, "GET"));

    assert.isFalse(allowed(`${gateway}/v1/chat/completions`));
    assert.isFalse(allowed(`${gateway}/oauth/device/code`));
    assert.isFalse(allowed(`${gateway}/v1/auth/login/../../admin`));
    assert.isFalse(allowed(`${gateway}/oauth/token?redirect=1`));
    assert.isFalse(allowed("https://evil.example/v1/auth/login"));
    assert.isFalse(allowed("https://api.fwai.space.evil.example/v1/auth/login"));
    assert.isFalse(allowed("http://api.fwai.space/v1/auth/login"));
    assert.isFalse(allowed("https://user:pass@api.fwai.space/v1/auth/login"));
    assert.isFalse(allowed(`${gateway}/oauth/token`, "DELETE"));
    assert.isFalse(allowed("not a url"));
  });

  it("allows the organization directory read-only, with a query only on members", () => {
    assert.isTrue(allowed(`${gateway}/v1/me/organization`, "GET"));
    assert.isTrue(allowed(`${gateway}/v1/me/organization/members?q=bob&limit=20`, "GET"));
    assert.isTrue(allowed(`${gateway}/v1/me/organization/members`, "GET"));

    assert.isFalse(allowed(`${gateway}/v1/me/organization`, "POST"));
    assert.isFalse(allowed(`${gateway}/v1/me/organization?x=1`, "GET"));
    assert.isFalse(allowed(`${gateway}/v1/me/organization/members`, "POST"));
    assert.isFalse(allowed(`${gateway}/v1/me/organization/project`, "PUT"));
  });
});

describe("fetchFwaiGateway", () => {
  it.effect("forwards allowed requests and returns the response", () => {
    const fake = makeFakeFwaiGateway(() => ({ status: 200, body: { access_token: "a" } }));
    return Effect.gen(function* () {
      const response = yield* DesktopFwaiAccount.fetchFwaiGateway(
        {
          url: `${gateway}/oauth/token`,
          method: "post",
          headers: { "Content-Type": "application/json", Authorization: "Bearer t", Cookie: "c" },
          body: '{"grant_type":"refresh_token"}',
        },
        gateway,
      );
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(JSON.parse(response.body), { access_token: "a" });
      assert.deepStrictEqual(fake.requests, [
        {
          method: "POST",
          path: "/oauth/token",
          authorization: "Bearer t",
          body: { grant_type: "refresh_token" },
        },
      ]);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("rejects other origins and paths without sending them", () => {
    const fake = makeFakeFwaiGateway(() => ({ status: 200 }));
    return Effect.gen(function* () {
      const error = yield* DesktopFwaiAccount.fetchFwaiGateway(
        { url: "https://evil.example/v1/auth/login", method: "POST", headers: {}, body: null },
        gateway,
      ).pipe(Effect.flip);
      assert.strictEqual(error.reason, "not-allowed");
      assert.lengthOf(fake.requests, 0);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("reports an unreachable gateway without its request", () => {
    const fake = makeFakeFwaiGateway(() => "transport-error");
    return Effect.gen(function* () {
      const error = yield* DesktopFwaiAccount.fetchFwaiGateway(
        { url: `${gateway}/v1/auth/introspect`, method: "GET", headers: {}, body: null },
        gateway,
      ).pipe(Effect.flip);
      assert.deepStrictEqual(
        error,
        new DesktopFwaiAccount.DesktopFwaiGatewayFetchError({ reason: "unreachable" }),
      );
    }).pipe(Effect.provide(fake.layer));
  });
});

const layerStore = (baseDir: string, encryptionAvailable: boolean) =>
  DesktopFwaiAccount.layer.pipe(
    Layer.provideMerge(
      DesktopEnvironment.layer({
        dirname: "/repo/apps/desktop/src",
        homeDirectory: baseDir,
        platform: "darwin",
        processArch: "arm64",
        appVersion: "1.2.3",
        appPath: "/repo",
        isPackaged: true,
        resourcesPath: "/missing/resources",
        runningUnderArm64Translation: false,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
        isEncryptionAvailable: Effect.succeed(encryptionAvailable),
        encryptString: (value) => Effect.succeed(textEncoder.encode(`encrypted:${value}`)),
        decryptString: (value) => Effect.succeed(textDecoder.decode(value).slice(10)),
        selectedStorageBackend: Effect.succeedNone,
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const withStore = <A, E>(
  encryptionAvailable: boolean,
  body: (
    store: DesktopFwaiAccount.DesktopFwaiAccountStore["Service"],
    stateDir: string,
  ) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-fwai-account-test-" });
    return yield* Effect.gen(function* () {
      const store = yield* DesktopFwaiAccount.DesktopFwaiAccountStore;
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      return yield* body(store, environment.stateDir);
    }).pipe(Effect.provide(layerStore(baseDir, encryptionAvailable)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopFwaiAccountStore", () => {
  it.effect("keeps the session encrypted on disk and clears it", () =>
    withStore(true, (store, stateDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* store.set('{"refreshToken":"secret-refresh"}');

        assert.deepStrictEqual(yield* store.get, Option.some('{"refreshToken":"secret-refresh"}'));
        const onDisk = yield* fileSystem.readFileString(`${stateDir}/fwai-account-session.json`);
        assert.notInclude(onDisk, "secret-refresh");

        yield* store.clear;
        assert.deepStrictEqual(yield* store.get, Option.none());
      }),
    ),
  );

  it.effect("does not write the session when secure storage is unavailable", () =>
    withStore(false, (store, stateDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* store.set('{"refreshToken":"secret-refresh"}');

        assert.deepStrictEqual(yield* store.get, Option.none());
        assert.isFalse(yield* fileSystem.exists(`${stateDir}/fwai-account-session.json`));
      }),
    ),
  );

  it.effect("treats an unreadable session file as signed out", () =>
    withStore(true, (store, stateDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(stateDir, { recursive: true });
        yield* fileSystem.writeFileString(`${stateDir}/fwai-account-session.json`, "not json");

        assert.deepStrictEqual(yield* store.get, Option.none());
      }),
    ),
  );
});
