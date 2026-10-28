/**
 * What TDLib's errors mean to the reader. Telegram's flood limits are never
 * retried here: the message says how long to wait and the call ends.
 */

/** "45 seconds", "12 minutes", "3 hours 20 minutes": a wait in words. */
export function humanWait(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  if (s < 90) return `${s} second${s === 1 ? "" : "s"}`;
  const minutes = Math.round(s / 60);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hoursText = `${hours} hour${hours === 1 ? "" : "s"}`;
  return rest === 0 ? hoursText : `${hoursText} ${rest} minutes`;
}

/** The seconds Telegram asks to wait, from `FLOOD_WAIT_n` or TDLib's "retry after n", else null. */
export function floodSeconds(message: string): number | null {
  const found = /FLOOD_WAIT_(\d+)/.exec(message) ?? /retry after (\d+)/i.exec(message);
  return found?.[1] === undefined ? null : Number(found[1]);
}

/** TDLib's own codes for a login step that went wrong. */
export type LoginFault = "code" | "code-expired" | "password" | "phone";

export function loginFault(message: string): LoginFault | null {
  if (message.includes("PHONE_CODE_INVALID") || message.includes("PHONE_CODE_EMPTY")) return "code";
  if (message.includes("PHONE_CODE_EXPIRED")) return "code-expired";
  if (message.includes("PASSWORD_HASH_INVALID")) return "password";
  if (message.includes("PHONE_NUMBER_INVALID")) return "phone";
  return null;
}

const NETWORK = /ECONN|ENOTFOUND|ETIMEDOUT|network|Connection|timed out|did not answer/i;

/** An error from TDLib or the binding, in words for the reader. */
export function explain(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : String(caught);
  const wait = floodSeconds(message);
  if (wait !== null) {
    return `Telegram asks you to wait ${humanWait(wait)} before trying that again (flood limit). Nothing was retried; try again after that.`;
  }
  switch (loginFault(message)) {
    case "code":
      return "That login code is not right.";
    case "code-expired":
      return "That login code has expired. Start the sign-in again to get a new one.";
    case "password":
      return "That two-step verification password is not right.";
    case "phone":
      return "Telegram does not accept that phone number. Use the international form, like +46701234567.";
    case null:
      break;
  }
  if (NETWORK.test(message)) {
    return `Telegram cannot be reached (${message}). Check the internet connection and try again.`;
  }
  return message;
}
