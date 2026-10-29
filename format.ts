/** Chats and messages as Markdown for a session, and the file inside a message. */

import type { TdChat, TdContent, TdFile, TdMessage } from "./types";

/** "2026-10-28 12:01" in UTC, from Telegram's epoch seconds. */
export const stamp = (seconds: number): string =>
  new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");

/** The file in a message and what it is called, or null for a message without one. */
export function fileOf(content: TdContent): { kind: string; name: string; file: TdFile } | null {
  const sizes = content.photo?.sizes ?? [];
  const biggest = sizes[sizes.length - 1];
  if (biggest !== undefined) return { kind: "photo", name: "photo.jpg", file: biggest.photo };
  if (content.document) {
    const { file_name: name, document } = content.document;
    return { kind: "file", name: name || "file", file: document };
  }
  if (content.video)
    return {
      kind: "video",
      name: content.video.file_name || "video.mp4",
      file: content.video.video,
    };
  if (content.audio)
    return { kind: "audio", name: content.audio.file_name || "audio", file: content.audio.audio };
  if (content.voice_note)
    return { kind: "voice note", name: "voice.ogg", file: content.voice_note.voice };
  if (content.video_note)
    return { kind: "video note", name: "video-note.mp4", file: content.video_note.video };
  if (content.animation) {
    const { file_name: name, animation } = content.animation;
    return { kind: "animation", name: name || "animation.mp4", file: animation };
  }
  if (content.sticker)
    return { kind: "sticker", name: "sticker.webp", file: content.sticker.sticker };
  return null;
}

/** Telegram's own service account: it sends the login codes. Also the id of its chat. */
export const TELEGRAM_SERVICE = 777000;
/** A run of 4 or more digits, spaced or dashed or not ("71200", "12-345", "1 2 3 4 5"). */
const CODE = /\d(?:[-\s]?\d){3,}/g;

/** Whether a message comes from Telegram's service account (its chat, or as sender). */
const fromService = (message: TdMessage): boolean =>
  message.chat_id === TELEGRAM_SERVICE ||
  (message.sender_id?._ === "messageSenderUser" && message.sender_id.user_id === TELEGRAM_SERVICE);

/** Content kinds that are no service messages, so they keep their plain marker. */
const PLAIN_KINDS = new Set(["poll", "location", "venue", "contact", "dice", "game", "invoice"]);

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A call's length as m:ss. */
const clock = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/** A service message (someone joined, a call, a pinned message) as short readable text. */
export function serviceText(content: TdContent): string {
  switch (content._) {
    case "messageContactRegistered":
      return "[joined Telegram]";
    case "messageChatAddMembers":
      return `[added ${plural(content.member_user_ids?.length ?? 0, "member")}]`;
    case "messageChatJoinByLink":
    case "messageChatJoinByRequest":
      return "[joined the chat by invite link]";
    case "messageChatDeleteMember":
      return "[a member left or was removed]";
    case "messageChatChangeTitle":
      return `[changed the chat title to "${content.title ?? ""}"]`;
    case "messageChatChangePhoto":
      return "[changed the chat photo]";
    case "messagePinMessage":
      return "[pinned a message]";
    case "messageScreenshotTaken":
      return "[took a screenshot]";
    case "messageCall": {
      const kind = content.is_video ? "video call" : "call";
      const reason = content.discard_reason?._;
      if (reason === "callDiscardReasonMissed") return `[missed ${kind}]`;
      if (reason === "callDiscardReasonDeclined") return `[declined ${kind}]`;
      return content.duration ? `[${kind}, ${clock(content.duration)}]` : `[${kind}]`;
    }
    default: {
      const kind = content._.replace(/^message/, "").toLowerCase();
      return PLAIN_KINDS.has(kind) ? `[${kind}]` : `[service: ${kind}]`;
    }
  }
}

/** What a message says: its text or caption, and a marker for a file or a kind we do not show. */
export function describe(content: TdContent): string {
  const text = content.text?.text ?? content.caption?.text ?? "";
  if (content._ === "messageText") return text;
  const file = fileOf(content);
  if (file !== null) {
    const emoji = content.emoji ? ` ${content.emoji}` : "";
    const marker = `[${file.kind}${file.kind === "file" ? ` ${file.name}` : ""}${emoji}]`;
    return text === "" ? marker : `${marker} ${text}`;
  }
  return text === "" ? serviceText(content) : text;
}

/**
 * What a message says for the model. A message from Telegram's service account
 * carries login codes, so digit codes in it are hidden and the rest stays.
 */
export function bodyOf(message: TdMessage): string {
  const body = describe(message.content);
  return fromService(message) ? body.replace(CODE, "[login code hidden]") : body;
}

/** One message as a line: when, who, what, and its id for telegram_media and paging. */
export function messageLine(message: TdMessage, sender: string): string {
  const body = bodyOf(message).replace(/\r?\n/g, "\n  ");
  return `- ${stamp(message.date)} UTC **${sender}**: ${body} \`#${message.id}\``;
}

/** What kind of chat: person, group, channel. */
export function kindOfChat(chat: TdChat): string {
  switch (chat.type._) {
    case "chatTypePrivate":
    case "chatTypeSecret":
      return "person";
    case "chatTypeBasicGroup":
      return "group";
    case "chatTypeSupergroup":
      return chat.type.is_channel ? "channel" : "group";
    default:
      return "chat";
  }
}

export function chatLine(chat: TdChat): string {
  const unread = (chat.unread_count ?? 0) > 0 ? ` · ${chat.unread_count} unread` : "";
  const last = chat.last_message;
  const when = last ? ` · ${stamp(last.date)} UTC` : "";
  const preview = last ? bodyOf(last).replace(/\s+/g, " ").slice(0, 100) : "(no messages)";
  return `- **${chat.title}** (${kindOfChat(chat)}) \`${chat.id}\`${when}${unread}\n  ${preview}`;
}
