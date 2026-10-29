import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MOST_PER_HOUR } from "../send";
import { type Setup, type SetupOptions, setup } from "./setup";

let current: Setup | undefined;
afterEach(() => current?.stop());
async function ready(options: SetupOptions = {}): Promise<Setup> {
  current = await setup({ signedIn: true, ...options });
  current.td.addChat(
    100,
    "Anna",
    ["hej", "how are you", "fine", "ok", "bye", "later", "end"],
    2,
    [1],
  );
  current.td.addChat(200, "Team", ["standup at 10"], 0);
  return current;
}

test("every tool says Telegram is not signed in when it is not", async () => {
  current = await setup({ keys: true });
  for (const [name, args] of [
    ["telegram_chats", {}],
    ["telegram_chat", { chat_id: 100 }],
    ["telegram_new", {}],
    ["telegram_media", { chat_id: 100, message_id: 100 }],
    ["telegram_send", { chat_id: 100, text: "hi" }],
  ] as const) {
    await expect(current.call(name, args)).rejects.toThrow("not signed in");
  }
  expect(current.td.sent()).toEqual([]);
});

test("telegram_chats lists chats with ids and unread, narrows by query, and says when empty", async () => {
  const s = await ready();
  const all = await s.call("telegram_chats");
  expect(all).toContain("**Anna** (person) `100`");
  expect(all).toContain("2 unread");
  expect(all).toContain("**Team**");
  const some = await s.call("telegram_chats", { query: "Tea" });
  expect(some).toContain("Team");
  expect(some).not.toContain("Anna");
  expect(await s.call("telegram_chats", { query: "nobody" })).toBe('No chat matches "nobody".');
  s.td.chats.clear();
  expect(await s.call("telegram_chats")).toBe("No chats.");
});

