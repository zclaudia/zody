import ts from "typescript";

export function moduleSpecifiers(text) {
  const source = ts.createSourceFile(
    "entry.mjs",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const imports = [];
  const dynamic = [];
  const requires = [];
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length >= 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const specifier = node.arguments[0].text;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) dynamic.push(specifier);
      else if (
        ts.isIdentifier(node.expression) &&
        ["require", "__require"].includes(node.expression.text)
      ) {
        requires.push({ specifier, kind: node.expression.text });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { imports, dynamic, requires };
}
