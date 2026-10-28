/**
 * The reading tools: `telegram_chats`, `telegram_chat` and `telegram_new`.
 * Reads run at once and send nothing: no read receipts either (a chat is
 * never marked viewed), so reading does not tell anyone you did.
 */

import type { ExtensionTool } from "@prifly/extension-api";
import { chatLine, messageLine } from "./format";
import type { Telegram } from "./telegram";
import type { TdChat, TdMessage, TdObject } from "./types";

export const count = (value: unknown, fallback: number, max: number): number =>
  typeof value === "number" && value >= 1 ? Math.min(Math.floor(value), max) : fallback;

/** The one chat id a call means. A name, a list or anything else is refused. */
export function chatIdOf(value: unknown, name = "chat_id"): number {
  const id = typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id === 0) {
    const hint = name === "chat_id" ? " (see telegram_chats)" : "";
    throw new Error(`${name} must be one number${hint}, not a name or a list.`);
  }
  return id;
}

/**
 * Up to `limit` messages of a chat, newest first, starting below `fromId` (0:
 * the newest). TDLib may answer with fewer than asked, so it asks again from
 * the oldest message it got until it has enough or the chat has no more.
 */
export async function history(
  tg: Telegram,
  chatId: number,
  fromId: number,
  limit: number,
): Promise<TdMessage[]> {
  const got: TdMessage[] = [];
  let from = fromId;
  for (let round = 0; round < 4 && got.length < limit; round++) {
    const page = await tg.invoke<{ messages?: (TdMessage | null)[] }>({
      _: "getChatHistory",
      chat_id: chatId,
      from_message_id: from,
      offset: 0,
      limit: limit - got.length,
      only_local: false,
    });
    const messages = (page.messages ?? []).filter((each): each is TdMessage => each !== null);
    if (messages.length === 0) break;
    got.push(...messages);
    from = messages[messages.length - 1]?.id ?? from;
  }
  return got.slice(0, limit);
}

async function lines(tg: Telegram, messages: TdMessage[]): Promise<string> {
  const out: string[] = [];
  for (const message of messages) out.push(messageLine(message, await tg.senderName(message)));
  return out.join("\n");
}

export function chatsTool(tg: Telegram): ExtensionTool {
  return {
    name: "telegram_chats",
    description:
      "Lists the reader's recent Telegram chats (title, kind, chat id, last message, time, unread), newest first. `query` narrows by name. The chat id is what telegram_chat, telegram_media and telegram_send take.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Part of a chat's name" },
        limit: { type: "number", description: "How many chats, default 20, at most 100" },
      },
      additionalProperties: false,
    },
    call: async (args) => {
      await tg.requireReady();
      const limit = count(args["limit"], 20, 100);
      const query = typeof args["query"] === "string" ? args["query"].trim() : "";
      const found =
        query === ""
          ? await tg.invoke<{ chat_ids?: number[] }>({
              _: "getChats",
              chat_list: { _: "chatListMain" },
              limit,
            })
          : await tg.invoke<{ chat_ids?: number[] }>({ _: "searchChats", query, limit });
      const chats: TdChat[] = [];
      for (const id of found.chat_ids ?? []) chats.push(await tg.chat(id));
      if (chats.length === 0) return query === "" ? "No chats." : `No chat matches "${query}".`;
      return chats.map(chatLine).join("\n");
    },
  };
}

