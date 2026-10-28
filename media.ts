/** `telegram_media`: one message's file, downloaded and copied to the session's folder. */

import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionTool, ExtensionToolContext } from "@prifly/extension-api";
import { fileOf } from "./format";
import { chatIdOf } from "./read";
import type { Telegram } from "./telegram";
import type { TdFile, TdMessage } from "./types";

/** The largest file saved: this is for pictures and documents, not for mirroring a channel. */
export const MEDIA_LIMIT = 100_000_000;
/** A download may take a while; the request waits this long. */
const DOWNLOAD_WAIT_MS = 10 * 60_000;

const safeName = (name: string): string => name.replace(/[^\w.\- ]/g, "_").slice(0, 100) || "file";

/** Where files for the calling session go: its scratchpad, else the extension's data folder. */
function folderFor(tg: Telegram, ctx: ExtensionToolContext, chatId: number): string {
  try {
    return join(ctx.scratchpad, "telegram", String(chatId));
  } catch {
    return tg.dataFolder("media", String(chatId));
  }
}

export function mediaTool(tg: Telegram): ExtensionTool {
  return {
    name: "telegram_media",
    description:
      "Saves the picture, video, audio or document of one Telegram message to disk (the session's scratchpad) and returns its path: open a picture with Read. `message_id` is the #id at the end of a line of telegram_chat or telegram_new.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "The chat id from telegram_chats" },
        message_id: { type: "number", description: "The message id (#id)" },
      },
      required: ["chat_id", "message_id"],
      additionalProperties: false,
    },
    call: async (args, ctx) => {
      await tg.requireReady();
      const chatId = chatIdOf(args["chat_id"]);
      const messageId = chatIdOf(args["message_id"], "message_id");
      const message = await tg.invoke<TdMessage>({
        _: "getMessage",
        chat_id: chatId,
        message_id: messageId,
      });
      const found = fileOf(message.content);
      if (found === null) throw new Error(`Message #${messageId} carries no picture or file.`);
      const size = found.file.size || found.file.expected_size || 0;
      if (size > MEDIA_LIMIT) {
        throw new Error(`The ${found.kind} of message #${messageId} is over 100 MB: not saved.`);
      }
      const done = await tg.invoke<TdFile>(
        {
          _: "downloadFile",
          file_id: found.file.id,
          priority: 16,
          offset: 0,
          limit: 0,
          synchronous: true,
        },
        DOWNLOAD_WAIT_MS,
      );
      const from = done.local?.path;
      if (!from || done.local?.is_downloading_completed === false) {
        throw new Error(
          `Telegram did not finish downloading the ${found.kind} of message #${messageId}.`,
        );
      }
      const folder = folderFor(tg, ctx, chatId);
      mkdirSync(folder, { recursive: true });
      const target = join(folder, `${messageId}-${safeName(found.name)}`);
      copyFileSync(from, target);
      return `Saved the ${found.kind} of message #${messageId} to ${target}`;
    },
  };
}
