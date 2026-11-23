// @effect-diagnostics nodeBuiltinImport:off - Lean self-invoked local IPC client; no auth/store graph.
import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Protocol from "../provider/CodexManagedTokenProtocol.ts";

const decodeArguments = Schema.decodeUnknownEffect(
  Schema.Tuple([Schema.NonEmptyString, Protocol.GatewayRequest.fields.environmentId]),
);
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(Protocol.GatewayRequest));
const decodeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(Protocol.Response), {
  onExcessProperty: "error",
});

/** Claude's apiKeyHelper and Codex's auth.command both read a bare token from stdout. */
export async function runFwaiGatewayTokenCli(args: ReadonlyArray<string>): Promise<void> {
  const program = Effect.gen(function* () {
    const [endpoint, environmentId] = yield* decodeArguments(args);
    const socket = yield* Effect.acquireRelease(
      Effect.sync(() => NodeNet.createConnection(endpoint)),
      (socket) => Effect.sync(() => socket.destroy()),
    );
    socket.on("error", () => {});
    socket.once("connect", () =>
      socket.write(encodeRequest({ version: 1, kind: "fwai-gateway", environmentId }) + "\n"),
    );
    return yield* Protocol.readFrame(
      socket,
      Protocol.RESPONSE_BYTES,
      Protocol.COMMAND_TIMEOUT_MS,
    ).pipe(Effect.flatMap(decodeResponse));
  }).pipe(Effect.scoped);
  const result = await Effect.runPromiseExit(program);
  if (Exit.isFailure(result)) {
    process.stderr.write(
      "fwai Gateway is not connected. Connect it in fwai Settings → Providers.\n",
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(result.value.token);
}
