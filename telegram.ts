/**
 * The link to Telegram: the reader's api_id and api_hash (kept in
 * `api.secrets`), one TDLib client started on first use, requests with a
 * timeout and the reader's wording for every error, and who is signed in.
 * TDLib keeps the login in its database under the extension's `data` folder.
 */

import { join } from "node:path";
import type { ExtensionApi } from "@prifly/extension-api";
import { explain } from "./errors";
import type {
  EditableApi,
  TdChat,
  TdClient,
  TdFactory,
  TdMessage,
  TdObject,
  TdUser,
} from "./types";

/** How long an ordinary request may take before the network is blamed. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** How long a send may stay unconfirmed before the answer says so. */
export const SEND_WAIT_MS = 60_000;

const KEY_ID = "api_id";
const KEY_HASH = "api_hash";
export const ACCOUNT = "account";

export type Credentials = { apiId: number; apiHash: string };
export type Account = { id: number; name: string };
export type SendOutcome = { ok: true; id: number } | { ok: false; error: string };

/** A TDLib failure: `message` is for the reader, `raw` is TDLib's own text. */
export class TdFailure extends Error {
  readonly raw: string;
  constructor(raw: string) {
    super(explain(new Error(raw)));
    this.raw = raw;
  }
}

export class Telegram {
  private client: TdClient | null = null;
  private starting: Promise<TdClient> | null = null;
  private readonly outcomes = new Map<number, SendOutcome>();
  private readonly waiters = new Map<number, (outcome: SendOutcome) => void>();
  private readonly users = new Map<number, string>();

  readonly api: EditableApi;
  private readonly factory: TdFactory;
  private readonly timeoutMs: number;
  private readonly sendWaitMs: number;

  constructor(
    api: ExtensionApi,
    factory: TdFactory,
    timeoutMs = REQUEST_TIMEOUT_MS,
    sendWaitMs = SEND_WAIT_MS,
  ) {
    this.api = api;
    this.factory = factory;
    this.timeoutMs = timeoutMs;
    this.sendWaitMs = sendWaitMs;
  }

  /** TDLib's database and files, and saved media when a session has no scratchpad. */
  dataFolder(...parts: string[]): string {
    return join(this.api.folder, "data", ...parts);
  }

  async credentials(): Promise<Credentials | null> {
    const id = await this.api.secrets?.get(KEY_ID);
    const hash = await this.api.secrets?.get(KEY_HASH);
    const apiId = Number(id);
    if (!hash || !Number.isInteger(apiId) || apiId <= 0) return null;
    return { apiId, apiHash: hash };
  }

  async saveCredentials(apiId: number, apiHash: string): Promise<void> {
    await this.api.secrets?.set(KEY_ID, String(apiId));
    await this.api.secrets?.set(KEY_HASH, apiHash);
  }

  async forgetCredentials(): Promise<void> {
    await this.api.secrets?.set(KEY_ID, null);
    await this.api.secrets?.set(KEY_HASH, null);
  }

  async account(): Promise<Account | null> {
    return (await this.api.state?.get<Account>(ACCOUNT)) ?? null;
  }

  /** The TDLib client, started on first use. Throws the reader's wording when it cannot be. */
  private async open(): Promise<TdClient> {
    if (this.client !== null) return this.client;
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return await this.starting;
  }

  private async start(): Promise<TdClient> {
    const credentials = await this.credentials();
    if (credentials === null) throw new Error(NOT_SET_UP);
    let client: TdClient;
    try {
      client = await this.factory({
        ...credentials,
        databaseDirectory: this.dataFolder("db"),
        filesDirectory: this.dataFolder("files"),
      });
    } catch (caught) {
      const why = caught instanceof Error ? caught.message : String(caught);
      this.api.log("tdlib_load_failed", { message: why });
      throw new Error(`Telegram's TDLib library could not be started: ${why}`);
    }
    client.onUpdate((update) => this.onUpdate(update, client));
    client.onError((error) => this.api.log("tdlib_error", { message: error.message }));
    this.client = client;
    return client;
  }

  private onUpdate(update: TdObject, from: TdClient): void {
    if (update._ === "updateMessageSendSucceeded") {
      const message = update["message"] as TdMessage;
      this.settle(update["old_message_id"] as number, { ok: true, id: message.id });
    } else if (update._ === "updateMessageSendFailed") {
      const text = String(update["error_message"] ?? "unknown error");
      this.settle(update["old_message_id"] as number, { ok: false, error: text });
    } else if (update._ === "updateAuthorizationState") {
      const state = update["authorization_state"] as TdObject;
      if (state._ === "authorizationStateClosed" && this.client === from) this.client = null;
    }
  }

