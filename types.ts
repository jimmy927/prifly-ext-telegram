/**
 * What the extension needs of TDLib, as small types of our own. Only
 * `client.ts` imports the real binding (`tdl`); everything else takes a
 * `TdFactory`, so the tests run against a fake client and never load tdjson.
 * Only the fields the extension reads are named.
 */

import type { ConfirmSpec, ExtensionApi } from "@prifly/extension-api";

/**
 * prifly's api with `confirmEdit` (feature "confirm-edit"), which the published
 * `@prifly/extension-api` does not declare yet: `confirm` with `content` drawn
 * as an editable text area. It answers the text as the reader left it; null is
 * whatever `confirm` would answer false to.
 */
export type EditableApi = ExtensionApi & {
  confirmEdit?(spec: ConfirmSpec & { content: string }): Promise<string | null>;
};

/** A TDLib request or answer: an object with its type in `_`. */
export type TdObject = { _: string } & Record<string, unknown>;

/** The client the extension talks to: `invoke` for requests, `onUpdate` for what TDLib pushes. */
export type TdClient = {
  invoke(request: TdObject): Promise<TdObject>;
  onUpdate(handler: (update: TdObject) => void): void;
  onError(handler: (error: Error) => void): void;
  close(): Promise<void>;
};

export type TdOptions = {
  apiId: number;
  apiHash: string;
  /** TDLib's database (login, chats, messages), in the extension's data folder. */
  databaseDirectory: string;
  /** TDLib's downloaded files. */
  filesDirectory: string;
};

/** Makes a client. The real one loads tdjson; a test passes a fake. */
export type TdFactory = (options: TdOptions) => TdClient | Promise<TdClient>;

export type TdFormattedText = { text: string };

export type TdFile = {
  id: number;
  size?: number;
  expected_size?: number;
  local?: { path?: string; is_downloading_completed?: boolean };
};

export type TdContent = {
  _: string;
  text?: TdFormattedText;
  caption?: TdFormattedText;
  emoji?: string;
  photo?: { sizes?: { photo: TdFile; width?: number }[] };
  document?: { file_name?: string; mime_type?: string; document: TdFile };
  video?: { file_name?: string; video: TdFile };
  audio?: { file_name?: string; audio: TdFile };
  voice_note?: { voice: TdFile };
  video_note?: { video: TdFile };
  animation?: { file_name?: string; animation: TdFile };
  sticker?: { sticker: TdFile };
};

export type TdSender =
  | { _: "messageSenderUser"; user_id: number }
  | { _: "messageSenderChat"; chat_id: number };

export type TdMessage = {
  id: number;
  chat_id: number;
  sender_id: TdSender;
  date: number;
  is_outgoing: boolean;
  content: TdContent;
};

export type TdChat = {
  id: number;
  type: { _: string; is_channel?: boolean };
  title: string;
  unread_count?: number;
  last_message?: TdMessage | null;
  permissions?: { can_send_basic_messages?: boolean };
};

export type TdUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  usernames?: { editable_username?: string };
};

/** A TDLib error as the binding throws it: `code` and TDLib's `message`. */
export type TdError = Error & { code?: number };
