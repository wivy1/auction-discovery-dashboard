import ts from "typescript";
import { posix } from "node:path";

const TEXT_FIELD = /^(?:(?:raw|clean|normalized|trimmed|visible)?(?:title|summary|description|text|content)(?:s|html|text|body)?|(?:title|summary|description|text|content)(?:raw|clean))$/iu;
const PROTECTED = /(?:^|[^a-z])(?:id|uuid|uid|url|uri|href|src|host|access|permission|status|state|current|ended|expired|time|date|count|length|category|categories|currency|location|address|hash|provenance|source|expected|planned|identity|request|traversal|inventory|publication|lease|checkpoint|stub|price|amount|bid|bids|money|cost)(?:$|[^a-z])|(?:Id|Uuid|Uid|Url|Uri|Host|Status|State|At|Count|Length|Category|Currency|Location|Address|Hash|Identity|Request|Traversal|Inventory|Lease|Checkpoint|Price|Amount|AmountMinor|Bid|Bids|Money|Cost)$/u;
const FORBIDDEN = /^(?:__proto__|prototype|constructor|process|global|globalThis|require|eval|Function|fetch|window|document|navigator|Deno|Bun|WebAssembly|XMLHttpRequest|import|module|exports|setTimeout|setInterval|Buffer|console)$/u;
const PURE_METHODS = new Set(["match", "matchAll", "querySelector", "querySelectorAll", "getAttribute", "trim", "trimStart", "trimEnd", "toLowerCase", "toUpperCase", "replace", "replaceAll", "slice", "substring", "split", "join", "concat", "includes", "startsWith", "endsWith", "indexOf", "at", "map", "filter"]);
const EXTRACTION = new Set(["match", "matchAll", "querySelector", "querySelectorAll"]);
const VALIDATOR = /^(?:required|nullable|assert|validate|ensure)/u;
const CONTENT_HASH = /^(?:content|sourceContent|detailContent)Hash$/u;
const ASSIGNMENTS = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.CaretEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken]);
const PURE_IMPORTS: Readonly<Record<string, ReadonlySet<string>>> = {
  "lib/sources/parsing.ts": new Set(["htmlToText", "cleanNullableText"]),
  "lib/domain/item-text.ts": new Set(["canonicalItemDescription"]),
};
function trustedImport(adapterPath: string | undefined, specifier: string): string | undefined {
  if (!adapterPath || !specifier.startsWith(".") || /[\\\0?#]/u.test(specifier) || posix.isAbsolute(adapterPath)) return undefined;
  const path = posix.normalize(posix.join(posix.dirname(adapterPath), specifier));
  if (path.startsWith("../") || path.startsWith("/")) return undefined;
  return path.endsWith(".ts") ? path : posix.extname(path) ? undefined : `${path}.ts`;
}

interface Context {
  name: string; node: ts.FunctionDeclaration | ts.MethodDeclaration; body: ts.Block;
  roots: Set<string>; calls: Set<string>; pureCalls: Set<string>; protectedValues: Set<string>;
  mutation: boolean; uncertainComputedSink: boolean;
}
export interface RepairExpressionSite {
  before: string; start: number; end: number; functionName: string; field: string;
  kind: "text_initializer" | "validation_data" | "helper_data" | "extraction_literal";
  functionContext: string; helperContext: string[];
}
export interface RepairExpressionInventory {
  supported: RepairExpressionSite[];
  unavailable: Array<{ functionName: string; field: string; reason: string }>;
}
function identifierName(name: ts.PropertyName | undefined): string {
  if (!name) return "";
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    let value = name.expression;
    while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value)) value = value.expression;
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) || ts.isNumericLiteral(value)) return value.text;
  }
  return "";
}
const synchronous = (node: ts.FunctionDeclaration | ts.MethodDeclaration) => !node.asteriskToken && !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
const isEligibleFunction = (node: ts.Node): node is ts.FunctionDeclaration | ts.MethodDeclaration =>
  (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && /^(?:parse|normalize|extract)/u.test(identifierName(node.name));
function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => ts.isBindingElement(element) ? bindingNames(element.name) : []);
}
function memberPath(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) { const root = memberPath(node.expression); return root ? `${root}.${node.name.text}` : undefined; }
  if (ts.isElementAccessExpression(node) && node.argumentExpression && (ts.isStringLiteral(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression))) {
    const root = memberPath(node.expression); return root ? `${root}.${node.argumentExpression.text}` : undefined;
  }
  return undefined;
}
function valueReferences(node: ts.Node): Set<string> {
  const values = new Set<string>();
  const visit = (current: ts.Node) => {
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const path = memberPath(current); if (path) { values.add(path); return; }
    }
    if (ts.isCallExpression(current)) {
      if (ts.isPropertyAccessExpression(current.expression)) visit(current.expression.expression);
      // Validator diagnostics are immutable metadata, not data dependencies.
      const args = ts.isIdentifier(current.expression) && VALIDATOR.test(current.expression.text) ? current.arguments.slice(0, 1) : current.arguments;
      args.forEach(visit); return;
    }
    if (ts.isIdentifier(current)) { values.add(current.text); return; }
    ts.forEachChild(current, visit);
  };
  visit(node); return values;
}
function bodyWalk(body: ts.Block, callback: (node: ts.Node) => void): void {
  const visit = (node: ts.Node) => {
    if (node !== body && ts.isFunctionLike(node)) return;
    callback(node); ts.forEachChild(node, visit);
  };
  visit(body);
}
function pureHelperContracts(source: ts.SourceFile, adapterPath?: string): Set<string> {
  const proven = new Set<string>(); const errors = new Set(["Error", "TypeError", "RangeError"]);
  const constants = new Set<string>(); const declarations = new Map<string, ts.FunctionDeclaration>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) declarations.set(statement.name.text, statement);
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
      for (const element of statement.importClause.namedBindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        const resolved = trustedImport(adapterPath, statement.moduleSpecifier.text);
        if (resolved && PURE_IMPORTS[resolved]?.has(imported)) proven.add(element.name.text);
        if (resolved === "lib/sources/types.ts" && imported === "SourceAdapterError") errors.add(element.name.text);
      }
    }
    if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) for (const declaration of statement.declarationList.declarations) {
      let value = declaration.initializer;
      while (value && (ts.isAsExpression(value) || ts.isParenthesizedExpression(value))) value = value.expression;
      // A const binding does not make a shared object (including RegExp)
      // immutable. Only scalar captures can establish a pure helper contract.
      if (ts.isIdentifier(declaration.name) && value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) || ts.isNumericLiteral(value) ||
        [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(value.kind))) constants.add(declaration.name.text);
    }
  }
  const visiting = new Set<string>(); const denied = new Set<string>();
  const prove = (name: string): boolean => {
    if (proven.has(name)) return true;
    const declaration = declarations.get(name);
    if (!declaration?.body || !synchronous(declaration) || declaration.parameters.some((parameter) => parameter.initializer || !ts.isIdentifier(parameter.name)) || visiting.has(name) || denied.has(name)) return false;
    visiting.add(name);
    const locals = new Set(declaration.parameters.flatMap((parameter) => bindingNames(parameter.name)));
    bodyWalk(declaration.body, (node) => { if (ts.isVariableDeclaration(node)) bindingNames(node.name).forEach((value) => locals.add(value)); });
    const safe = (node: ts.Node): boolean => {
      if (ts.isTypeNode(node)) return true;
      if (ts.isBinaryExpression(node) && ASSIGNMENTS.has(node.operatorToken.kind) || ts.isPostfixUnaryExpression(node) ||
        ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) ||
        ts.isDeleteExpression(node) || ts.isAwaitExpression(node) || ts.isYieldExpression(node) || ts.isWithStatement(node) || ts.isClassDeclaration(node)) return false;
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression)) { if (!prove(node.expression.text)) return false; }
        else if (ts.isPropertyAccessExpression(node.expression)) {
          const callee = node.expression.getText(source);
          if (!/^(?:Array\.isArray|JSON\.parse|JSON\.stringify|Object\.(?:keys|values|entries))$/u.test(callee) &&
            (!PURE_METHODS.has(node.expression.name.text) && !["test", "exec"].includes(node.expression.name.text) || !safe(node.expression.expression))) return false;
        } else return false;
        return node.arguments.every(safe);
      }
      if (ts.isNewExpression(node)) return ts.isIdentifier(node.expression) && errors.has(node.expression.text) && !declarations.has(node.expression.text) && (node.arguments ?? []).every(safe);
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        if (ts.isPropertyAccessExpression(parent) && parent.name === node || ts.isPropertyAssignment(parent) && parent.name === node ||
          ts.isVariableDeclaration(parent) && parent.name === node || ts.isParameter(parent) && parent.name === node || ts.isBindingElement(parent)) return true;
        return !FORBIDDEN.test(node.text) && (node.text === "undefined" || locals.has(node.text) || constants.has(node.text));
      }
      let result = true; ts.forEachChild(node, (child) => { if (!safe(child)) result = false; }); return result;
    };
    const result = safe(declaration.body); visiting.delete(name);
    if (result) proven.add(name); else denied.add(name);
    return result;
  };
  declarations.forEach((_declaration, name) => prove(name));
  return proven;
}
function makeContext(node: ts.FunctionDeclaration | ts.MethodDeclaration, source: ts.SourceFile, pureCalls: Set<string>): Context {
  const roots = new Set(node.parameters.flatMap((parameter) => bindingNames(parameter.name)));
  const calls = new Set<string>(); const protectedValues = new Set<string>();
  const dependencies = new Map<string, Set<string>>();
  const aliases = new Map<string, string>();
  let mutation = false; let uncertainComputedSink = false;
  const findMutation = (current: ts.Node) => {
    if (ts.isBinaryExpression(current) && ASSIGNMENTS.has(current.operatorToken.kind) || ts.isPostfixUnaryExpression(current) ||
      ts.isPrefixUnaryExpression(current) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(current.operator) || ts.isDeleteExpression(current) ||
      ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression) && /^(?:push|pop|shift|unshift|splice|sort|reverse|set|add|delete|clear|assign|defineProperty)$/u.test(current.expression.name.text)) mutation = true;
    ts.forEachChild(current, findMutation);
  };
  findMutation(node.body!);
  bodyWalk(node.body!, (current) => {
    if (ts.isPropertyAssignment(current) && ts.isComputedPropertyName(current.name) && !identifierName(current.name)) uncertainComputedSink = true;
    if (ts.isVariableDeclaration(current)) {
      for (const name of bindingNames(current.name)) {
        roots.add(name);
        // Content hash expressions remain immutable, but hashing textual facts
        // does not make those facts an identity/traversal dependency.
        if (current.initializer && !CONTENT_HASH.test(name)) {
          let alias = memberPath(current.initializer);
          if (alias && ts.isObjectBindingPattern(current.name)) {
            const element = current.name.elements.find((item) => ts.isIdentifier(item.name) && item.name.text === name);
            if (element) alias += `.${identifierName(element.propertyName) || name}`;
            else alias = undefined;
          } else if (!ts.isIdentifier(current.name)) alias = undefined;
          if (alias) { aliases.set(name, alias); dependencies.set(name, new Set([alias])); }
          else dependencies.set(name, valueReferences(current.initializer));
        }
        if (PROTECTED.test(name)) protectedValues.add(name);
      }
    }
    if (ts.isCallExpression(current)) {
      calls.add(current.expression.getText(source));
      const parent = current.parent;
      const contentHash = (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) && CONTENT_HASH.test(parent.name.text)) ||
        (ts.isPropertyAssignment(parent) && CONTENT_HASH.test(identifierName(parent.name)));
      if (!contentHash && PROTECTED.test(current.expression.getText(source))) valueReferences(current).forEach((value) => protectedValues.add(value));
    }
    if ((ts.isIfStatement(current) || ts.isThrowStatement(current)) && PROTECTED.test(current.getText(source))) {
      valueReferences(ts.isIfStatement(current) ? current.expression : current.expression).forEach((value) => protectedValues.add(value));
    }
    if (ts.isPropertyAssignment(current) && PROTECTED.test(identifierName(current.name)) && !CONTENT_HASH.test(identifierName(current.name))) valueReferences(current.initializer).forEach((value) => protectedValues.add(value));
  });
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, values] of dependencies) for (const protectedValue of [...protectedValues]) if (protectedValue === name || protectedValue.startsWith(`${name}.`)) {
      const alias = aliases.get(name);
      const inputs = protectedValue !== name && alias ? [alias + protectedValue.slice(name.length)] : [...values];
      if (!alias && !protectedValues.has(name)) { protectedValues.add(name); changed = true; }
      for (const value of inputs) if (!protectedValues.has(value)) { protectedValues.add(value); changed = true; }
    }
  }
  return { name: identifierName(node.name), node, body: node.body!, roots, calls, pureCalls, protectedValues, mutation, uncertainComputedSink };
}
function protectedDependencies(expression: ts.Expression, context: Context, field: string): string[] {
  if ([...context.protectedValues].some((value) => value === field || value.startsWith(`${field}.`))) return [field];
  return [...valueReferences(expression)].filter((value) => value.split(".").some((part) => PROTECTED.test(part)) ||
    [...context.protectedValues].some((protectedValue) => value === protectedValue || value.startsWith(`${protectedValue}.`)));
}
function protectedDependency(expression: ts.Expression, context: Context, field: string): boolean {
  return protectedDependencies(expression, context, field).length > 0;
}
function protectedAncestor(expression: ts.Expression, context: Context, field: string): string | undefined {
  for (let node = expression.parent; node && node !== context.body; node = node.parent) {
    if (ts.isPropertyAssignment(node)) {
      const name = identifierName(node.name);
      if (PROTECTED.test(name) && !CONTENT_HASH.test(name)) return name;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && PROTECTED.test(node.name.text) && !CONTENT_HASH.test(node.name.text)) return node.name.text;
    if (ts.isCallExpression(node)) {
      const dependencies = protectedDependencies(node, context, field);
      if (dependencies.length) return dependencies.join(",");
    }
  }
  return undefined;
}
function validatorCalls(expression: ts.Expression, source: ts.SourceFile): string[] {
  const result: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && VALIDATOR.test(node.expression.text)) {
      const conditionalContext: string[] = [];
      let child: ts.Node = node;
      for (let parent = node.parent; parent && parent !== expression.parent; child = parent, parent = parent.parent) {
        if (ts.isConditionalExpression(parent)) conditionalContext.push(`${parent.condition.getText(source)}:${child === parent.whenTrue ? "true" : child === parent.whenFalse ? "false" : "condition"}`);
        if (ts.isBinaryExpression(parent) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(parent.operatorToken.kind) && child === parent.right) conditionalContext.push(`${parent.left.getText(source)}:${parent.operatorToken.getText(source)}`);
        if (ts.isArrowFunction(parent)) conditionalContext.push("deferred_callback");
      }
      result.push(JSON.stringify({ callee: node.expression.getText(source), typeArguments: node.typeArguments?.map((argument) => argument.getText(source)),
        diagnostics: node.arguments.slice(1).map((argument) => argument.getText(source)), conditionalContext }));
    }
    ts.forEachChild(node, visit);
  };
  visit(expression); return result.sort();
}
function identifierCalls(expression: ts.Expression, source: ts.SourceFile): string[] {
  const result: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) result.push(JSON.stringify({ callee: node.expression.getText(source), arity: node.arguments.length,
      types: node.typeArguments?.map((argument) => argument.getText(source)) }));
    ts.forEachChild(node, visit);
  };
  visit(expression); return result.sort();
}
function pureExpression(node: ts.Expression, context: Context, source: ts.SourceFile, callbackRoots = new Set<string>()): boolean {
  if (ts.isIdentifier(node)) return !FORBIDDEN.test(node.text) && !PROTECTED.test(node.text) && (context.roots.has(node.text) || callbackRoots.has(node.text));
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return !/https?:\/\/|\b(?:constructor|__proto__|prototype)\b/u.test(node.text);
  if (ts.isRegularExpressionLiteral(node)) return !/https?:|host|permission|current|expired|ended|status|identity|uuid|token|cookie|authorization/iu.test(node.getText(source));
  if (ts.isNumericLiteral(node) || [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(node.kind)) return true;
  if (ts.isParenthesizedExpression(node)) return pureExpression(node.expression, context, source, callbackRoots);
  if (ts.isPropertyAccessExpression(node)) return !FORBIDDEN.test(node.name.text) && !PROTECTED.test(node.name.text) && pureExpression(node.expression, context, source, callbackRoots);
  if (ts.isElementAccessExpression(node)) return Boolean(node.argumentExpression && (ts.isStringLiteral(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)) &&
    !FORBIDDEN.test(node.argumentExpression.text) && !PROTECTED.test(node.argumentExpression.text) && pureExpression(node.expression, context, source, callbackRoots));
  if (ts.isTypeOfExpression(node)) return pureExpression(node.expression, context, source, callbackRoots);
  if (ts.isPrefixUnaryExpression(node)) return [ts.SyntaxKind.ExclamationToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken].includes(node.operator) && pureExpression(node.operand, context, source, callbackRoots);
  if (ts.isBinaryExpression(node)) return [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken,
    ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
    ts.SyntaxKind.PlusToken].includes(node.operatorToken.kind) && pureExpression(node.left, context, source, callbackRoots) && pureExpression(node.right, context, source, callbackRoots);
  if (ts.isConditionalExpression(node)) return pureExpression(node.condition, context, source, callbackRoots) && pureExpression(node.whenTrue, context, source, callbackRoots) && pureExpression(node.whenFalse, context, source, callbackRoots);
  if (ts.isArrayLiteralExpression(node)) return node.elements.every((element) => ts.isSpreadElement(element) ? pureExpression(element.expression, context, source, callbackRoots) : pureExpression(element, context, source, callbackRoots));
  if (ts.isTemplateExpression(node)) return node.templateSpans.every((span) => pureExpression(span.expression, context, source, callbackRoots));
  if (ts.isArrowFunction(node)) {
    if (node.modifiers?.length || ts.isBlock(node.body) || node.parameters.some((parameter) => !ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken)) return false;
    return pureExpression(node.body, context, source, new Set([...callbackRoots, ...node.parameters.map((parameter) => (parameter.name as ts.Identifier).text)]));
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression.getText(source);
    if (ts.isIdentifier(node.expression)) {
      if (FORBIDDEN.test(node.expression.text) || PROTECTED.test(node.expression.text) || !context.calls.has(callee) || !context.pureCalls.has(callee)) return false;
      const args = VALIDATOR.test(node.expression.text) ? node.arguments.slice(0, 1) : node.arguments;
      return args.every((argument) => pureExpression(argument, context, source, callbackRoots));
    }
    if (ts.isPropertyAccessExpression(node.expression) && PURE_METHODS.has(node.expression.name.text)) {
      return pureExpression(node.expression.expression, context, source, callbackRoots) && node.arguments.every((argument) => pureExpression(argument, context, source, callbackRoots));
    }
    // Existing pure intrinsic calls may remain; no novel namespace capabilities.
    if (context.calls.has(callee) && /^(?:Array\.isArray|JSON\.parse|JSON\.stringify)$/u.test(callee)) return node.arguments.every((argument) => pureExpression(argument, context, source, callbackRoots));
  }
  return false;
}
function parseExpression(text: string): { source: ts.SourceFile; expression: ts.Expression } {
  const source = ts.createSourceFile("repair-expression.ts", `const value = ${text};`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  const statement = source.statements[0]; const expression = statement && ts.isVariableStatement(statement) ? statement.declarationList.declarations[0]?.initializer : undefined;
  if (diagnostics.length || source.statements.length !== 1 || !expression || expression.getText(source) !== text) throw new Error("replacement_not_closed_expression");
  return { source, expression };
}
function scan(text: string, adapterPath?: string): { source: ts.SourceFile; contexts: Context[] } {
  const source = ts.createSourceFile("adapter.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const contexts: Context[] = [];
  const pureCalls = pureHelperContracts(source, adapterPath);
  const visit = (node: ts.Node) => {
    if (isEligibleFunction(node) && node.body && synchronous(node) && !PROTECTED.test(identifierName(node.name).replace(/^(?:parse|normalize|extract)/u, ""))) contexts.push(makeContext(node, source, pureCalls));
    ts.forEachChild(node, visit);
  };
  visit(source); return { source, contexts };
}
export function repairExpressionInventory(text: string, maximumBytes = 2_000, adapterPath?: string): RepairExpressionInventory {
  const { source, contexts } = scan(text, adapterPath); const supported: RepairExpressionSite[] = []; const unavailable: RepairExpressionInventory["unavailable"] = [];
  const declarations = new Map<string, ts.FunctionDeclaration>();
  source.statements.forEach((statement) => { if (ts.isFunctionDeclaration(statement) && statement.name) declarations.set(statement.name.text, statement); });
  for (const context of contexts) {
    const add = (expression: ts.Expression, field: string, kind: RepairExpressionSite["kind"]) => {
      const before = expression.getText(source); const ancestor = protectedAncestor(expression, context, field); let reason: string | undefined;
      if (Buffer.byteLength(before) > maximumBytes) reason = "expression_byte_limit";
      else if (context.mutation) reason = "function_mutation_flow_unavailable";
      else if (context.uncertainComputedSink) reason = "uncertain_computed_sink";
      else if (text.indexOf(before) !== text.lastIndexOf(before)) reason = "expression_not_unique";
      else if (ancestor) reason = `protected_ancestor:${ancestor}`;
      else if (protectedDependency(expression, context, field)) reason = `protected_dependency:${protectedDependencies(expression, context, field).join(",")}`;
      else if (!pureExpression(expression, context, source)) reason = "unsupported_expression_grammar";
      if (reason) { unavailable.push({ functionName: context.name, field, reason }); return; }
      const helpers: string[] = [];
      const visitHelper = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) { const declaration = declarations.get(node.expression.text); if (declaration) helpers.push(declaration.getText(source)); }
        ts.forEachChild(node, visitHelper);
      };
      visitHelper(expression);
      if (["validation_data", "helper_data"].includes(kind) && ts.isCallExpression(expression.parent) && ts.isIdentifier(expression.parent.expression)) {
        const helper = declarations.get(expression.parent.expression.text); if (helper) helpers.push(helper.getText(source));
      }
      supported.push({ before, start: expression.getStart(source), end: expression.end, functionName: context.name, field, kind,
        functionContext: context.node.getText(source), helperContext: [...new Set(helpers)] });
    };
    bodyWalk(context.body, (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && TEXT_FIELD.test(node.name.text)) {
        if (!identifierCalls(node.initializer, source).length) add(node.initializer, node.name.text, "text_initializer");
        else {
          unavailable.push({ functionName: context.name, field: node.name.text, reason: "helper_value_flow_frozen" });
          const field = node.name.text;
          const visitValidator = (current: ts.Node) => {
            if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) && current.arguments[0]) {
              if (!context.pureCalls.has(current.expression.text)) unavailable.push({ functionName: context.name, field, reason: "unproven_validation_helper" });
              else if (!identifierCalls(current.arguments[0], source).length) add(current.arguments[0], field, VALIDATOR.test(current.expression.text) ? "validation_data" : "helper_data");
            }
            ts.forEachChild(current, visitValidator);
          };
          visitValidator(node.initializer);
        }
      }
      if ((ts.isStringLiteral(node) || ts.isRegularExpressionLiteral(node)) && ts.isCallExpression(node.parent) && node.parent.arguments[0] === node &&
        ts.isPropertyAccessExpression(node.parent.expression) && EXTRACTION.has(node.parent.expression.name.text)) {
        let ancestor: ts.Node = node; let guarded = false; let field = "extraction";
        while (ancestor !== context.body && ancestor.parent) {
          if (ts.isVariableDeclaration(ancestor) && ts.isIdentifier(ancestor.name)) field = ancestor.name.text;
          if (ts.isIfStatement(ancestor) || ts.isThrowStatement(ancestor) || ts.isConditionalExpression(ancestor)) guarded = true;
          ancestor = ancestor.parent;
        }
        if (guarded) unavailable.push({ functionName: context.name, field, reason: "existing_guard_expression" });
        else add(node, field, "extraction_literal");
      }
    });
  }
  return { supported: supported.sort((a, b) => a.start - b.start), unavailable };
}
export function applyExpressionEdits(base: string, edits: Array<{ before: string; after: string }>, maximumBytes = 2_000, adapterPath?: string): string {
  const inventory = repairExpressionInventory(base, maximumBytes, adapterPath); const { contexts } = scan(base, adapterPath);
  const changes: Array<{ start: number; end: number; after: string }> = [];
  for (const edit of edits) {
    const site = inventory.supported.find((candidate) => candidate.before === edit.before);
    if (!site || Buffer.byteLength(edit.after) > maximumBytes || changes.some((change) => change.start < site.end && site.start < change.end)) throw new Error("edit_outside_supported_expression");
    const context = contexts.find((candidate) => candidate.name === site.functionName && site.start > candidate.body.pos && site.end < candidate.body.end)!;
    const parsed = parseExpression(edit.after);
    if (!pureExpression(parsed.expression, context, parsed.source) || protectedDependency(parsed.expression, context, site.field)) throw new Error("replacement_outside_expression_grammar");
    const original = parseExpression(edit.before);
    if (JSON.stringify(validatorCalls(original.expression, original.source)) !== JSON.stringify(validatorCalls(parsed.expression, parsed.source))) throw new Error("validation_contract_changed");
    if (JSON.stringify(identifierCalls(original.expression, original.source)) !== JSON.stringify(identifierCalls(parsed.expression, parsed.source))) throw new Error("helper_call_structure_changed");
    if (site.kind === "extraction_literal" && parsed.expression.kind !== original.expression.kind) throw new Error("extraction_literal_kind_changed");
    changes.push({ start: site.start, end: site.end, after: edit.after });
  }
  let candidate = base;
  for (const change of changes.sort((a, b) => b.start - a.start)) candidate = candidate.slice(0, change.start) + change.after + candidate.slice(change.end);
  const parsed = ts.createSourceFile("candidate.ts", candidate, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if ((parsed as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) throw new Error("candidate_syntax_invalid");
  return candidate;
}
