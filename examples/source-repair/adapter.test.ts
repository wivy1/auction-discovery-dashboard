import assert from "node:assert/strict";
import test from "node:test";
import fixture from "./fixture.json";
import { adapter } from "./adapter";
import { invokeSourceParser } from "../../lib/sources/parser-errors";

const original = fixture as { total: number; items: Array<Record<string, unknown>> };
const page = (value: unknown) => ({ url: "https://example.invalid/inventory.json", body: JSON.stringify(value), fetchedAt: "2026-01-01T00:00:00.000Z", contentType: "application/json" });
const parse = (value: unknown) => invokeSourceParser("example_json", () => adapter.parseDiscoveryBatch!(page(value)));

test("immutable example accepts source strings, including an empty description", () => {
  assert.equal(parse(original).length, 2);
  const value = structuredClone(original); value.items[0]!.description = "";
  assert.equal(parse(value)[0]!.detail!.rawDescription, "");
});

for (const [name, value] of [["number", 7], ["object", {}], ["array", []], ["missing", undefined]] as const) {
  test(`immutable description guard rejects ${name}`, () => {
    const input = structuredClone(original);
    if (name === "missing") delete input.items[0]!.description; else input.items[0]!.description = value;
    assert.throws(() => parse(input), { name: "SourceAdapterError", message: "Example listing description must be a string." });
  });
}

test("immutable identity title state and count guards remain enforced", () => {
  for (const [field, value] of [["id", "invalid"], ["title", ""], ["state", "ended"]] as const) {
    const input = structuredClone(original); input.items[0]![field] = value; assert.throws(() => parse(input));
  }
  const count = structuredClone(original); count.total = 3; assert.throws(() => parse(count));
  const duplicate = structuredClone(original); duplicate.items[1]!.id = "item-1"; assert.throws(() => parse(duplicate));
});
