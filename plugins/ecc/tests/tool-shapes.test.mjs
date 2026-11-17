/**
 * Tool-shape smoke test for the ECC OpenCode 2 plugin.
 *
 * Regression guard for the `paths[0] must be of type string` bug: OpenCode's
 * tool loader turns a raw `{ description, args, execute }` definition into
 * `{ name, description, input, run }`, where `run(input, cwd)` expects the
 * project directory as a plain string. The plugin therefore has two call
 * shapes, and both must keep working.
 *
 * Run with the plain Node binary (>= 22.18, type stripping is on by default):
 *
 *   node plugins/ecc/tests/tool-shapes.test.mjs
 *   node plugins/ecc/tests/tool-shapes.test.mjs "E:\First Try"
 */
import assert from "node:assert/strict"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { toInputSchema } from "../tools/tool.ts"

const TOOLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "tools")
const WORKTREE = process.argv[2] ?? process.cwd()
const TOOL_NAMES = [
  "run-tests",
  "check-coverage",
  "security-audit",
  "format-code",
  "lint-check",
  "git-summary",
  "changed-files",
  "dependency-analyzer",
]

const failures = []

/** Raw ECC definitions in this install: every one must carry `execute`. */
async function checkRawDefinition(name) {
  const module = await import(pathToFileURL(path.join(TOOLS_DIR, `${name}.ts`)).href)
  const definition = module.default

  assert.ok(definition && typeof definition === "object", `${name}: no default export`)
  assert.equal(typeof definition.description, "string", `${name}: description is not a string`)
  assert.ok(definition.description.length > 0, `${name}: description is empty`)
  assert.ok(definition.args && typeof definition.args === "object", `${name}: args is not an object`)

  const callable = typeof definition.run === "function"
    ? "run"
    : typeof definition.execute === "function"
      ? "execute"
      : null
  assert.ok(callable, `${name}: neither run() nor execute() is callable`)

  // The parameter schema is what the model sees; a silent empty schema makes a
  // tool unusable, so assert the builder actually carries the arguments over.
  const schema = toInputSchema(definition.args)
  assert.equal(schema.type, "object", `${name}: schema type is not object`)
  assert.ok(
    Object.keys(schema.properties).length > 0,
    `${name}: zero-argument schema (dropped parameter schema)`,
  )
  for (const [argName, property] of Object.entries(schema.properties)) {
    assert.ok(property.type, `${name}.${argName}: no JSON Schema type`)
  }

  // Shape 2 of the plugin branch: the V1 context object with a string
  // `directory`. Passing a context object to a `run`-shaped tool is exactly the
  // bug this test exists for, so the two shapes must stay distinguishable.
  const result = callable === "run"
    ? await definition.run({}, WORKTREE)
    : await definition.execute({}, { directory: WORKTREE, worktree: WORKTREE })

  assert.equal(typeof result, "string", `${name}: ${callable}() did not return a string`)
  assert.ok(result.length > 0, `${name}: ${callable}() returned an empty string`)
  assert.doesNotMatch(result, /could not load|is not a function|has no executable/, `${name}: ${result.slice(0, 120)}`)
  if (result.trimStart().startsWith("{")) JSON.parse(result)
  return { callable, bytes: result.length, schema }
}

const schemas = {}
for (const name of TOOL_NAMES) {
  try {
    const { callable, bytes, schema } = await checkRawDefinition(name)
    schemas[name] = schema
    console.log(`PASS ${name} (${callable}, ${bytes} bytes)`)
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// Two concrete schema contracts, so an empty or lossy schema cannot pass.
try {
  assert.ok(
    schemas["format-code"]?.required?.includes("filePath"),
    "format-code: filePath is no longer a required argument",
  )
  assert.deepEqual(
    schemas["check-coverage"]?.properties?.format?.enum,
    ["summary", "detailed", "json"],
    "check-coverage: format enum was dropped",
  )
  console.log("PASS schema contracts (required filePath, format enum)")
} catch (error) {
  failures.push(`schema contract: ${error instanceof Error ? error.message : String(error)}`)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} tool(s) failed:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(`\nAll ${TOOL_NAMES.length} tools loaded and executed against ${WORKTREE}`)
