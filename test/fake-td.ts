/**
 * A fake TDLib client: a scripted login (phone, then code `48213`, then
 * password `pw` when `twoFactor`), chats with messages, history pages, sends
 * that settle by update, and downloads. It records every request. No network,
 * no tdjson.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TdChat, TdClient, TdFactory, TdMessage, TdObject, TdOptions } from "../types";

export const CODE = "48213";
export const PASSWORD = "pw";

/** A TDLib error as the binding throws it. */
export const tdError = (message: string, code = 400): Error =>
  Object.assign(new Error(message), { code });

export type FakeTdOptions = {
  twoFactor?: boolean;
  /** Fail the phone step with this TDLib message. */
  phoneError?: string;
  /** Most messages one getChatHistory answers, as TDLib sometimes answers fewer. */
  pageCap?: number;
  /** How a send ends: succeeds (default), fails with this message, or never settles. */
  send?: "ok" | "never" | { fail: string };
  /** Never answer a request. */
  hang?: boolean;
};

export class FakeTd {
  state = "authorizationStateWaitPhoneNumber";
  readonly requests: TdObject[] = [];
  readonly chats = new Map<number, TdChat>();
  /** Messages per chat, newest first. */
  readonly messages = new Map<number, TdMessage[]>();
  readonly users = new Map<number, string>([[7, "Ada"]]);
  readonly folder = mkdtempSync(join(tmpdir(), "fake-td-"));
  closed = false;
  private updates: (update: TdObject) => void = () => undefined;
  private nextTemp = 1;

  readonly options: FakeTdOptions;
  /** The options each client was started with. */
  readonly given: TdOptions[] = [];

  constructor(options: FakeTdOptions = {}) {
    this.options = options;
  }

  /** Make the factory hand out this one client. */
  factory(): TdFactory {
    return (opts) => {
      this.given.push(opts);
      return this.client();
    };
  }

  addChat(
    id: number,
    title: string,
    texts: string[] = [],
    unread = 0,
    outgoing: number[] = [],
  ): void {
    const list: TdMessage[] = [];
    texts.forEach((text, index) => {
      list.unshift({
        id: (index + 1) * 100,
        chat_id: id,
        sender_id: { _: "messageSenderUser", user_id: 7 },
        date: 1_790_000_000 + index * 60,
        is_outgoing: outgoing.includes(index),
        content: { _: "messageText", text: { text } },
      });
    });
    this.messages.set(id, list);
    this.chats.set(id, {
      id,
      title,
      type: { _: "chatTypePrivate" },
      unread_count: unread,
      last_message: list[0] ?? null,
      permissions: {},
    });
  }

  /** A message arrives (or is added) in a chat. */
  push(chatId: number, message: Partial<TdMessage> & { id: number }): void {
    const full: TdMessage = {
      chat_id: chatId,
      sender_id: { _: "messageSenderUser", user_id: 7 },
      date: 1_790_100_000,
      is_outgoing: false,
      content: { _: "messageText", text: { text: "new" } },
      ...message,
    };
    this.messages.set(chatId, [full, ...(this.messages.get(chatId) ?? [])]);
    const chat = this.chats.get(chatId);
    if (chat)
      this.chats.set(chatId, {
        ...chat,
        last_message: full,
        unread_count: (chat.unread_count ?? 0) + 1,
      });
  }

  update(update: TdObject): void {
    this.updates(update);
  }

  sent(): TdObject[] {
    return this.requests.filter((request) => request._ === "sendMessage");
  }

  private client(): TdClient {
    return {
      invoke: (request) => this.handle(request),
      onUpdate: (handler) => {
        this.updates = handler;
      },
      onError: () => undefined,
      close: async () => {
        this.closed = true;
      },
    };
  }

  private async handle(request: TdObject): Promise<TdObject> {
    this.requests.push(request);
    if (this.options.hang) return await new Promise<TdObject>(() => undefined);
    const login = this.login(request);
    if (login !== null) return login;
    switch (request._) {
      case "getMe":
        return { _: "user", id: 7, first_name: "Ada", last_name: "Lovelace" };
      case "getUser":
        return {
          _: "user",
          id: request["user_id"] as number,
          first_name: this.users.get(request["user_id"] as number) ?? "Someone",
        };
      case "getChats":
        return {
          _: "chats",
          chat_ids: [...this.chats.keys()].slice(0, request["limit"] as number),
        };
      case "searchChats":
        return {
          _: "chats",
          chat_ids: [...this.chats.values()]
            .filter((c) => c.title.includes(request["query"] as string))
            .map((c) => c.id),
        };
      case "getChat":
        return this.chat(request["chat_id"] as number) as unknown as TdObject;
      case "getChatHistory":
        return this.history(request);
      case "getMessage":
        return this.message(request["chat_id"] as number, request["message_id"] as number);
      case "downloadFile":
        return this.download();
      case "sendMessage":
        return this.send();
      case "logOut":
        this.state = "authorizationStateWaitPhoneNumber";
        return { _: "ok" };
      default:
        throw tdError(`unexpected request ${request._}`);
    }
  }

  private login(request: TdObject): TdObject | null {
    switch (request._) {
      case "getAuthorizationState":
        return { _: this.state, code_info: { phone_number: "46701234567" }, password_hint: "pet" };
      case "setAuthenticationPhoneNumber":
        if (this.options.phoneError) throw tdError(this.options.phoneError, 429);
        this.state = "authorizationStateWaitCode";
        return { _: "ok" };
      case "checkAuthenticationCode":
        if (request["code"] !== CODE) throw tdError("PHONE_CODE_INVALID");
        this.state = this.options.twoFactor
          ? "authorizationStateWaitPassword"
          : "authorizationStateReady";
        return { _: "ok" };
      case "checkAuthenticationPassword":
        if (request["password"] !== PASSWORD) throw tdError("PASSWORD_HASH_INVALID");
        this.state = "authorizationStateReady";
        return { _: "ok" };
      default:
        return null;
    }
  }

  private chat(id: number): TdChat {
    const chat = this.chats.get(id);
    if (!chat) throw tdError("Chat not found", 400);
    return chat;
  }

  private history(request: TdObject): TdObject {
    const all = this.messages.get(request["chat_id"] as number) ?? [];
    const from = request["from_message_id"] as number;
    const older = from === 0 ? all : all.filter((m) => m.id < from);
    const cap = this.options.pageCap ?? Number.MAX_SAFE_INTEGER;
    return { _: "messages", messages: older.slice(0, Math.min(request["limit"] as number, cap)) };
  }

  private message(chatId: number, id: number): TdObject {
    const found = (this.messages.get(chatId) ?? []).find((m) => m.id === id);
    if (!found) throw tdError("Message not found", 404);
    return found as unknown as TdObject;
  }

  private download(): TdObject {
    const path = join(this.folder, "cached.bin");
    writeFileSync(path, "file bytes");
    return { _: "file", id: 1, local: { path, is_downloading_completed: true } };
  }

  private send(): TdObject {
    const temp = this.nextTemp++;
    const how = this.options.send ?? "ok";
    if (how !== "never") {
      queueMicrotask(() => {
        if (how === "ok")
          this.updates({
            _: "updateMessageSendSucceeded",
            old_message_id: temp,
            message: { id: 9000 + temp },
          });
        else
          this.updates({
            _: "updateMessageSendFailed",
            old_message_id: temp,
            error_code: 400,
            error_message: how.fail,
          });
      });
    }
    return { _: "message", id: temp };
  }
}
