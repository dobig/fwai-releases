import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopFwaiAccount from "../../app/DesktopFwaiAccount.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const StringRecord = Schema.Record(Schema.String, Schema.String);

export const getFwaiAccountSession = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_FWAI_ACCOUNT_SESSION_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.fwaiAccountSession.get")(function* () {
    const store = yield* DesktopFwaiAccount.DesktopFwaiAccountStore;
    return Option.getOrNull(yield* store.get);
  }),
});

export const setFwaiAccountSession = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_FWAI_ACCOUNT_SESSION_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.fwaiAccountSession.set")(function* (session) {
    const store = yield* DesktopFwaiAccount.DesktopFwaiAccountStore;
    yield* store.set(session);
  }),
});

export const clearFwaiAccountSession = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CLEAR_FWAI_ACCOUNT_SESSION_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.fwaiAccountSession.clear")(function* () {
    const store = yield* DesktopFwaiAccount.DesktopFwaiAccountStore;
    yield* store.clear;
  }),
});

export const fwaiGatewayFetch = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FWAI_GATEWAY_FETCH_CHANNEL,
  payload: Schema.Struct({
    url: Schema.String,
    method: Schema.String,
    headers: StringRecord,
    body: Schema.NullOr(Schema.String),
  }),
  result: Schema.Struct({ status: Schema.Number, headers: StringRecord, body: Schema.String }),
  handler: (request) =>
    DesktopFwaiAccount.fetchFwaiGateway(request, DesktopFwaiAccount.fwaiGatewayOrigin),
});
