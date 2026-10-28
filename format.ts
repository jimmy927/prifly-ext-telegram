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
  return text === "" ? `[${content._.replace(/^message/, "").toLowerCase()}]` : text;
}

/** One message as a line: when, who, what, and its id for telegram_media and paging. */
export function messageLine(message: TdMessage, sender: string): string {
  const body = describe(message.content).replace(/\r?\n/g, "\n  ");
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
  const preview = last
    ? describe(last.content).replace(/\s+/g, " ").slice(0, 100)
    : "(no messages)";
  return `- **${chat.title}** (${kindOfChat(chat)}) \`${chat.id}\`${when}${unread}\n  ${preview}`;
}
