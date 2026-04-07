import Foundation
import OSLog

/// Structured logging for the Swift client. Mirrors the conventions used by
/// the hub/runner `@cc-commander/protocol/logger`:
///
///   - Levels: debug / info / warn / error
///   - JSON-per-line records: { ts, level, component, category, msg, ...fields }
///   - Optional file sink via `LOG_FILE` (also rotates if `LOG_MAX_BYTES` set)
///   - `LOG_LEVEL` controls minimum emitted level (default `info`)
///   - Always also forwards to `os.Logger` so Console.app and `log show`
///     keep working when nobody asked for a file sink
///
/// Why this exists: `os.Logger` info/debug records are unreliable when read
/// back from `log show` outside Xcode (records get rate-limited or dropped
/// before they reach the unified log archive). A Claude Code session driving
/// the app needs *one* file it can `tail -F` regardless of which layer
/// (CCNetworking, CCApp, GUI) emitted the log. CCLog is that file.
public enum CCLog {

    public enum Level: Int, Sendable, Comparable {
        case debug = 10
        case info = 20
        case warn = 30
        case error = 40

        public static func < (lhs: Level, rhs: Level) -> Bool { lhs.rawValue < rhs.rawValue }

        var name: String {
            switch self {
            case .debug: return "debug"
            case .info: return "info"
            case .warn: return "warn"
            case .error: return "error"
            }
        }

        var osLogType: OSLogType {
            switch self {
            case .debug: return .debug
            case .info: return .info
            case .warn: return .default
            case .error: return .error
            }
        }
    }

    /// A field value that can be serialized into the JSON record. Kept narrow
    /// on purpose: anything richer than this should be `String(describing:)`'d
    /// at the call site so the wire format stays predictable.
    public enum Field: Sendable {
        case string(String)
        case int(Int)
        case double(Double)
        case bool(Bool)
    }

    public typealias Fields = [String: Field]

    /// The component tag stamped into every record. Defaults to `swift-client`
    /// so a single grep across hub + runner + client logs picks out who
    /// emitted what.
    public static var component: String = "swift-client"

    /// Minimum level emitted. Resolved once at startup from `LOG_LEVEL`,
    /// can be overridden at runtime.
    nonisolated(unsafe) public static var minimumLevel: Level = {
        guard let raw = ProcessInfo.processInfo.environment["LOG_LEVEL"]?.lowercased() else {
            return .info
        }
        switch raw {
        case "debug": return .debug
        case "info": return .info
        case "warn", "warning": return .warn
        case "error": return .error
        default: return .info
        }
    }()

    // MARK: - Public API

    public static func debug(
        _ category: String,
        _ msg: @autoclosure () -> String,
        _ fields: Fields = [:]
    ) {
        // Check the level *before* materialising the autoclosure -- a
        // `Log.debug("...\(expensiveDescribe(x))...")` call at info level
        // must not pay for string interpolation.
        guard Level.debug >= minimumLevel else { return }
        emit(.debug, category, msg(), fields)
    }

    public static func info(
        _ category: String,
        _ msg: @autoclosure () -> String,
        _ fields: Fields = [:]
    ) {
        guard Level.info >= minimumLevel else { return }
        emit(.info, category, msg(), fields)
    }

    public static func warn(
        _ category: String,
        _ msg: @autoclosure () -> String,
        _ fields: Fields = [:]
    ) {
        guard Level.warn >= minimumLevel else { return }
        emit(.warn, category, msg(), fields)
    }

    public static func error(
        _ category: String,
        _ msg: @autoclosure () -> String,
        _ fields: Fields = [:]
    ) {
        guard Level.error >= minimumLevel else { return }
        emit(.error, category, msg(), fields)
    }

    /// Category-bound logger value type. Lets each consumer write
    /// `private let log = CCLog.Logger("HubConnection")` and call
    /// `log.info(...)` instead of repeating the category string at every
    /// call site.
    public struct Logger: Sendable {
        public let category: String
        public init(_ category: String) { self.category = category }

        public func debug(_ msg: @autoclosure () -> String, _ fields: Fields = [:]) {
            guard Level.debug >= minimumLevel else { return }
            CCLog.emit(.debug, category, msg(), fields)
        }
        public func info(_ msg: @autoclosure () -> String, _ fields: Fields = [:]) {
            guard Level.info >= minimumLevel else { return }
            CCLog.emit(.info, category, msg(), fields)
        }
        public func warn(_ msg: @autoclosure () -> String, _ fields: Fields = [:]) {
            guard Level.warn >= minimumLevel else { return }
            CCLog.emit(.warn, category, msg(), fields)
        }
        public func error(_ msg: @autoclosure () -> String, _ fields: Fields = [:]) {
            guard Level.error >= minimumLevel else { return }
            CCLog.emit(.error, category, msg(), fields)
        }
    }

    /// Append a pre-built record to the log file (if any) bypassing the
    /// level filter. Used by the test harness to write command responses
    /// that callers grep for unconditionally.
    public static func emitRecord(_ record: [String: Any]) {
        var copy = record
        if copy["ts"] == nil { copy["ts"] = isoTimestamp() }
        if copy["component"] == nil { copy["component"] = component }
        sink.write(copy)
    }

