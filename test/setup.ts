/** The extension activated over the fake `api` and a fake TDLib client. */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfirmSpec, DialogSpec } from "@prifly/extension-api";
import { activate } from "../index";
import { type FakeApi, fakeApi } from "./fake-api";
import { FakeTd, type FakeTdOptions } from "./fake-td";

export type SetupOptions = {
  td?: FakeTdOptions;
  /** The answer to a plain confirm card. */
  confirm?: boolean;
  /** Offer `confirmEdit`: what it answers (the text itself for "same", null for Cancel). */
  edit?: string | null | "same";
  /** What the reader types into each dialog, in order; null closes it. */
  answers?: (string | null)[];
  /** Already signed in, with keys saved. */
  signedIn?: boolean;
  /** Keys saved, not signed in. */
  keys?: boolean;
  timeoutMs?: number;
};

export type Setup = {
  fake: FakeApi;
  td: FakeTd;
  secrets: Map<string, string>;
  dialogs: DialogSpec[];
  edits: (ConfirmSpec & { content: string })[];
  answers: (string | null)[];
  call: (name: string, args?: Record<string, unknown>) => Promise<string>;
  stop: () => void;
};

export async function setup(options: SetupOptions = {}): Promise<Setup> {
  const td = new FakeTd(options.td);
  const fake = fakeApi({
    folder: mkdtempSync(join(tmpdir(), "fake-ext-")),
    confirm: options.confirm ?? true,
  });
  const secrets = new Map<string, string>();
  const dialogs: DialogSpec[] = [];
  const edits: Setup["edits"] = [];
  const answers = [...(options.answers ?? [])];
  const extra: Record<string, unknown> = {
    features: [...(fake.api.features ?? []), "secrets", "confirm-edit"],
    secrets: {
      get: async (key: string) => secrets.get(key) ?? null,
      set: async (key: string, value: string | null) =>
        void (value === null ? secrets.delete(key) : secrets.set(key, value)),
      keys: async () => [...secrets.keys()],
    },
    dialog: async (spec: DialogSpec) => {
      dialogs.push(spec);
      return answers.shift() ?? null;
    },
  };
  if (options.edit !== undefined) {
    const edit = options.edit;
    extra["confirmEdit"] = async (spec: ConfirmSpec & { content: string }) => {
      edits.push(spec);
      return edit === "same" ? spec.content : edit;
    };
  }
  Object.assign(fake.api, extra);
  if (options.signedIn || options.keys) {
    secrets.set("api_id", "1234567");
    secrets.set("api_hash", "0123456789abcdef0123456789abcdef");
  }
  if (options.signedIn) {
    td.state = "authorizationStateReady";
    fake.documents.set("account", { id: 7, name: "Ada Lovelace" });
  }
  const stop = await activate(fake.api, {
    factory: td.factory(),
    timeoutMs: options.timeoutMs ?? 2000,
    sendWaitMs: 30,
  });
  return {
    fake,
    td,
    secrets,
    dialogs,
    edits,
    answers,
    call: (name, args = {}) => fake.callTool(name, args),
    stop,
  };
}