test("telegram_chat reads the newest page oldest-first and pages back by from_message_id", async () => {
  const s = await ready();
  const first = await s.call("telegram_chat", { chat_id: 100, limit: 3 });
  expect(first).toContain("## Anna (100)");
  const order = ["`#500`", "`#600`", "`#700`"].map((id) => first.indexOf(id));
  expect(order.every((at) => at > 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(first).toContain("Older messages: from_message_id=500");
  const second = await s.call("telegram_chat", { chat_id: 100, limit: 3, from_message_id: 500 });
  expect(second).toContain("`#200`");
  expect(second).toContain("`#400`");
  expect(second).not.toContain("`#500`");
  expect(second).toContain("**Me**"); // message index 1 (#200) was sent by the reader
  expect(await s.call("telegram_chat", { chat_id: 100, from_message_id: 100 })).toBe(
    "No older messages in Anna (100) than #100.",
  );
  // The chat is never marked as viewed: reading sends no receipt.
  expect(s.td.requests.some((r) => r._ === "viewMessages")).toBe(false);
});

test("telegram_chat asks again when TDLib answers with fewer messages than asked", async () => {
  const s = await ready({ td: { pageCap: 2 } });
  const text = await s.call("telegram_chat", { chat_id: 100, limit: 5 });
  for (const id of [300, 400, 500, 600, 700]) expect(text).toContain(`\`#${id}\``);
  expect(text).not.toContain("`#200`");
  expect(s.td.requests.filter((r) => r._ === "getChatHistory").length).toBeGreaterThan(1);
});

test("a chat_id that is a name or a list is refused", async () => {
  const s = await ready();
  await expect(s.call("telegram_chat", { chat_id: "Anna" })).rejects.toThrow(
    "chat_id must be one number",
  );
  await expect(s.call("telegram_chat", { chat_id: [100, 200] })).rejects.toThrow(
    "chat_id must be one number",
  );
});

test("telegram_new shows the unread first, then only what arrived since, and never outgoing", async () => {
  const s = await ready();
  const first = await s.call("telegram_new");
  expect(first).toContain("## Anna (100) · 2 new");
  expect(first).toContain("`#700`");
  expect(first).not.toContain("Team");
  expect(await s.call("telegram_new")).toBe("No new messages.");
  expect(s.fake.documents.get("cursor")).toEqual({ "100": 700, "200": 100 });

  s.td.push(100, { id: 800, content: { _: "messageText", text: { text: "are you there?" } } });
  s.td.push(100, {
    id: 900,
    is_outgoing: true,
    content: { _: "messageText", text: { text: "yes" } },
  });
  s.td.push(200, { id: 150, content: { _: "messageText", text: { text: "lunch?" } } });
  const next = await s.call("telegram_new");
  expect(next).toContain("are you there?");
  expect(next).toContain("lunch?");
  expect(next).not.toContain("`#900`");
  expect(next).not.toContain("`#700`");
  expect(await s.call("telegram_new")).toBe("No new messages.");
});

test("telegram_media saves the file under the session's scratchpad and returns the path", async () => {
  const s = await ready();
  s.td.push(100, {
    id: 1000,
    content: {
      _: "messageDocument",
      document: { file_name: "report.pdf", document: { id: 1, size: 10 } },
      caption: { text: "the report" },
    },
  });
  const said = await s.call("telegram_media", { chat_id: 100, message_id: 1000 });
  const path = said.replace(/^Saved the file of message #1000 to /, "");
  expect(path).toContain(join("telegram", "100", "1000-report.pdf"));
  expect(readFileSync(path, "utf8")).toBe("file bytes");
  expect(s.td.requests.find((r) => r._ === "downloadFile")).toMatchObject({
    file_id: 1,
    synchronous: true,
  });
  await expect(s.call("telegram_media", { chat_id: 100, message_id: 700 })).rejects.toThrow(
    "carries no picture or file",
  );
  s.td.push(100, {
    id: 1100,
    content: { _: "messagePhoto", photo: { sizes: [{ photo: { id: 5, size: 500_000_000 } }] } },
  });
  await expect(s.call("telegram_media", { chat_id: 100, message_id: 1100 })).rejects.toThrow(
    "over 100 MB",
  );
});

test("telegram_send shows the recipient and exact text on a card, sends only on Confirm, to one chat", async () => {
  const s = await ready();
  const said = await s.call("telegram_send", { chat_id: 100, text: "  See you at 5  " });
  expect(said).toBe("Sent to Anna (100). Message id: #9001");
  expect(s.fake.confirms).toHaveLength(1);
  const card = s.fake.confirms[0];
  expect(card?.summary).toBe("Send a Telegram message to Anna.");
  expect(card?.content).toBe("To: Anna (chat id 100)\n\nSee you at 5");
  expect(card?.session).toBe("fake-session");
  expect(s.td.sent()).toEqual([
    {
      _: "sendMessage",
      chat_id: 100,
      input_message_content: {
        _: "inputMessageText",
        text: { _: "formattedText", text: "See you at 5" },
      },
    },
  ]);
});

test("a cancelled send says exactly 'Not done: you cancelled' and sends nothing", async () => {
  const s = await ready({ confirm: false });
  expect(await s.call("telegram_send", { chat_id: 100, text: "hi" })).toBe(
    "Not done: you cancelled",
  );
  expect(s.td.sent()).toEqual([]);
  const edit = await ready({ edit: null });
  expect(await edit.call("telegram_send", { chat_id: 100, text: "hi" })).toBe(
    "Not done: you cancelled",
  );
  expect(edit.td.sent()).toEqual([]);
});

test("one recipient per call: a list, a name and a number-and-text mix are refused before any card", async () => {
  const s = await ready();
  for (const chat_id of [[100, 200], "100,200", "Anna", 0]) {
    await expect(s.call("telegram_send", { chat_id, text: "hi" })).rejects.toThrow(
      "chat_id must be one number",
    );
  }
  expect(s.fake.confirms).toEqual([]);
  expect(s.td.sent()).toEqual([]);
});

test("a send needs an earlier conversation and a chat you can write in", async () => {
  const s = await ready();
  s.td.addChat(300, "Stranger", []);
  await expect(s.call("telegram_send", { chat_id: 300, text: "hi" })).rejects.toThrow(
    "never starts a conversation",
  );
  s.td.addChat(200, "Team", ["standup at 10"]);
  const team = s.td.chats.get(200);
  if (team) s.td.chats.set(200, { ...team, permissions: { can_send_basic_messages: false } });
  await expect(s.call("telegram_send", { chat_id: 200, text: "hi" })).rejects.toThrow(
    "cannot write in Team",
  );
  await expect(s.call("telegram_send", { chat_id: 100 })).rejects.toThrow(
    "give a text, a file, or both",
  );
  expect(s.fake.confirms).toEqual([]);
});

test("the reader's edit on the card is what goes out, and the session is told", async () => {
  const s = await ready({ edit: "Make it 6" });
  const said = await s.call("telegram_send", { chat_id: 100, text: "See you at 5" });
  expect(said).toContain("Message id: #9001");
  expect(said).toContain(
    "The reader edited the text before it was sent. The text sent:\nMake it 6",
  );
  expect(s.edits[0]?.content).toBe("See you at 5");
  expect(s.edits[0]?.details).toContain("Anna (chat id 100)");
  expect(JSON.stringify(s.td.sent())).toContain("Make it 6");
  const empty = await ready({ edit: "" });
  expect(await empty.call("telegram_send", { chat_id: 100, text: "x" })).toContain(
    "you emptied the message",
  );
  expect(empty.td.sent()).toEqual([]);
});

test("a file goes with its caption as a document, a picture as a photo; the card names file and caption", async () => {
  const s = await ready();
  const doc = join(s.td.folder, "report.pdf");
  writeFileSync(doc, "pdf");
  await s.call("telegram_send", { chat_id: 100, file: doc, text: "the report" });
  expect(s.fake.confirms[0]?.title).toBe("Send a file on Telegram");
  expect(s.fake.confirms[0]?.content).toBe(
    "To: Anna (chat id 100)\nFile: report.pdf\nCaption:\nthe report",
  );
  expect(s.td.sent()[0]).toMatchObject({
    input_message_content: {
      _: "inputMessageDocument",
      document: { _: "inputDocument", document: { _: "inputFileLocal", path: doc } },
      caption: { text: "the report" },
    },
  });
  const pic = join(s.td.folder, "x.png");
  writeFileSync(pic, "png");
  await s.call("telegram_send", { chat_id: 100, file: pic });
  expect(s.td.sent()[1]).toMatchObject({
    input_message_content: {
      _: "inputMessagePhoto",
      photo: { _: "inputPhoto", photo: { _: "inputFileLocal", path: pic } },
    },
  });
  await expect(
    s.call("telegram_send", { chat_id: 100, file: join(s.td.folder, "missing.bin") }),
  ).rejects.toThrow("cannot read the file");
  expect(existsSync(doc)).toBe(true);
});

test("a send Telegram refuses is reported, and a flood wait is told in words", async () => {
  const s = await ready({ td: { send: { fail: "FLOOD_WAIT_3700" } } });
  await expect(s.call("telegram_send", { chat_id: 100, text: "hi" })).rejects.toThrow(
    "wait 62 minutes",
  );
});

test("a send Telegram does not confirm is not claimed as sent, and says not to resend", async () => {
  const s = await ready({ td: { send: "never" } });
  const said = await s.call("telegram_send", { chat_id: 100, text: "hi" });
  expect(said).toContain("has not confirmed delivery yet. Do not send it again");
  expect(said).not.toContain("Sent to");
});

test("sends are capped per hour, far above what a person confirms by hand", async () => {
  const s = await ready();
  for (let i = 0; i < MOST_PER_HOUR; i++)
    await s.call("telegram_send", { chat_id: 100, text: `m${i}` });
  await expect(s.call("telegram_send", { chat_id: 100, text: "one more" })).rejects.toThrow(
    "does not allow bulk messaging",
  );
  expect(s.td.sent()).toHaveLength(MOST_PER_HOUR);
});