    /// Force-flush any buffered file output. Tests call this so the file
    /// reflects the latest line before the assertion runs.
    public static func flush() {
        sink.flush()
    }

    // MARK: - Internals

    /// Internal — call sites use the level-specific public methods, which
    /// guard on `minimumLevel` *before* materialising autoclosure messages.
    /// `emit` itself does NOT re-check the level: by the time it runs the
    /// message has already been built, and the cost we want to skip is
    /// upstream of this point.
    fileprivate static func emit(
        _ level: Level,
        _ category: String,
        _ message: String,
        _ fields: Fields
    ) {

        // os.Logger mirror -- one Logger per category, cached.
        let osLog = osLogger(for: category)
        osLog.log(level: level.osLogType, "\(message, privacy: .public)")

        // File / stdout sink (always JSON-shaped record).
        var record: [String: Any] = [
            "ts": isoTimestamp(),
            "level": level.name,
            "component": component,
            "category": category,
            "msg": message,
        ]
        for (k, v) in fields {
            record[k] = anyValue(v)
        }
        sink.write(record)
    }

    private static func anyValue(_ field: Field) -> Any {
        switch field {
        case .string(let s): return s
        case .int(let i): return i
        case .double(let d): return d
        case .bool(let b): return b
        }
    }

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static func isoTimestamp() -> String {
        isoFormatter.string(from: Date())
    }

    // os.Logger is reference-y but expensive to instantiate per call;
    // cache one per category. Qualified as `os.Logger` because the
    // public `CCLog.Logger` value type would otherwise shadow it.
    nonisolated(unsafe) private static var osLoggerCache: [String: os.Logger] = [:]
    private static let osLoggerLock = NSLock()

    private static func osLogger(for category: String) -> os.Logger {
        osLoggerLock.lock()
        defer { osLoggerLock.unlock() }
        if let existing = osLoggerCache[category] { return existing }
        let made = os.Logger(subsystem: "com.cc-commander.app", category: category)
        osLoggerCache[category] = made
        return made
    }

    // Sink resolved once based on env. Picked at first use.
    nonisolated(unsafe) private static let sink: LogSink = {
        if let path = ProcessInfo.processInfo.environment["LOG_FILE"], !path.isEmpty {
            let maxBytes = Int(ProcessInfo.processInfo.environment["LOG_MAX_BYTES"] ?? "") ?? 0
            return FileSink(path: path, maxBytes: maxBytes)
        }
        // No file requested -- silent sink. We still emit to os.Logger above,
        // so dev/Xcode workflows are unaffected.
        return NullSink()
    }()
}

// MARK: - Sinks

private protocol LogSink: AnyObject {
    func write(_ record: [String: Any])
    func flush()
}

private final class NullSink: LogSink {
    func write(_ record: [String: Any]) {}
    func flush() {}
}

/// Append-only JSON-per-line file sink. Naive size-based rotation: when
/// the file exceeds `maxBytes`, rename to `.1` and reopen. Single-process
/// only -- the Swift client is one process, no fcntl coordination needed.
private final class FileSink: LogSink {
    private let path: String
    private let maxBytes: Int
    private var handle: FileHandle?
    private var bytesWritten: Int = 0
    private let lock = NSLock()

    init(path: String, maxBytes: Int) {
        self.path = path
        self.maxBytes = maxBytes
        open()
    }

    private func open() {
        let fm = FileManager.default
        let dir = (path as NSString).deletingLastPathComponent
        if !dir.isEmpty {
            try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
        }
        if !fm.fileExists(atPath: path) {
            fm.createFile(atPath: path, contents: nil)
        }
        let h = FileHandle(forWritingAtPath: path)
        h?.seekToEndOfFile()
        self.handle = h
        if let attr = try? fm.attributesOfItem(atPath: path),
           let size = attr[.size] as? NSNumber {
            self.bytesWritten = size.intValue
        }
    }

    func write(_ record: [String: Any]) {
        lock.lock()
        defer { lock.unlock() }
        guard let line = serialize(record) else { return }
        let data = (line + "\n").data(using: .utf8) ?? Data()
        try? handle?.write(contentsOf: data)
        bytesWritten += data.count
        if maxBytes > 0 && bytesWritten >= maxBytes {
            rotate()
        }
    }

    func flush() {
        lock.lock()
        defer { lock.unlock() }
        try? handle?.synchronize()
    }

    private func rotate() {
        try? handle?.close()
        handle = nil
        let fm = FileManager.default
        let rotated = path + ".1"
        try? fm.removeItem(atPath: rotated)
        try? fm.moveItem(atPath: path, toPath: rotated)
        bytesWritten = 0
        open()
    }

    /// `JSONSerialization` is fine for the limited shape we emit. Sort
    /// keys so successive runs diff cleanly under test assertions.
    private func serialize(_ record: [String: Any]) -> String? {
        guard JSONSerialization.isValidJSONObject(record),
              let data = try? JSONSerialization.data(
                withJSONObject: record,
                options: [.sortedKeys]
              ),
              let s = String(data: data, encoding: .utf8) else {
            return nil
        }
        return s
    }
}
