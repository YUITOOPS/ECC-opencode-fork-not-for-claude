/**
 * Change-store tests for the changed-files tool.
 *
 * The store used to live in module-level state, so the plugin runtime and the
 * tool module each recorded into their own Map and the tool always answered
 * "No files changed". The state now lives on `globalThis` and every reader
 * resolves paths against the location it is asked about.
 *
 *   node plugins/ecc/tests/changed-files-store.test.mjs
 */
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ecc-store-root-"))
const other = fs.mkdtempSync(path.join(os.tmpdir(), "ecc-store-other-"))
const storeUrl = pathToFileURL(path.resolve(import.meta.dirname, "..", "lib", "changed-files-store.ts")).href

const store = await import(storeUrl)
store.initStore(root)

try {
  const inside = path.join(root, "src", "app.ts")
  const outside = path.join(other, "other.ts")

  store.recordChange(inside, "added")
  store.recordChange(outside, "modified")

  assert.equal(store.hasChanges(root), true, "a change inside the location was not recorded")
  const paths = store.getChangedPaths(undefined, root)
  assert.deepEqual(
    paths.map((entry) => entry.path),
    [path.join("src", "app.ts")],
    "paths were not reported relative to the location",
  )
  assert.equal(store.hasChanges(other), true, "the other location lost its own change")
  assert.equal(
    store.getChangedPaths(undefined, root).length,
    1,
    "changes from another location leaked into this one",
  )

  const tree = store.buildTree(undefined, root)
  assert.equal(tree[0]?.name, "src", "tree root is not the first directory")
  assert.equal(tree[0]?.children[0]?.name, "app.ts", "tree leaf is wrong")

  // A second import of the same file must share the state (the original bug).
  const second = await import(`${storeUrl}?copy=2`)
  assert.equal(second.hasChanges(root), true, "a second module instance did not share the store")

  // End to end: what the runtime records is what the tool reports.
  store.recordChange(path.join(root, "README.md"), "modified")
  const toolPath = pathToFileURL(path.resolve(import.meta.dirname, "..", "tools", "changed-files.ts")).href
  const tool = (await import(toolPath)).default
  const payload = JSON.parse(await tool.execute({ format: "json" }, { directory: root }))
  assert.equal(payload.changed, true, "the tool did not see the recorded change")
  assert.deepEqual(
    payload.files.map((entry) => entry.path).sort(),
    [path.join("README.md"), path.join("src", "app.ts")].sort(),
    "the tool reported the wrong files",
  )
  assert.deepEqual(
    payload.diffCommands,
    ['git diff -- "README.md"'],
    "the diff hint is not a quoted git command",
  )
  assert.match(await tool.execute({}, { directory: root }), /^Changed files \(2\)/, "tree output is wrong")

  store.clearChanges()
  assert.equal(store.hasChanges(root), false, "clearChanges did not empty the store")
  console.log("PASS store records, scopes by location, survives module copies, and feeds the tool")
  console.log("\nAll change-store behaviours verified")
} finally {
  for (const dir of [root, other]) fs.rmSync(dir, { recursive: true, force: true })
}
