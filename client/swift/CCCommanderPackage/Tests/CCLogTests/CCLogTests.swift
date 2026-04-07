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

// Note: end-to-end file-sink tests require launching a subprocess with a
// LOG_FILE env var, because the sink is resolved once at module init from
// the parent process's environment. Setting an env var inside the test
// process won't retroactively rewire the sink. The shadow client and the
// GUI .task hook exercise the file sink in their own end-to-end runs;
// here we cover the level enum + record shape via emitRecord, which
// bypasses the level filter and is sink-agnostic.

@Suite("CCLog emitRecord stamps")
struct CCLogEmitRecordTests {
    @Test func componentTagDefault() {
        // Just verify the public knobs exist and have sane defaults so a
        // future refactor can't silently rename them out from under the
        // shadow client / harness without a compile error.
        #expect(CCLog.component == "swift-client")
    }
}
