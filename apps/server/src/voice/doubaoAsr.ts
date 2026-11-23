// @effect-diagnostics nodeBuiltinImport:off - plain-TS voice core, tested without an Effect runtime.
/** Doubao ASR on the server, over the `ws` package. */
import * as NodeCrypto from "node:crypto";

import { makeTranscribe, type Transcribe } from "@t3tools/shared/voice/asr";
import WebSocket from "ws";

export const transcribe: Transcribe = makeTranscribe({
  randomId: () => NodeCrypto.randomUUID(),
  open: (url, headers, handlers) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers, maxPayload: 0 });
      let logid: string | undefined;
      ws.once("upgrade", (response) => {
        const value = response.headers["x-tt-logid"];
        logid = Array.isArray(value) ? value[0] : value;
      });
      ws.once("error", reject);
      ws.once("open", () => {
        ws.off("error", reject);
        ws.on("message", (data, isBinary) => {
          if (isBinary) handlers.message(new Uint8Array(data as Buffer));
        });
        ws.once("close", (code, reason) => handlers.close(code, reason.toString("utf8")));
        ws.on("error", handlers.error);
        resolve({ send: (frame) => ws.send(frame), close: () => ws.close(), logid });
      });
    }),
});
