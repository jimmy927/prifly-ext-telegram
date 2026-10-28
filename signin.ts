/**
 * Signing in, as a loop over TDLib's authorization state: each state that
 * needs something from the reader asks on a prifly dialog (`api.dialog`, a
 * text box over the session). What they type goes from the dialog into
 * TDLib here and nowhere else: never through the model, a tool argument or a
 * log line. TDLib keeps the state across calls, so a sign-in the reader
 * closed carries on where it stopped the next time.
 *
 * prifly's dialog has no masked field, so the login code, and the 2FA
 * password, are visible on the dialog while the reader types them.
 */

import type { ExtensionToolContext } from "@prifly/extension-api";
import { loginFault } from "./errors";
import { ACCOUNT, type Account, TdFailure, type Telegram } from "./telegram";
import type { TdObject, TdUser } from "./types";

/** Wrong codes or passwords tolerated in one sign-in before it stops. */
const MOST_TRIES = 3;

type Ask = { title: string; description: string; hint?: string; confirm: string };

/** The reader's answer, trimmed; null when they closed the dialog. */
async function ask(tg: Telegram, ctx: ExtensionToolContext, spec: Ask): Promise<string | null> {
  const answer = await tg.api.dialog({ sessionId: ctx.session, text: "", rows: 1, ...spec });
  return answer === null ? null : answer.trim();
}

const nameOf = (user: TdUser): string =>
  `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() ||
  user.usernames?.editable_username ||
  `user ${user.id}`;

/** Who is signed in, remembered for the status line. */
export async function rememberAccount(tg: Telegram): Promise<Account> {
  const me = await tg.invoke<TdUser>({ _: "getMe" });
  const account = { id: me.id, name: nameOf(me) };
  await tg.api.state?.set(ACCOUNT, account);
  return account;
}

/** The api_id and api_hash, asked once and kept in `api.secrets`. Returns why not, or null. */
export async function askCredentials(
  tg: Telegram,
  ctx: ExtensionToolContext,
): Promise<string | null> {
  const why =
    "Telegram needs your own api_id and api_hash. Sign in at https://my.telegram.org, open API development tools, create an application and copy both. Each user registers their own.";
  const id = await ask(tg, ctx, {
    title: "Telegram: api_id",
    description: why,
    hint: "A number, like 1234567",
    confirm: "Next",
  });
  if (id === null) return "Not done: you closed the api_id card.";
  if (!/^\d{1,12}$/.test(id) || Number(id) <= 0)
    return "Not done: that api_id is not a number. Call telegram_link again.";
  const hash = await ask(tg, ctx, {
    title: "Telegram: api_hash",
    description:
      "The api_hash from the same page: 32 letters and digits. It is kept in prifly's sealed secret store.",
    confirm: "Save",
  });
  if (hash === null) return "Not done: you closed the api_hash card.";
  if (!/^[0-9a-f]{32}$/i.test(hash))
    return "Not done: that api_hash is not 32 letters and digits. Call telegram_link again.";
  await tg.saveCredentials(Number(id), hash);
  return null;
}

type Outcome = { say: string } | "again";

class SignIn {
  private wrong = 0;
  private notice = "";

  private readonly tg: Telegram;
  private readonly ctx: ExtensionToolContext;

  constructor(tg: Telegram, ctx: ExtensionToolContext) {
    this.tg = tg;
    this.ctx = ctx;
  }

  /** Asks, then runs `submit`. A refusal that is the reader's to fix asks again, up to MOST_TRIES. */
  private async prompt(
    spec: Ask,
    submit: (answer: string) => Promise<void>,
    stopped: string,
  ): Promise<Outcome> {
    const answer = await ask(this.tg, this.ctx, {
      ...spec,
      description: `${this.notice}${spec.description}`,
    });
    if (answer === null)
      return {
        say: `Not done: you closed the card. ${stopped} Call telegram_link with action sign_in to carry on.`,
      };
    this.notice = "";
    try {
      await submit(answer);
    } catch (caught) {
      const raw = caught instanceof TdFailure ? caught.raw : "";
      if (loginFault(raw) === null || loginFault(raw) === "code-expired") throw caught;
      this.wrong += 1;
      if (this.wrong >= MOST_TRIES)
        return {
          say: `${(caught as Error).message} Stopped after ${MOST_TRIES} tries; call telegram_link to start again.`,
        };
      this.notice = `${(caught as Error).message} Try again.\n\n`;
    }
    return "again";
  }

  private phone(): Promise<Outcome> {
    return this.prompt(
      {
        title: "Telegram: phone number",
        description: "The phone number of your Telegram account, with country code.",
        hint: "+46701234567",
        confirm: "Send code",
      },
      async (phone) =>
        void (await this.tg.invoke({ _: "setAuthenticationPhoneNumber", phone_number: phone })),
      "Telegram is waiting for your phone number.",
    );
  }

  private code(state: TdObject): Promise<Outcome> {
    const info = state["code_info"] as { phone_number?: string } | undefined;
    const to = info?.phone_number ? `+${info.phone_number.replace(/^\+/, "")}` : "your phone";
    return this.prompt(
      {
        title: "Telegram: login code",
        description: `Telegram sent a login code to ${to}: look in the Telegram app on another device, or in an SMS.`,
        confirm: "Sign in",
      },
      async (code) => void (await this.tg.invoke({ _: "checkAuthenticationCode", code })),
      "Telegram is waiting for the login code it sent you.",
    );
  }

  private password(state: TdObject): Promise<Outcome> {
    const hint =
      typeof state["password_hint"] === "string" && state["password_hint"] !== ""
        ? ` Hint: ${state["password_hint"]}.`
        : "";
    return this.prompt(
      {
        title: "Telegram: two-step verification",
        description: `Your account has a two-step verification password.${hint}`,
        confirm: "Sign in",
      },
      async (password) =>
        void (await this.tg.invoke({ _: "checkAuthenticationPassword", password })),
      "Telegram is waiting for your two-step verification password.",
    );
  }

  private async step(state: TdObject): Promise<Outcome> {
    switch (state._) {
      case "authorizationStateReady": {
        const account = await rememberAccount(this.tg);
        return { say: `Signed in to Telegram as ${account.name}.` };
      }
      case "authorizationStateWaitPhoneNumber":
        return await this.phone();
      case "authorizationStateWaitCode":
        return await this.code(state);
      case "authorizationStateWaitPassword":
        return await this.password(state);
      case "authorizationStateWaitRegistration":
        return {
          say: "Not done: that phone number has no Telegram account. Register in the official Telegram app first.",
        };
      case "authorizationStateLoggingOut":
      case "authorizationStateClosing":
      case "authorizationStateClosed":
        await this.tg.reset();
        return "again";
      default:
        return {
          say: `Not done: Telegram asks for a step this extension does not support (${state._}).`,
        };
    }
  }

  async run(): Promise<string> {
    for (let turn = 0; turn < 12; turn++) {
      const outcome = await this.step(await this.tg.authState());
      if (outcome !== "again") return outcome.say;
    }
    return "Not done: the sign-in did not finish; call telegram_link again.";
  }
}

/** Walks the sign-in from wherever TDLib stands; resolves with what to tell the session. */
export async function signIn(tg: Telegram, ctx: ExtensionToolContext): Promise<string> {
  if ((await tg.credentials()) === null) {
    const stopped = await askCredentials(tg, ctx);
    if (stopped !== null) return stopped;
  }
  return await new SignIn(tg, ctx).run();
}
