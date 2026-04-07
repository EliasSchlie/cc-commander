import Testing
import Foundation
@testable import CCApp

@Suite("splitLines chunk-boundary parsing")
struct SplitLinesTests {

    private let cap = 1024  // Small cap so overflow tests don't allocate megabytes.

    @Test func emptyChunkAndCarryReturnsNothing() {
        let r = splitLines(carry: Data(), chunk: Data(), skipping: false, maxCarry: cap)
        #expect(r.lines.isEmpty)
        #expect(r.newCarry.isEmpty)
        #expect(r.skipToNextNewline == false)
        #expect(r.warning == nil)
    }

    @Test func singleCompleteLine() {
        let r = splitLines(
            carry: Data(),
            chunk: Data("hello\n".utf8),
            skipping: false,
            maxCarry: cap
        )
        #expect(r.lines.count == 1)
        #expect(String(data: r.lines[0], encoding: .utf8) == "hello")
        #expect(r.newCarry.isEmpty)
    }

    @Test func twoCompleteLinesInOneChunk() {
        let r = splitLines(
            carry: Data(),
            chunk: Data("a\nb\n".utf8),
            skipping: false,
            maxCarry: cap
        )
        #expect(r.lines.map { String(data: $0, encoding: .utf8) } == ["a", "b"])
        #expect(r.newCarry.isEmpty)
    }

    @Test func partialLineGoesIntoCarry() {
        let r = splitLines(
            carry: Data(),
            chunk: Data("partial".utf8),
            skipping: false,
            maxCarry: cap
        )
        #expect(r.lines.isEmpty)
        #expect(String(data: r.newCarry, encoding: .utf8) == "partial")
    }

    @Test func carryCompletesOnNextChunk() {
        // First chunk: "par"
        let r1 = splitLines(
            carry: Data(),
            chunk: Data("par".utf8),
            skipping: false,
            maxCarry: cap
        )
        #expect(r1.lines.isEmpty)
        // Second chunk: "tial\n"
        let r2 = splitLines(
            carry: r1.newCarry,
            chunk: Data("tial\n".utf8),
            skipping: false,
            maxCarry: cap
        )
        #expect(r2.lines.count == 1)
        #expect(String(data: r2.lines[0], encoding: .utf8) == "partial")
    }

    @Test func multibyteUTF8SplitAcrossChunksRoundTrips() {
        // 'é' = 0xC3 0xA9 in UTF-8. Split immediately after the 0xC3
        // lead byte so the trailing 0xA9 lands in the next chunk. If
        // splitLines decoded each chunk to String independently, the
        // first chunk would fail and the byte would be lost forever.
        let line = #"{"id":"u","cmd":"quit","args":{"note":"é"}}"#
        let bytes = Array(line.utf8) + [0x0a]
        let leadIdx = bytes.firstIndex(of: 0xC3)!
        let firstHalf = Data(bytes[0...leadIdx])
        let secondHalf = Data(bytes[(leadIdx + 1)...])

        let r1 = splitLines(carry: Data(), chunk: firstHalf, skipping: false, maxCarry: cap)
        #expect(r1.lines.isEmpty)
        let r2 = splitLines(carry: r1.newCarry, chunk: secondHalf, skipping: false, maxCarry: cap)
        #expect(r2.lines.count == 1)
        #expect(String(data: r2.lines[0], encoding: .utf8) == line)
    }

    @Test func carryOverflowDropsPartialAndSetsSkipFlag() {
        let huge = Data(repeating: 0x41, count: cap + 100) // 'A' * (cap+100), no newline
        let r = splitLines(carry: Data(), chunk: huge, skipping: false, maxCarry: cap)
        #expect(r.lines.isEmpty)
        #expect(r.newCarry.isEmpty)
        #expect(r.skipToNextNewline == true)
        #expect(r.warning?["reason"] == AnyHashable("carry_overflow"))
    }

    @Test func skipModeDiscardsBytesUntilNewline() {
        // We're in skip mode (recovering from a previous overflow). Tail
        // of the oversized line arrives, then a newline, then a normal
        // command. Only the normal command should come out.
        let chunk = Data("more-tail\n{\"id\":\"x\",\"cmd\":\"quit\"}\n".utf8)
        let r = splitLines(carry: Data(), chunk: chunk, skipping: true, maxCarry: cap)
        #expect(r.lines.count == 1)
        #expect(String(data: r.lines[0], encoding: .utf8) == #"{"id":"x","cmd":"quit"}"#)
        #expect(r.skipToNextNewline == false)
    }

    @Test func skipModeWithNoNewlineStaysInSkipMode() {
        // Whole chunk is more tail of the oversized line. No newline
        // anywhere. Stay in skip mode for the next poll.
        let r = splitLines(
            carry: Data(),
            chunk: Data("still-tail-no-newline".utf8),
            skipping: true,
            maxCarry: cap
        )
        #expect(r.lines.isEmpty)
        #expect(r.newCarry.isEmpty)
        #expect(r.skipToNextNewline == true)
    }

    @Test func overflowAndRecoveryAcrossPolls() {
        // Real-world recovery scenario: a controller writes a huge line
        // (overflow), then a newline, then a normal command. Three polls.

        // Poll 1: oversized line, no newline. Overflow → drop, set skip.
        let huge = Data(repeating: 0x41, count: cap + 50)
        let r1 = splitLines(carry: Data(), chunk: huge, skipping: false, maxCarry: cap)
        #expect(r1.skipToNextNewline == true)
        #expect(r1.warning?["reason"] == AnyHashable("carry_overflow"))

        // Poll 2: more bytes of the same oversized line, finally
        // followed by a newline, then start of next command.
        let r2 = splitLines(
            carry: r1.newCarry,
            chunk: Data("trailing-bytes\n{\"id\":".utf8),
            skipping: r1.skipToNextNewline,
            maxCarry: cap
        )
        #expect(r2.lines.isEmpty) // The recovered remnant is partial command
        #expect(r2.skipToNextNewline == false)
        #expect(String(data: r2.newCarry, encoding: .utf8) == #"{"id":"#)

        // Poll 3: rest of the next command, with terminating newline.
        let r3 = splitLines(
            carry: r2.newCarry,
            chunk: Data(#""x","cmd":"quit"}"#.utf8 + [0x0a]),
            skipping: r2.skipToNextNewline,
            maxCarry: cap
        )
        #expect(r3.lines.count == 1)
        #expect(String(data: r3.lines[0], encoding: .utf8) == #"{"id":"x","cmd":"quit"}"#)
    }

    @Test func emptyLinesArePreservedInOutput() {
        // The runner trims them out before dispatch, but splitLines
        // itself reports every newline-delimited segment. Empty lines
        // are part of the wire format.
        let r = splitLines(
            carry: Data(),
            chunk: Data("a\n\nb\n".utf8),
            skipping: false,
            maxCarry: cap
        )
        #expect(r.lines.map { String(data: $0, encoding: .utf8) } == ["a", "", "b"])
    }
}
