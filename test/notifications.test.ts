import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deliverOutbox, FileNotificationSink } from "../src/notifications.js";
import { SqliteStore } from "../src/store.js";

const directories: string[] = [];
function fixture() { const directory = mkdtempSync(join(tmpdir(), "notifications-")); directories.push(directory); return directory; }
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("outbox notification delivery", () => {
  it("delivers pending records to a local file", () => {
    const directory = fixture();
    const store = new SqliteStore(join(directory, "state.sqlite"));
    store.createRun("run-1", "task-1");
    store.transitionRun("run-1", "ready", {}, { commit: "abc" });
    expect(deliverOutbox(store, new FileNotificationSink(join(directory, "notifications.log")))).toEqual({ delivered: 1, failed: 0 });
    expect(readFileSync(join(directory, "notifications.log"), "utf8")).toContain('"type":"ready"');
    expect(store.listPendingOutbox()).toHaveLength(0);
    store.close();
  });

  it("does not alter the development result when delivery fails", () => {
    const directory = fixture();
    const store = new SqliteStore(join(directory, "state.sqlite"));
    store.createRun("run-1", "task-1");
    store.transitionRun("run-1", "ready");
    expect(deliverOutbox(store, { deliver() { throw new Error("disk unavailable"); } })).toEqual({ delivered: 0, failed: 1 });
    expect(store.getRun("run-1")?.status).toBe("ready");
    expect(store.listPendingOutbox()[0]).toMatchObject({ attempts: 1, lastError: "disk unavailable" });
    store.close();
  });
});
