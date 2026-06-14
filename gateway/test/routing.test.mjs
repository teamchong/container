import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMode, cleanMessages, extractText } from "../src/routing.mjs";

test("defaults to remote when no directive is present", () => {
  const msgs = [{ role: "user", content: "hello there" }];
  assert.equal(resolveMode(msgs), "remote");
});

test("respects a custom default mode", () => {
  assert.equal(resolveMode([{ role: "user", content: "hi" }], "local"), "local");
});

test("switches to local on @local", () => {
  const msgs = [{ role: "user", content: "@local write me a poem" }];
  assert.equal(resolveMode(msgs), "local");
});

test("is sticky: @local in an earlier turn persists across later turns", () => {
  const msgs = [
    { role: "user", content: "@local start" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "keep going" },
    { role: "assistant", content: "..." },
    { role: "user", content: "and more" },
  ];
  assert.equal(resolveMode(msgs), "local");
});

test("last directive wins: @remote after @local routes remote", () => {
  const msgs = [
    { role: "user", content: "@local one" },
    { role: "user", content: "two" },
    { role: "user", content: "@remote three" },
  ];
  assert.equal(resolveMode(msgs), "remote");
});

test("only user turns carry directives (assistant @local is ignored)", () => {
  const msgs = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "I will go @local now" },
  ];
  assert.equal(resolveMode(msgs), "remote");
});

test("reads directives from Anthropic-style block content", () => {
  const msgs = [
    { role: "user", content: [{ type: "text", text: "please @local this one" }] },
  ];
  assert.equal(resolveMode(msgs), "local");
});

test("@localhost does not trigger (word boundary)", () => {
  const msgs = [{ role: "user", content: "connect to @localhost please" }];
  assert.equal(resolveMode(msgs), "remote");
});

test("cleanMessages strips the directive from user string content", () => {
  const msgs = [{ role: "user", content: "@local write a poem" }];
  assert.equal(cleanMessages(msgs)[0].content, "write a poem");
});

test("cleanMessages strips directives inside block content", () => {
  const msgs = [
    { role: "user", content: [{ type: "text", text: "do @remote it" }] },
  ];
  assert.equal(cleanMessages(msgs)[0].content[0].text, "do it");
});

test("cleanMessages leaves assistant turns untouched", () => {
  const msgs = [{ role: "assistant", content: "no @local change here" }];
  assert.equal(cleanMessages(msgs)[0].content, "no @local change here");
});

test("extractText concatenates block text", () => {
  assert.equal(
    extractText([{ type: "text", text: "a" }, { type: "text", text: "b" }]),
    "a b",
  );
});
