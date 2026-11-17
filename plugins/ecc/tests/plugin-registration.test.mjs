/**
 * Registration test for the ECC OpenCode 2 plugin entry point.
 *
 * This is the file the original bug lived in, so it is imported and driven here
 * instead of being restated: two locations are set up (as OpenCode does for two
 * open projects), both receive the same global events, and exactly one instance
 * must act on each.
 *
 * Covers:
 * - a session event with no path is handled once, not once per location;
 * - a file event is handled by the location that contains the file;
 * - the transformed tool definition executes and returns a `{ content }` payload;
 * - after the primary disposes, the surviving instance takes over.
 *
 *   node plugins/ecc/tests/plugin-registration.test.mjs
 */
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ecc-registration-"))
process.env.USERPROFILE = home
process.env.ECC_HOOK_PROFILE = "standard"

const projectA = fs.mkdtempSync(path.join(os.tmpdir(), "ecc-project-a-"))
const projectB = fs.mkdtempSync(path.join(os.tmpdir(), "ecc-project-b-"))
const fileA = path.join(projectA, "a.js")
const fileB = path.join(projectB, "b.js")
fs.writeFileSync(fileA, "console.log('a')\n")
fs.writeFileSync(fileB, "console.log('b')\n")

const LOG_FILE = path.join(home, ".local", "share", "opencode", "log", "ecc-hooks.log")
const { default: plugin } = await import(
  pathToFileURL(path.resolve(import.meta.dirname, "..", "index.ts")).href
)

function makeStream() {
  const queue = []
  let wake = null
  let closed = false
  return {
    async *subscribe() {
      while (!closed) {
        if (queue.length > 0) {
          yield queue.shift()
          continue
        }
        await new Promise((resolve) => { wake = resolve })
      }
    },
    push(event) {
      queue.push(event)
      if (wake) {
        const resume = wake
        wake = null
        resume()
      }
    },
    close() {
      closed = true
      if (wake) {
        const resume = wake
        wake = null
        resume()
      }
    },
  }
}

function makeContext(directory) {
  const stream = makeStream()
  const context = {
    directory,
    stream,
    tools: [],
    async setup() {
      const registration = { dispose: async () => {} }
      return {
        app: { version: "test" },
        location: { directory },
        tool: {
          hook: async () => registration,
          transform: async (editor) => {
            editor({ add: (definition) => context.tools.push(definition) })
            return registration
          },
        },
        shell: { hook: async () => registration },
        session: { hook: async () => registration },
        permission: { hook: async () => registration },
        event: { subscribe: () => stream.subscribe() },
      }
    },
  }
  return context
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100))
const logText = () => (fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf8") : "")
const count = (needle) => logText().split(needle).length - 1

const ctxA = makeContext(projectA)
const ctxB = makeContext(projectB)
const disposeA = await plugin.setup(await ctxA.setup())
const disposeB = await plugin.setup(await ctxB.setup())

try {
  // 1. Non-path event: one handler for the whole server.
  ctxA.stream.push({ type: "session.created", properties: {} })
  ctxB.stream.push({ type: "session.created", properties: {} })
  await settle()
  assert.equal(count("Session started"), 1, `session.created handled ${count("Session started")} times, expected 1`)
  console.log("PASS session event handled exactly once across two locations")

  // 2. Path event: only the owning location acts.
  ctxA.stream.push({ type: "file.edited", properties: { path: fileA } })
  ctxB.stream.push({ type: "file.edited", properties: { path: fileA } })
  ctxB.stream.push({ type: "file.edited", properties: { path: fileB } })
  await settle()
  assert.equal(count(`console.log found in ${fileA}`), 1, "file A was handled more than once or not at all")
  assert.equal(count(`console.log found in ${fileB}`), 1, "file B was not handled by its own location")
  console.log("PASS file events handled by the owning location only")

  // 3. Another non-path event, same expectation.
  ctxA.stream.push({ type: "todo.updated", properties: { todos: [{ text: "x", done: true }] } })
  ctxB.stream.push({ type: "todo.updated", properties: { todos: [{ text: "x", done: true }] } })
  await settle()
  assert.equal(count("Progress:"), 1, `todo.updated handled ${count("Progress:")} times, expected 1`)
  console.log("PASS todo event handled exactly once")

  // 4. The transformed tool definition is callable and returns a content payload.
  const gitSummary = ctxA.tools.find((definition) => definition.name === "git-summary")
  assert.ok(gitSummary, "git-summary was not registered")
  assert.ok(gitSummary.input?.properties?.branch || Object.keys(gitSummary.input?.properties ?? {}).length > 0, "git-summary lost its parameter schema")
  const payload = await gitSummary.execute({}, { sessionID: "test" })
  assert.equal(typeof payload?.content, "string", "tool execute did not return { content }")
  JSON.parse(payload.content)
  console.log("PASS transformed tool executes with a string cwd and returns JSON content")

  // 5. Primary handover: after A disposes, B handles the next event.
  await disposeA()
  const before = count("Session started")
  ctxB.stream.push({ type: "session.created", properties: {} })
  await settle()
  assert.equal(count("Session started"), before + 1, "the surviving location did not take over after the primary disposed")
  console.log("PASS surviving location takes over after the primary disposes")

  console.log("\nAll registration behaviours verified")
} finally {
  await disposeB().catch(() => {})
  ctxA.stream.close()
  ctxB.stream.close()
  for (const dir of [home, projectA, projectB]) fs.rmSync(dir, { recursive: true, force: true })
}
