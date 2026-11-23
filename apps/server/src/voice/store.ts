// @effect-diagnostics nodeBuiltinImport:off globalDate:off - plain-TS voice core, tested without an Effect runtime.
/**
 * The voice assistant's own small database beside the server state: what was heard and
 * said (so pages and the app show it again after a reload or on another device), and
 * the brain's state (current session, inbox, modes) across restarts.
 */
import * as NodeSqlite from "node:sqlite";

import type { HistoryEvent, VoiceHistory } from "@t3tools/shared/voice/hub";
import type { VoiceState, VoiceStateStore } from "@t3tools/shared/voice/sessions";

export class VoiceStore implements VoiceStateStore, VoiceHistory {
  private readonly db: NodeSqlite.DatabaseSync;

  constructor(path: string) {
    this.db = new NodeSqlite.DatabaseSync(path);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at REAL NOT NULL, kind TEXT NOT NULL," +
        " text TEXT NOT NULL, session TEXT);" +
        "CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);",
    );
  }

  add(
    kind: HistoryEvent["kind"],
    text: string,
    session: string | null = null,
    at = Date.now() / 1000,
  ): HistoryEvent {
    this.db
      .prepare("INSERT INTO events (at, kind, text, session) VALUES (?, ?, ?, ?)")
      .run(at, kind, text, session);
    return { at, kind, text, session };
  }

  /** The newest `limit` events, oldest first. */
  recent(limit = 100): Array<HistoryEvent> {
    const rows = this.db
      .prepare("SELECT at, kind, text, session FROM events ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as Array<HistoryEvent>;
    return rows.reverse().map(({ at, kind, text, session }) => ({ at, kind, text, session }));
  }

  load(): VoiceState {
    const row = this.db.prepare("SELECT json FROM state WHERE id = 1").get() as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as VoiceState) : {};
  }

  save(state: VoiceState): void {
    this.db
      .prepare(
        "INSERT INTO state (id, json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json",
      )
      .run(JSON.stringify(state));
  }

  close(): void {
    this.db.close();
  }
}
