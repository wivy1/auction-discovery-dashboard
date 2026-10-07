import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { applyExpressionEdits, repairExpressionInventory } from "../../lib/source-repair/expressions.ts";

const required = 'function requiredText(value: unknown, label: string): string { if (typeof value !== "string") throw new TypeError(`${label} must be a string`); return value; }\n';
const base = required + 'function normalizeListing(raw: any) { const description = requiredText(raw.description, "description"); return {id:raw.id, description}; }\nexport const adapter={normalizeListing};';
test("JSON optional text site preserves its entire validation value flow", () => {
  const inventory = repairExpressionInventory(base);
  assert.ok(inventory.supported.some((site) => site.before === "raw.description" && site.kind === "validation_data"));
  assert.ok(!inventory.supported.some((site) => site.before.includes("requiredText(")));
  const candidate = applyExpressionEdits(base, [{ before: "raw.description", after: 'raw.description === null ? "" : raw.description' }]);
  assert.equal(candidate, base.replace("requiredText(raw.description,", 'requiredText(raw.description === null ? "" : raw.description,'));
  const nested = applyExpressionEdits(base, [{ before: "raw.description", after: "raw.details.description" }]);
  assert.match(nested, /requiredText\(raw.details.description, "description"\)/u);
});
test("declarations, guard relocation and novel capabilities cannot become expressions", () => {
  for (const after of ['fetch("x")', 'process.env.KEY', 'raw.constructor("x")', '(raw.description = "x")', 'import("x")', '(()=>{return "x"})()', 'eval("x")']) {
    assert.throws(() => applyExpressionEdits(base, [{ before: "raw.description", after }]), /replacement_|helper_call/u);
  }
  for (const after of ['requiredText("ok", "description") && raw.description', '[requiredText("ok", "description"),raw.description].at(1)']) {
    assert.throws(() => applyExpressionEdits(base, [{ before: 'requiredText(raw.description, "description")', after }]), /edit_outside_supported_expression/u);
  }
});
test("protected values and backward method-receiver dependencies are excluded", () => {
  for (const tail of ["const id=title.toLowerCase(); return {title,id};", 'const chunks=title.split("|"); return {title,count:chunks.length};', "const price=+title; return {title,price};", "return {title, amount:title};", "return {['id']:title,title};", "out.id=title; return {title};", "return {[key]:title,title};"]) {
    const code = `function parseRecord(raw:any,out:any,key:any){const title=raw.title.trim();${tail}}`;
    assert.ok(!repairExpressionInventory(code).supported.some((site) => site.before === "raw.title.trim()"), tail);
  }
});
test("inline protected identity, money and count extraction literals stay frozen", () => {
  for (const field of ["id", "price", "count", "['id']"]) {
    const code = `function parseRecord(raw:any){return {${field}:raw.html.match(/item=(\w+)/)?.[1]};}`;
    assert.equal(repairExpressionInventory(code).supported.length, 0, field);
  }
});
test("content text remains adaptable while content hash expressions are immutable", () => {
  const code = 'function normalizeListing(raw:any){const description=raw.description.trim();const contentHash=stableContentHash(description);return {description,contentHash};}';
  const inventory = repairExpressionInventory(code);
  assert.ok(inventory.supported.some((site) => site.before === "raw.description.trim()"));
  assert.ok(!inventory.supported.some((site) => site.before.includes("stableContentHash")));
});
test("opaque, default-sensitive and shared-state helpers have no purity privilege", () => {
  for (const helper of [
    'const audit:any[]=[];function recordText(value:any){audit.push(value);return value;}',
    'function mark(){globalThis.audit.push(1);return "";}function recordText(value:any,fallback=mark()){return value;}',
    'const WORD=/[A-Za-z]+/g;function recordText(value:any){return WORD.exec(value)?.[0]??"";}',
  ]) { const code = `${helper}function normalizeListing(raw:any){const description=recordText(raw.description);return {description};}`; assert.equal(repairExpressionInventory(code).supported.length, 0); }
  const code = 'function cleanText(value:any){return value;}function normalizeListing(raw:any){const title=raw.title.trim();const description=cleanText(raw.description);return {title,description};}';
  assert.throws(() => applyExpressionEdits(code, [{ before: "raw.title.trim()", after: "cleanText(raw.title)" }]), /helper_call_structure_changed/u);
});
test("only canonical existing public helper paths confer imported purity", () => {
  const adapterPath = "source-adapters.local/example/adapter.ts";
  for (const path of ["../../lib/sources/parsing", "../../lib/sources/parsing.ts"]) {
    const code = `import {htmlToText} from "${path}";function normalizeListing(raw:any){const description=htmlToText(raw.description);return {description};}`;
    assert.ok(repairExpressionInventory(code, 2_000, adapterPath).supported.some((site) => site.before === "raw.description"), path);
    assert.match(applyExpressionEdits(code, [{ before: "raw.description", after: "raw.details.description" }], 2_000, adapterPath), /htmlToText\(raw.details.description\)/u);
  }
  for (const path of ["./parsing", "../../lib/sources/parsing.mts", "../../lib/sources/parsing.ts?x", "../../lib/sources/parsing-spoof", "@/lib/sources/parsing"]) {
    const code = `import {htmlToText} from "${path}";function normalizeListing(raw:any){const description=htmlToText(raw.description);return {description};}`;
    assert.equal(repairExpressionInventory(code, 2_000, adapterPath).supported.length, 0, path);
  }
});
test("the checked-in public example retains its null-text repair site", async () => {
  const code = await readFile(new URL("../../examples/source-repair/adapter.ts", import.meta.url), "utf8");
  const path = "source-adapters.local/example-json/adapter.ts";
  assert.ok(repairExpressionInventory(code, 2_000, path).supported.some((site) => site.before === "listing.description" && site.kind === "validation_data"));
  const candidate = applyExpressionEdits(code, [{ before: "listing.description", after: 'listing.description === null ? "" : listing.description' }], 2_000, path);
  assert.equal(candidate, code.replace('requiredText(listing.description, "description")', 'requiredText(listing.description === null ? "" : listing.description, "description")'));
});
