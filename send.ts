/**
 * `telegram_send`: one message to one chat, a text or a local file with an
 * optional caption. The reader first sees a card with the recipient and
 * exactly what goes out, and nothing is sent unless they confirm; where
 * prifly offers `confirmEdit` they can change the text or caption on the card
 * and what they leave there is what goes out. Telegram's terms forbid
 * bulk and unsolicited messaging: one recipient per call, only into a chat
 * that already has messages, and a cap per hour that a person typing by hand
 * does not reach.
 */

import { statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { ConfirmSpec, ExtensionTool } from "@prifly/extension-api";
import { explain } from "./errors";
import { chatIdOf } from "./read";
import type { SendOutcome, Telegram } from "./telegram";
import type { TdChat, TdMessage, TdObject } from "./types";

/** What a tool returns when the reader cancels its confirm card. */
export const CANCELLED = "Not done: you cancelled";
const EMPTIED = "Not sent: you emptied the message on the card, so there is nothing to send";
/** The most sends in an hour; far above what a person confirms by hand. */
export const MOST_PER_HOUR = 30;
/** Telegram's own limit for one file. */
const MOST_FILE_BYTES = 2_000_000_000;
const PICTURES = [".jpg", ".jpeg", ".png"];

type Send = {
  chat: TdChat;
  message: string;
  file: { path: string; name: string; bytes: number } | null;
};

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const megabytes = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;

function fileToSend(path: string): NonNullable<Send["file"]> {
  let bytes: number;
  try {
    const found = statSync(path);
    if (!found.isFile()) throw new Error("not a file");
    bytes = found.size;
  } catch (caught) {
    throw new Error(
      `Not sent: cannot read the file ${path}: ${caught instanceof Error ? caught.message : String(caught)}`,
    );
  }
  if (bytes > MOST_FILE_BYTES)
    throw new Error(`Not sent: ${path} is ${megabytes(bytes)}; Telegram takes at most 2 GB.`);
  return { path, name: basename(path), bytes };
}

/** The confirm card; with `editable` the message or caption is the editable `content` alone. */
function card(send: Send, editable: boolean): ConfirmSpec & { content: string } {
  const to = `${send.chat.title} (chat id ${send.chat.id})`;
  const { file } = send;
  if (file === null) {
    return {
      title: "Send a Telegram message",
      summary: `Send a Telegram message to ${send.chat.title}.`,
      content: editable ? send.message : `To: ${to}\n\n${send.message}`,
      details: `To: ${to}`,
    };
  }
  const caption = send.message === "" ? "" : `\nCaption:\n${send.message}`;
  const details = `To: ${to}\nFile: ${file.name}\nPath: ${file.path}\nSize: ${megabytes(file.bytes)}`;
  return {
    title: "Send a file on Telegram",
    summary: `Send the file ${file.name} to ${send.chat.title}${send.message === "" ? "" : " with a caption"}.`,
    content: editable ? send.message : `To: ${to}\nFile: ${file.name}${caption}`,
    details,
  };
}

function inputContent(send: Send): TdObject {
  const formatted = { _: "formattedText", text: send.message };
  const { file } = send;
  if (file === null) return { _: "inputMessageText", text: formatted };
  const local = { _: "inputFileLocal", path: file.path };
  if (PICTURES.includes(extname(file.path).toLowerCase())) {
    return { _: "inputMessagePhoto", photo: local, caption: formatted };
  }
  return { _: "inputMessageDocument", document: local, caption: formatted };
}

/** Everything a send is checked for before the reader is asked. */
async function prepare(tg: Telegram, args: Record<string, unknown>): Promise<Send> {
  const chatId = chatIdOf(args["chat_id"]);
  const message = text(args["text"]).trim();
  const path = text(args["file"]).trim();
  if (path === "" && message === "") throw new Error("Not sent: give a text, a file, or both.");
  const file = path === "" ? null : fileToSend(path);
  await tg.requireReady();
  const chat = await tg.chat(chatId);
  if (!chat.last_message) {
    throw new Error(
      `Not sent: there are no earlier messages in ${chat.title}; prifly never starts a conversation.`,
    );
  }
  if (chat.permissions?.can_send_basic_messages === false) {
    throw new Error(`Not sent: you cannot write in ${chat.title}.`);
  }
  return { chat, message, file };
}

/** What the session is told once TDLib has reported how the send ended. */
function report(send: Send, outcome: SendOutcome | null): string {
  if (outcome === null) {
    return `Handed to Telegram for ${send.chat.title}, but it has not confirmed delivery yet. Do not send it again; check telegram_chat before deciding anything.`;
  }
  if (!outcome.ok)
    throw new Error(`Not sent to ${send.chat.title}: ${explain(new Error(outcome.error))}`);
  return `Sent to ${send.chat.title} (${send.chat.id}). Message id: #${outcome.id}`;
}

export function sendTool(tg: Telegram, now: () => number = Date.now): ExtensionTool {
  const sentAt: number[] = [];
  return {
    name: "telegram_send",
    description:
      "Sends one Telegram message to exactly one chat by chat_id (from telegram_chats): a text, or a local file with an optional caption. The reader first sees a card with the recipient and exactly what goes out; it is sent only if they confirm, and if they cancel nothing is sent. Only into chats that already have messages; one recipient per call, never bulk.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "One chat id from telegram_chats" },
        text: { type: "string", description: "The message, or the file's caption" },
        file: { type: "string", description: "The path of a local file to send" },
      },
      required: ["chat_id"],
      additionalProperties: false,
    },
    call: async (args) => {
      const send = await prepare(tg, args);
      while (sentAt.length > 0 && now() - (sentAt[0] ?? 0) > 3_600_000) sentAt.shift();
      if (sentAt.length >= MOST_PER_HOUR) {
        throw new Error(
          `Not sent: ${MOST_PER_HOUR} messages went out in the last hour; Telegram does not allow bulk messaging. Wait.`,
        );
      }
      const answer = await asked(tg, send);
      if ("stop" in answer) return answer.stop;
      const going = { ...send, message: answer.message };
      sentAt.push(now());
      const queued = await tg.invoke<TdMessage>({
        _: "sendMessage",
        chat_id: send.chat.id,
        input_message_content: inputContent(going),
      });
      const result = report(going, await tg.sendOutcome(queued.id));
      return answer.message === send.message
        ? result
        : `${result}\n${editedNote(send, answer.message)}`;
    },
  };
}

/** The reader's answer on the card: the text to send, or the reply to give back instead of sending. */
async function asked(tg: Telegram, send: Send): Promise<{ message: string } | { stop: string }> {
  const { api } = tg;
  if (api.confirmEdit !== undefined) {
    const answered = await api.confirmEdit(card(send, true));
    if (answered === null) return { stop: CANCELLED };
    const message = answered.trim();
    return send.file === null && message === "" ? { stop: EMPTIED } : { message };
  }
  if (api.confirm === undefined) {
    throw new Error("Not sent: this prifly cannot show a confirm card; update prifly first.");
  }
  return (await api.confirm(card(send, false))) ? { message: send.message } : { stop: CANCELLED };
}

/** Tells the session the reader changed the text, and what went out. */
function editedNote(send: Send, final: string): string {
  const what = send.file === null ? "text" : "caption";
  const shown = final === "" ? "It went out with no caption." : `The ${what} sent:\n${final}`;
  return `The reader edited the ${what} before it was sent. ${shown}`;
}
