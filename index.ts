/**
 * Telegram, in prifly: the reader's own Telegram account through TDLib (the
 * official client library), running inside prifly's host process.
 *
 * A toolbox for sessions, with no boards, chips or launchers: sessions list
 * chats, read a chat, see what is new, save media and send (each send
 * confirmed by the reader on a card). The reader registers their own
 * api_id at my.telegram.org. The one thing it shows is its status line in
 * Settings -> Extensions.
 */

import type { ExtensionApi } from "@prifly/extension-api";
import { realFactory } from "./client";
import { linkTool, refreshStatus } from "./link-tool";
import { mediaTool } from "./media";
import { chatsTool, chatTool, newTool } from "./read";
import { sendTool } from "./send";
import { Telegram } from "./telegram";
import type { TdFactory } from "./types";

/** What a test injects: a fake TDLib client factory. The host passes only `api`. */
export type Injected = { factory?: TdFactory; timeoutMs?: number; sendWaitMs?: number };

export async function activate(api: ExtensionApi, injected: Injected = {}): Promise<() => void> {
  const features = api.features ?? [];
  if (!features.includes("secrets") || api.secrets === undefined) {
    api.status?.("Telegram needs a newer prifly: this one lacks the secret store");
    return () => undefined;
  }
  const tg = new Telegram(
    api,
    injected.factory ?? realFactory,
    injected.timeoutMs,
    injected.sendWaitMs,
  );
  api.tools?.register([
    chatsTool(tg),
    chatTool(tg),
    newTool(tg),
    mediaTool(tg),
    sendTool(tg),
    linkTool(tg),
  ]);
  api.log("activated", { tools: 6 });
  await refreshStatus(tg).catch((caught) => api.log("status_failed", { message: String(caught) }));
  return () => {
    void tg.stop();
  };
}
