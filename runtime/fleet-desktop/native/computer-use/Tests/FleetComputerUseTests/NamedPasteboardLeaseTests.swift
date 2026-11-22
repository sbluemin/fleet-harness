import AppKit
import Testing
@testable import FleetComputerUse

// Opt in on a Mac with a GUI session. This never reads or changes the general pasteboard.
@Test(.enabled(if: ProcessInfo.processInfo.environment["FLEET_TEST_NAMED_PASTEBOARD"] == "1"))
@MainActor func namedPasteboardRestoresExactItemsAndPreservesNewerCopy() throws {
  let pasteboard = NSPasteboard.withUniqueName()
  defer { pasteboard.releaseGlobally() }
  let board = NativePasteboard(board: pasteboard)
  let custom = NSPasteboard.PasteboardType("local.fleet.test-fixture")
  let first = NSPasteboardItem()
  let second = NSPasteboardItem()
  #expect(first.setString("test plain", forType: .string))
  #expect(first.setString("<b>test HTML</b>", forType: .html))
  #expect(second.setData(Data([0, 255, 10]), forType: custom))
  _ = board.clear()
  try #require(board.write([first, second]))

  func snapshot() throws -> [[NSPasteboard.PasteboardType: Data]] {
    try board.snapshot(maxBytes: 1_024).map { item in
      try Dictionary(uniqueKeysWithValues: item.types.map { type in (type, try #require(item.data(forType: type))) })
    }
  }

  let before = try snapshot()
  let originalCount = board.changeCount
  let token = UUID()
  let replacement = try #require(NativePasteboard.replacement(text: "임시", html: "<b>임시</b>", token: token))
  var lease = try #require(PasteboardLease.start(on: board, replacement: replacement, token: token, canReplace: { true }))
  #expect(board.changeCount != originalCount)
  #expect(pasteboard.string(forType: .string) == "임시")
  #expect(pasteboard.string(forType: .html) == "<meta charset=\"utf-8\"><b>임시</b>")
  #expect(lease.finish() == .restored)
  #expect(try snapshot() == before)

  let nextToken = UUID()
  let next = try #require(NativePasteboard.replacement(text: "temp", html: nil, token: nextToken))
  var nextLease = try #require(PasteboardLease.start(on: board, replacement: next, token: nextToken, canReplace: { true }))
  let newer = NSPasteboardItem()
  #expect(newer.setString("new test copy", forType: .string))
  _ = board.clear()
  try #require(board.write([newer]))
  let newerCount = board.changeCount
  #expect(nextLease.finish() == .preservedNewerContents)
  #expect(board.changeCount == newerCount)
  #expect(pasteboard.string(forType: .string) == "new test copy")
}