export function chatTool(tg: Telegram): ExtensionTool {
  return {
    name: "telegram_chat",
    description:
      "Reads one Telegram chat as Markdown, oldest message first, each line ending with its message id (#id). Newest messages by default; to page back pass from_message_id = the oldest id of the last page (the tool prints it). Files are not downloaded: use telegram_media with the message id.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "The chat id from telegram_chats" },
        from_message_id: {
          type: "number",
          description: "Only messages older than this id; 0 or left out: the newest",
        },
        limit: { type: "number", description: "How many messages, default 30, at most 100" },
      },
      required: ["chat_id"],
      additionalProperties: false,
    },
    call: async (args) => {
      await tg.requireReady();
      const chatId = chatIdOf(args["chat_id"]);
      const from = typeof args["from_message_id"] === "number" ? args["from_message_id"] : 0;
      const messages = await history(tg, chatId, from, count(args["limit"], 30, 100));
      const chat = await tg.chat(chatId);
      if (messages.length === 0) {
        return from === 0
          ? `No messages in ${chat.title} (${chatId}).`
          : `No older messages in ${chat.title} (${chatId}) than #${from}.`;
      }
      const ordered = [...messages].reverse();
      const oldest = ordered[0]?.id ?? 0;
      return `## ${chat.title} (${chatId})\n\n${await lines(tg, ordered)}\n\nOlder messages: from_message_id=${oldest}`;
    },
  };
}

/** Where `telegram_new` stopped, per chat: the id of the newest message already reported. */
export type Cursor = Record<string, number>;
export const CURSOR = "cursor";
/** The most unread messages shown for a chat the first time it is seen. */
const FIRST_LOOK = 20;

type Fresh = { chat: TdChat; messages: TdMessage[] };

/** The incoming messages of `chat` after the cursor, newest last. */
async function freshIn(
  tg: Telegram,
  chat: TdChat,
  seen: number | undefined,
  most: number,
): Promise<TdMessage[]> {
  const last = chat.last_message;
  if (!last) return [];
  let want: number;
  if (seen === undefined) want = Math.min(chat.unread_count ?? 0, FIRST_LOOK, most);
  else if (last.id > seen) want = most;
  else return [];
  if (want === 0) return [];
  const recent = await history(tg, chat.id, 0, want);
  return recent.filter((m) => !m.is_outgoing && (seen === undefined || m.id > seen)).reverse();
}

export function newTool(tg: Telegram): ExtensionTool {
  return {
    name: "telegram_new",
    description:
      "Messages other people sent since the last call of this tool, per chat (incoming only). The first call shows the unread messages of the recent chats. It remembers where it stopped, so a message is shown once. Does not mark anything as read.",
    inputSchema: {
      type: "object",
      properties: {
        limit_per_chat: {
          type: "number",
          description: "Most messages shown per chat, default 20, at most 100",
        },
        chats: {
          type: "number",
          description: "How many recent chats to look at, default 50, at most 100",
        },
      },
      additionalProperties: false,
    },
    call: async (args) => {
      await tg.requireReady();
      const { state } = tg.api;
      if (state === undefined) {
        throw new Error("Not available: this prifly cannot keep state; update prifly.");
      }
      const most = count(args["limit_per_chat"], 20, 100);
      const cursor = (await state.get<Cursor>(CURSOR)) ?? {};
      const { fresh, next } = await scan(tg, cursor, count(args["chats"], 50, 100), most);
      await state.set(CURSOR, next);
      if (fresh.length === 0) return "No new messages.";
      const parts: string[] = [];
      for (const { chat, messages } of fresh) {
        const cut = messages.length >= most ? " (the latest; older ones are not shown)" : "";
        const head = `## ${chat.title} (${chat.id}) · ${messages.length} new${cut}`;
        parts.push(`${head}\n\n${await lines(tg, messages)}`);
      }
      return parts.join("\n\n");
    },
  };
}

/** The chats with new incoming messages, and the cursor that moves past them. */
async function scan(
  tg: Telegram,
  cursor: Cursor,
  chats: number,
  most: number,
): Promise<{ fresh: Fresh[]; next: Cursor }> {
  const top = await tg.invoke<{ chat_ids?: number[] }>({
    _: "getChats",
    chat_list: { _: "chatListMain" } satisfies TdObject,
    limit: chats,
  });
  const next: Cursor = { ...cursor };
  const fresh: Fresh[] = [];
  for (const id of top.chat_ids ?? []) {
    const chat = await tg.chat(id);
    const messages = await freshIn(tg, chat, cursor[String(id)], most);
    if (messages.length > 0) fresh.push({ chat, messages });
    if (chat.last_message) next[String(id)] = chat.last_message.id;
  }
  return { fresh, next };
}
