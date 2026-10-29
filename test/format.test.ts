import { afterEach, expect, test } from "bun:test";
import { describe, serviceText } from "../format";
import type { TdContent } from "../types";
import { type Setup, setup } from "./setup";

const service = (content: TdContent): string => describe(content);

test("service messages read as short text, and an unknown one names its type", () => {
  expect(service({ _: "messageContactRegistered" })).toBe("[joined Telegram]");
  expect(service({ _: "messageChatAddMembers", member_user_ids: [1, 2] })).toBe(
    "[added 2 members]",
  );
  expect(service({ _: "messageChatAddMembers", member_user_ids: [1] })).toBe("[added 1 member]");
  expect(service({ _: "messageChatJoinByLink" })).toBe("[joined the chat by invite link]");
  expect(service({ _: "messageChatDeleteMember", user_id: 3 } as TdContent)).toBe(
    "[a member left or was removed]",
  );
  expect(service({ _: "messageChatChangeTitle", title: "Crew" })).toBe(
    '[changed the chat title to "Crew"]',
  );
  expect(service({ _: "messageChatChangePhoto" })).toBe("[changed the chat photo]");
  expect(service({ _: "messagePinMessage" })).toBe("[pinned a message]");
  expect(service({ _: "messageScreenshotTaken" })).toBe("[took a screenshot]");
  expect(service({ _: "messageSomethingNew" })).toBe("[service: somethingnew]");
  expect(serviceText({ _: "messagePoll" })).toBe("[poll]");
});

test("a call shows its length, or that it was missed or declined", () => {
  const call = (extra: Partial<TdContent>) => service({ _: "messageCall", ...extra });
  expect(call({ duration: 75, discard_reason: { _: "callDiscardReasonHungUp" } })).toBe(
    "[call, 1:15]",
  );
  expect(call({ is_video: true, duration: 9 })).toBe("[video call, 0:09]");
  expect(call({ discard_reason: { _: "callDiscardReasonMissed" } })).toBe("[missed call]");
  expect(call({ is_video: true, discard_reason: { _: "callDiscardReasonDeclined" } })).toBe(
    "[declined video call]",
  );
  expect(call({})).toBe("[call]");
});

let current: Setup | undefined;
afterEach(() => current?.stop());

const LOGIN =
  "Login code: 71200. Do not give this code to anyone, even if they say they are from Telegram!";
const VARIANTS = [
  LOGIN,
  "Code: 12345",
  "Your login code: 12-345",
  "Your code is 1 2 3 4 5 6.",
  "Dein Code: 654321",
];

test("login codes from Telegram's service chat never reach chats, chat or new", async () => {
  current = await setup({ signedIn: true });
  const { td } = current;
  td.addChat(777000, "Telegram", VARIANTS, VARIANTS.length);
  td.addChat(100, "Anna", ["hej"], 1);
  const digits = /71200|12345|12-345|1 2 3 4 5|654321/;

  const chats = await current.call("telegram_chats");
  expect(chats).toContain("**Telegram**");
  expect(chats).not.toMatch(digits);
  expect(chats).toContain("[login code hidden]");

  const chat = await current.call("telegram_chat", { chat_id: 777000 });
  expect(chat).not.toMatch(digits);
  expect(chat).toContain("Login code: [login code hidden]. Do not give this code to anyone");
  expect(chat.match(/\[login code hidden\]/g)).toHaveLength(VARIANTS.length);

  const fresh = await current.call("telegram_new");
  expect(fresh).toContain("## Telegram (777000)");
  expect(fresh).not.toMatch(digits);
  expect(fresh).toContain("[login code hidden]");
});

test("a code sent by user 777000 into another chat is hidden too, and other chats keep their numbers", async () => {
  current = await setup({ signedIn: true });
  const { td } = current;
  td.addChat(100, "Anna", ["call me on 0701234567"], 0);
  td.push(100, {
    id: 900,
    sender_id: { _: "messageSenderUser", user_id: 777000 },
    content: { _: "messageText", text: { text: "Login code: 71200" } },
  });
  const chat = await current.call("telegram_chat", { chat_id: 100 });
  expect(chat).not.toContain("71200");
  expect(chat).toContain("Login code: [login code hidden]");
  expect(chat).toContain("0701234567");
  expect(await current.call("telegram_chats")).not.toContain("71200");
});

test("service messages in a chat read as text, not as [contactregistered]", async () => {
  current = await setup({ signedIn: true });
  const { td } = current;
  td.addChat(100, "Anna", ["hej"], 0);
  td.push(100, { id: 900, content: { _: "messageContactRegistered" } });
  const chat = await current.call("telegram_chat", { chat_id: 100 });
  expect(chat).toContain("[joined Telegram]");
  expect(chat).not.toContain("[contactregistered]");
  expect(await current.call("telegram_chats")).toContain("[joined Telegram]");
});
