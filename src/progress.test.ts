import { describe, expect, it } from "vitest"
import { createInlineProgress } from "./progress.js"

describe("createInlineProgress", () => {
  it("writes inline updates on a TTY and clears on done()", () => {
    const writes: string[] = []
    const p = createInlineProgress((s) => writes.push(s), true)

    p.onProgress({ phase: "scanning-stakes", fromBlock: 0n, toBlock: 100n, scannedTo: 50n, eventsFound: 3 })
    p.onProgress({ phase: "checking-attesters", checked: 2, total: 4 })
    p.done()

    // Two progress renders + one clear.
    expect(writes).toHaveLength(3)
    // Each render starts with carriage-return + clear-line.
    expect(writes[0]?.startsWith("\r\x1b[2K")).toBe(true)
    expect(writes[0]).toContain("block 50 out of 100")
    expect(writes[0]).toContain("3 found")
    expect(writes[1]).toContain("2/4")
    // Final write is the clear.
    expect(writes[2]).toBe("\r\x1b[2K")
  })

  it("stays silent on a non-TTY", () => {
    const writes: string[] = []
    const p = createInlineProgress((s) => writes.push(s), false)
    p.onProgress({ phase: "scanning-stakes", fromBlock: 0n, toBlock: 100n, scannedTo: 50n, eventsFound: 3 })
    p.onProgress({ phase: "checking-attesters", checked: 2, total: 4 })
    p.done()
    expect(writes).toHaveLength(0)
  })

  it("renders block X out of Y for the stake scan phase", () => {
    const writes: string[] = []
    const p = createInlineProgress((s) => writes.push(s), true)
    p.onProgress({ phase: "scanning-stakes", fromBlock: 0n, toBlock: 25184582n, scannedTo: 25100000n, eventsFound: 7 })
    expect(writes[0]).toContain("block 25100000 out of 25184582")
    expect(writes[0]).toContain("7 found")
  })

  it("renders receipt progress for the split-resolution phase", () => {
    const writes: string[] = []
    const p = createInlineProgress((s) => writes.push(s), true)
    p.onProgress({ phase: "resolving-splits", resolved: 40, total: 197, matched: 38 })
    expect(writes[0]).toContain("40/197 tx")
    expect(writes[0]).toContain("38 matched")
  })

  it("does not emit a clear if nothing was ever rendered (non-TTY done)", () => {
    const writes: string[] = []
    const p = createInlineProgress((s) => writes.push(s), false)
    p.done()
    expect(writes).toHaveLength(0)
  })
})