  private settle(oldId: number, outcome: SendOutcome): void {
    const waiter = this.waiters.get(oldId);
    if (waiter !== undefined) {
      this.waiters.delete(oldId);
      waiter(outcome);
      return;
    }
    this.outcomes.set(oldId, outcome);
    if (this.outcomes.size > 50) this.outcomes.delete(this.outcomes.keys().next().value ?? 0);
  }

  /** The outcome of the send that TDLib queued as message `oldId`, or null after `ms`. */
  async sendOutcome(oldId: number, ms = this.sendWaitMs): Promise<SendOutcome | null> {
    const known = this.outcomes.get(oldId);
    if (known !== undefined) return known;
    return await new Promise<SendOutcome | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(oldId);
        resolve(null);
      }, ms);
      this.waiters.set(oldId, (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });
    });
  }

  /** One request. Throws a `TdFailure` (reader's wording; `raw` is TDLib's) when TDLib or the network fails. */
  async invoke<T = TdObject>(request: TdObject, timeoutMs = this.timeoutMs): Promise<T> {
    const client = await this.open();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new TdFailure(`Telegram did not answer within ${Math.round(timeoutMs / 1000)} s`)),
        timeoutMs,
      );
    });
    try {
      return (await Promise.race([client.invoke(request), late])) as T;
    } catch (caught) {
      if (caught instanceof TdFailure) throw caught;
      throw new TdFailure(caught instanceof Error ? caught.message : String(caught));
    } finally {
      clearTimeout(timer);
    }
  }

  /** TDLib's authorization state: `_` is "authorizationStateReady", "authorizationStateWaitCode", ... */
  async authState(): Promise<TdObject> {
    return await this.invoke({ _: "getAuthorizationState" });
  }

  /** Throws the reader's wording unless the account is signed in and ready. */
  async requireReady(): Promise<void> {
    if ((await this.credentials()) === null) throw new Error(NOT_SET_UP);
    const state = (await this.authState())._;
    if (state === "authorizationStateReady") return;
    throw new Error(notReady(state));
  }

  async chat(id: number): Promise<TdChat> {
    return await this.invoke<TdChat>({ _: "getChat", chat_id: id });
  }

  /** A user's name, kept for the session. */
  async userName(id: number): Promise<string> {
    const known = this.users.get(id);
    if (known !== undefined) return known;
    let name = `user ${id}`;
    try {
      const user = await this.invoke<TdUser>({ _: "getUser", user_id: id });
      const full = `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim();
      name = full || user.usernames?.editable_username || name;
    } catch {
      // A name we cannot fetch is shown as the id; do not keep it.
      return name;
    }
    this.users.set(id, name);
    return name;
  }

  /** Who wrote a message: "Me", a person's name or the chat's title. */
  async senderName(message: TdMessage): Promise<string> {
    if (message.is_outgoing) return "Me";
    if (message.sender_id._ === "messageSenderUser")
      return await this.userName(message.sender_id.user_id);
    try {
      return (await this.chat(message.sender_id.chat_id)).title;
    } catch {
      return `chat ${message.sender_id.chat_id}`;
    }
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    for (const waiter of this.waiters.values())
      waiter({ ok: false, error: "the extension stopped" });
    this.waiters.clear();
    try {
      await client?.close();
    } catch (caught) {
      this.api.log("close_failed", {
        message: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }

  /** Forget the client after a log-out, so the next use starts a fresh login. */
  async reset(): Promise<void> {
    await this.stop();
  }
}

export const NOT_SET_UP =
  "Telegram is not set up: it needs your own api_id and api_hash from my.telegram.org. Call telegram_link with action sign_in; it asks you for them on a card.";

/** What to say when TDLib is in a state other than ready. */
export function notReady(state: string): string {
  switch (state) {
    case "authorizationStateWaitPhoneNumber":
      return "Telegram is not signed in. Call telegram_link with action sign_in.";
    case "authorizationStateWaitCode":
      return "Telegram is waiting for the login code it sent you. Call telegram_link with action sign_in to enter it.";
    case "authorizationStateWaitPassword":
      return "Telegram is waiting for your two-step verification password. Call telegram_link with action sign_in to enter it.";
    case "authorizationStateLoggingOut":
    case "authorizationStateClosing":
    case "authorizationStateClosed":
      return "Telegram is signing out or restarting. Try again in a moment.";
    default:
      return `Telegram is not ready (${state}). Call telegram_link with action sign_in.`;
  }
}
