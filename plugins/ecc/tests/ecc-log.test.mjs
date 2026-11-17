/**
 * Durable-log tests for the ECC plugin.
 *
 * Covers the two failures a review reproduced by hand:
 * - deleting the log directory killed logging for the rest of the process;
 * - rotation overwrote the previous generation instead of shifting it.
 *
 * `os.homedir()` is read when the module is imported, so USERPROFILE is pointed
 * at a temp directory before the dynamic import.
 *
 *   node plugins/ecc/tests/ecc-log.test.mjs
 */
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ecc-log-test-"))
process.env.USERPROFILE = home

const LOG_FILE = path.join(home, ".local", "share", "opencode", "log", "ecc-hooks.log")
const { appendEccLog } = await import(
  pathToFileURL(path.resolve(import.meta.dirname, "..", "lib", "ecc-runtime-support.ts")).href
)

function read(log = LOG_FILE) {
  return fs.readFileSync(log, "utf8")
}

try {
  appendEccLog("first line")
  assert.match(read(), /first line/, "appendEccLog did not create the log file")
  console.log("PASS append creates the log")

  fs.rmSync(path.dirname(LOG_FILE), { recursive: true, force: true })
  appendEccLog("after directory removal")
  assert.match(read(), /after directory removal/, "log stayed dead after the directory was removed")
  console.log("PASS log directory recreated after removal")

  // Fill past the 1 MB cap, then rotate.
  fs.appendFileSync(LOG_FILE, "x".repeat(1024 * 1024 + 4096))
  fs.writeFileSync(`${LOG_FILE}.1`, "OLDEST-GENERATION")
  appendEccLog("rotation marker")
  assert.match(read(), /rotation marker/, "the marker line was not written after rotation")
  assert.ok(fs.statSync(`${LOG_FILE}.1`).size > 1024 * 1024, "the rotated file is not the oversized log")
  assert.equal(read(`${LOG_FILE}.2`), "OLDEST-GENERATION", "the previous generation was overwritten")
  console.log("PASS rotation shifts generations instead of overwriting")

  console.log("\nAll log behaviours verified")
} finally {
  fs.rmSync(home, { recursive: true, force: true })
}
