/**
 * `telegram_link`: sign in, sign out, status, and forgetting the api keys; and
 * the status line in Settings -> Extensions. Signing out and forgetting keys
 * ask on a card first.
 */

import type { ExtensionTool, ExtensionToolContext } from "@prifly/extension-api";
import { CURSOR } from "./read";
import { CANCELLED } from "./send";
import { rememberAccount, signIn } from "./signin";
import { ACCOUNT, NOT_SET_UP, notReady, type Telegram } from "./telegram";

/** The line Settings -> Extensions shows, from what is stored; it starts nothing. */
export async function statusText(tg: Telegram): Promise<string> {
  if ((await tg.credentials()) === null) return "Not set up: ask a session to link Telegram";
  const account = await tg.account();
  return account === null
    ? "Not signed in: ask a session to link Telegram"
    : `Signed in as ${account.name}`;
}

export async function refreshStatus(tg: Telegram): Promise<void> {
  tg.api.status?.(await statusText(tg));
}

async function status(tg: Telegram): Promise<string> {
  if ((await tg.credentials()) === null) return NOT_SET_UP;
  const state = (await tg.authState())._;
  if (state !== "authorizationStateReady") return notReady(state);
  const account = await rememberAccount(tg);
  return `Signed in to Telegram as ${account.name}.`;
}

async function confirmed(
  tg: Telegram,
  ctx: ExtensionToolContext,
  title: string,
  summary: string,
  details: string,
): Promise<boolean> {
  if (tg.api.confirm === undefined)
    throw new Error("Not done: this prifly cannot show a confirm card; update prifly first.");
  return await tg.api.confirm({ title, summary, details, sessionId: ctx.session });
}

async function signOut(tg: Telegram, ctx: ExtensionToolContext): Promise<string> {
  const yes = await confirmed(
    tg,
    ctx,
    "Sign out of Telegram",
    "Sign out of Telegram in prifly and delete its local copy of your chats.",
    "TDLib logs out this device's session on Telegram and removes its database in the extension's data folder. Your api_id and api_hash stay.",
  );
  if (!yes) return CANCELLED;
  if ((await tg.credentials()) !== null && (await tg.authState())._ === "authorizationStateReady") {
    await tg.invoke({ _: "logOut" });
  }
  await tg.reset();
  await tg.api.state?.delete(ACCOUNT);
  await tg.api.state?.delete(CURSOR);
  return "Signed out of Telegram.";
}

async function forgetKeys(tg: Telegram, ctx: ExtensionToolContext): Promise<string> {
  if ((await tg.account()) !== null)
    return "Not done: sign out first (action sign_out), then forget the keys.";
  const yes = await confirmed(
    tg,
    ctx,
    "Forget Telegram api keys",
    "Remove your api_id and api_hash from prifly.",
    "They are deleted from the sealed secret store.",
  );
  if (!yes) return CANCELLED;
  await tg.reset();
  await tg.forgetCredentials();
  return "Forgot the api_id and api_hash.";
}

export function linkTool(tg: Telegram): ExtensionTool {
  return {
    name: "telegram_link",
    description:
      "Telegram account: action sign_in (asks the reader for their own api_id and api_hash from my.telegram.org the first time, then their phone number, the login code and, if set, the two-step password, each on a card the reader types into; none of it passes through you), status (default), sign_out, or forget_keys. Call sign_in again to carry on a sign-in the reader closed.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "sign_in", "sign_out", "forget_keys"],
          description: "Default status",
        },
      },
      additionalProperties: false,
    },
    call: async (args, ctx) => {
      const action = typeof args["action"] === "string" ? args["action"] : "status";
      try {
        switch (action) {
          case "status":
            return await status(tg);
          case "sign_in":
            return await signIn(tg, ctx);
          case "sign_out":
            return await signOut(tg, ctx);
          case "forget_keys":
            return await forgetKeys(tg, ctx);
          default:
            throw new Error(
              `Unknown action ${action}: use status, sign_in, sign_out or forget_keys.`,
            );
        }
      } finally {
        await refreshStatus(tg);
      }
    },
  };
}
