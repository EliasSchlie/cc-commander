import Testing
import Foundation
@testable import CCLog

@Suite("CCLog level filter")
struct CCLogLevelTests {
    @Test func levelComparable() {
        #expect(CCLog.Level.debug < CCLog.Level.info)
        #expect(CCLog.Level.info < CCLog.Level.warn)
        #expect(CCLog.Level.warn < CCLog.Level.error)
    }

    @Test func levelNames() {
        #expect(CCLog.Level.debug.name == "debug")
        #expect(CCLog.Level.info.name == "info")
        #expect(CCLog.Level.warn.name == "warn")
        #expect(CCLog.Level.error.name == "error")
    }
}

// End-to-end file-sink tests require launching a subprocess with a
// LOG_FILE env var, because the sink is resolved once at module init from
// the parent process's environment. The shadow client and the GUI .task
// hook exercise the file sink in their own end-to-end runs.

@Suite("CCLog emitRecord stamps")
struct CCLogEmitRecordTests {
    @Test func componentTagDefault() {
        #expect(CCLog.component == "swift-client")
    }
}

/// `.serialized` because every test in this suite mutates the global
/// `CCLog.minimumLevel`. Swift Testing parallelises tests within a suite
/// by default, which would cause one test's `defer` restoration to clobber
/// another test's setup mid-flight.
@Suite("CCLog autoclosure laziness", .serialized)
struct CCLogAutoclosureTests {
    /// Regression guard for the perf bug where every public wrapper used
    /// to call `msg()` *before* checking the level filter, defeating the
    /// `@autoclosure` and forcing string interpolation on every disabled
    /// call. The fix is to guard `level >= minimumLevel` first.
    ///
    /// We capture a counter inside the autoclosure: if the message is
    /// materialised, the counter advances. With `minimumLevel` raised
    /// above debug, debug calls must NOT bump the counter.
    @Test func debugBelowMinimumLevelDoesNotMaterializeMessage() {
        let originalLevel = CCLog.minimumLevel
        defer { CCLog.minimumLevel = originalLevel }
        CCLog.minimumLevel = .info

        let counter = Counter()
        CCLog.debug("test", "expensive: \(counter.bump())")
        #expect(counter.value == 0)
    }

    @Test func infoAtMinimumLevelDoesMaterializeMessage() {
        let originalLevel = CCLog.minimumLevel
        defer { CCLog.minimumLevel = originalLevel }
        CCLog.minimumLevel = .info

        let counter = Counter()
        CCLog.info("test", "expensive: \(counter.bump())")
        #expect(counter.value == 1)
    }

    @Test func loggerValueTypeAlsoSkipsAutoclosureBelowLevel() {
        let originalLevel = CCLog.minimumLevel
        defer { CCLog.minimumLevel = originalLevel }
        CCLog.minimumLevel = .warn

        let log = CCLog.Logger("test")
        let counter = Counter()
        log.info("expensive: \(counter.bump())")
        log.debug("expensive: \(counter.bump())")
        #expect(counter.value == 0)
        log.warn("expensive: \(counter.bump())")
        #expect(counter.value == 1)
        log.error("expensive: \(counter.bump())")
        #expect(counter.value == 2)
    }

    @Test func errorIsNeverFiltered() {
        let originalLevel = CCLog.minimumLevel
        defer { CCLog.minimumLevel = originalLevel }
        CCLog.minimumLevel = .error

        let counter = Counter()
        CCLog.error("test", "expensive: \(counter.bump())")
        #expect(counter.value == 1)
    }
}

/// Reference-typed counter so the autoclosure can mutate it without the
/// `inout` ceremony you'd need for a value type captured by closure.
private final class Counter {
    private(set) var value: Int = 0
    func bump() -> String {
        value += 1
        return String(value)
    }
}
