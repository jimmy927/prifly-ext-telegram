/**
 * The only file that imports TDLib's binding. `tdl` talks to the `tdjson`
 * library that `prebuilt-tdlib` ships for Windows, macOS and Linux; both are
 * loaded here, on first use, never at import time, so a machine where they
 * cannot load still gets the extension's own messages. Neither needs an
 * install script: `tdl` carries its native addon prebuilt and `prebuilt-tdlib`
 * brings tdjson as an optional per-platform package.
 */

import type { TdClient, TdFactory, TdObject, TdOptions } from "./types";

/** The part of a `tdl` client this file uses. */
type TdlClient = {
  invoke(request: TdObject): Promise<TdObject>;
  on(event: "update", handler: (update: TdObject) => void): unknown;
  on(event: "error", handler: (error: Error) => void): unknown;
  close(): Promise<void>;
};

type TdlModule = {
  configure(options: { tdjson: string }): void;
  createClient(options: {
    apiId: number;
    apiHash: string;
    databaseDirectory: string;
    filesDirectory: string;
    tdlibParameters: Record<string, unknown>;
  }): TdlClient;
};

let configured = false;

async function loadTdl(): Promise<TdlModule> {
  const tdl = (await import("tdl")) as unknown as TdlModule;
  if (!configured) {
    const { getTdjson } = (await import("prebuilt-tdlib")) as { getTdjson: () => string };
    // configure() may be called once per process.
    tdl.configure({ tdjson: getTdjson() });
    configured = true;
  }
  return tdl;
}

/** The real factory: a `tdl` client over the bundled tdjson. */
export const realFactory: TdFactory = async (options: TdOptions): Promise<TdClient> => {
  const tdl = await loadTdl();
  const client = tdl.createClient({
    ...options,
    tdlibParameters: {
      use_message_database: true,
      use_secret_chats: false,
      use_file_database: true,
      use_chat_info_database: true,
      system_language_code: "en",
      application_version: "1.0",
      device_model: "prifly",
      system_version: process.platform,
    },
  });
  return {
    invoke: (request) => client.invoke(request),
    onUpdate: (handler) => void client.on("update", handler),
    onError: (handler) => void client.on("error", handler),
    close: () => client.close(),
  };
};
