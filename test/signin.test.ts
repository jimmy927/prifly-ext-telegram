import { afterEach, expect, test } from "bun:test";
import type { ExtensionModule } from "@prifly/extension-api";
import * as extension from "../index";
import { Telegram } from "../telegram";
import { CODE, PASSWORD } from "./fake-td";
import { type Setup, setup } from "./setup";

// The module is what prifly imports: it must fit the contract as a whole.
const module: ExtensionModule = extension;

let current: Setup | undefined;
afterEach(() => current?.stop());
async function start(...args: Parameters<typeof setup>): Promise<Setup> {
  current = await setup(...args);
  return current;
}

const KEYS = ["1234567", "0123456789abcdef0123456789abcdef"];
const PHONE = "+46701234567";

test("activate registers the six tools and the status line says Telegram is not set up", async () => {
  expect(module.choices).toBeUndefined();
  const s = await start();
  expect(s.fake.tools().map((tool) => tool.name)).toEqual([
    "telegram_chats",
    "telegram_chat",
    "telegram_new",
    "telegram_media",
    "telegram_send",
    "telegram_link",
  ]);
  expect(s.fake.statuses).toEqual(["Not set up: ask a session to link Telegram"]);
  expect(s.td.requests).toEqual([]); // nothing starts until a tool is used
});

test("a tool before the reader gave an api_id says Telegram is not set up", async () => {
  const s = await start();
  expect(await s.call("telegram_link")).toContain("my.telegram.org");
  await expect(s.call("telegram_chats")).rejects.toThrow("not set up");
});

test("sign-in: api keys, phone, code on cards; the secrets land in api.secrets only", async () => {
  const s = await start({ answers: [...KEYS, PHONE, CODE] });
  expect(await s.call("telegram_link", { action: "sign_in" })).toBe(
    "Signed in to Telegram as Ada Lovelace.",
  );
  expect(s.dialogs.map((d) => d.title)).toEqual([
    "Telegram: api_id",
    "Telegram: api_hash",
    "Telegram: phone number",
    "Telegram: login code",
  ]);
  expect(s.dialogs.every((d) => d.sessionId === "fake-session")).toBe(true);
  expect(s.secrets.get("api_id")).toBe("1234567");
  expect(s.td.given[0]).toMatchObject({ apiId: 1234567, apiHash: KEYS[1] });
  expect(s.td.given[0]?.databaseDirectory).toContain("data");
  expect(s.fake.documents.get("account")).toEqual({ id: 7, name: "Ada Lovelace" });
  expect(s.fake.statuses.at(-1)).toBe("Signed in as Ada Lovelace");
  // The code never went anywhere but TDLib: not in a log, a status or a confirm.
  const seen = JSON.stringify([s.fake.logs, s.fake.statuses, s.fake.confirms, s.dialogs]);
  expect(seen).not.toContain(CODE);
});

test("a wrong login code asks again on a card, and the right one signs in", async () => {
  const s = await start({ keys: true, answers: [PHONE, "00000", CODE] });
  expect(await s.call("telegram_link", { action: "sign_in" })).toContain("Signed in");
  const codes = s.dialogs.filter((d) => d.title === "Telegram: login code");
  expect(codes).toHaveLength(2);
  expect(codes[1]?.description).toStartWith("That login code is not right. Try again.");
});

test("three wrong codes stop the sign-in", async () => {
  const s = await start({ keys: true, answers: [PHONE, "1", "2", "3", CODE] });
  const said = await s.call("telegram_link", { action: "sign_in" });
  expect(said).toContain("Stopped after 3 tries");
  expect(s.answers).toEqual([CODE]);
});

test("two-step password: wrong, then right", async () => {
  const s = await start({
    td: { twoFactor: true },
    keys: true,
    answers: [PHONE, CODE, "nope", PASSWORD],
  });
  expect(await s.call("telegram_link", { action: "sign_in" })).toContain("Signed in");
  const asks = s.dialogs.filter((d) => d.title === "Telegram: two-step verification");
  expect(asks).toHaveLength(2);
  expect(asks[0]?.description).toContain("Hint: pet.");
  expect(asks[1]?.description).toStartWith("That two-step verification password is not right.");
});

test("a closed code card leaves Telegram waiting for the code, and sign_in carries on from there", async () => {
  const s = await start({ keys: true, answers: [PHONE, null] });
  expect(await s.call("telegram_link", { action: "sign_in" })).toContain(
    "waiting for the login code",
  );
  expect(await s.call("telegram_link")).toContain("waiting for the login code");
  await expect(s.call("telegram_chats")).rejects.toThrow("waiting for the login code");
  s.answers.push(CODE);
  expect(await s.call("telegram_link", { action: "sign_in" })).toContain("Signed in");
  expect(s.dialogs.filter((d) => d.title === "Telegram: phone number")).toHaveLength(1); // not asked again
});

test("FLOOD_WAIT on the phone step is told in minutes and not retried", async () => {
  const s = await start({
    td: { phoneError: "FLOOD_WAIT_720" },
    keys: true,
    answers: [PHONE, PHONE],
  });
  await expect(s.call("telegram_link", { action: "sign_in" })).rejects.toThrow("wait 12 minutes");
  expect(s.td.requests.filter((r) => r._ === "setAuthenticationPhoneNumber")).toHaveLength(1);
});

test("TDLib's 'retry after' flood wording is read the same way", async () => {
  const s = await start({
    td: { phoneError: "Too Many Requests: retry after 45" },
    keys: true,
    answers: [PHONE],
  });
  await expect(s.call("telegram_link", { action: "sign_in" })).rejects.toThrow("wait 45 seconds");
});

test("a bad api_id or api_hash is refused before anything starts", async () => {
  const s = await start({ answers: ["abc"] });
  expect(await s.call("telegram_link", { action: "sign_in" })).toContain("not a number");
  const t = await start({ answers: ["1234567", "short"] });
  expect(await t.call("telegram_link", { action: "sign_in" })).toContain("not 32 letters");
  expect(t.td.requests).toEqual([]);
});

test("a TDLib that cannot load and a network that does not answer are said plainly", async () => {
  const s = await start({ keys: true });
  const failing = new Telegram(s.fake.api, () => {
    throw new Error("dlopen failed");
  });
  await expect(failing.requireReady()).rejects.toThrow(
    "TDLib library could not be started: dlopen failed",
  );
  const hung = await start({ keys: true, td: { hang: true }, timeoutMs: 20 });
  await expect(hung.call("telegram_chats")).rejects.toThrow("cannot be reached");
});

test("sign_out asks first; on Cancel nothing is done", async () => {
  const no = await start({ signedIn: true, confirm: false });
  expect(await no.call("telegram_link", { action: "sign_out" })).toBe("Not done: you cancelled");
  expect(no.td.requests.some((r) => r._ === "logOut")).toBe(false);
  const yes = await start({ signedIn: true });
  expect(await yes.call("telegram_link", { action: "sign_out" })).toBe("Signed out of Telegram.");
  expect(yes.td.requests.some((r) => r._ === "logOut")).toBe(true);
  expect(yes.fake.documents.has("account")).toBe(false);
  expect(yes.fake.statuses.at(-1)).toBe("Not signed in: ask a session to link Telegram");
  expect(yes.secrets.get("api_id")).toBe("1234567");
});
