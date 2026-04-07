import Foundation

public enum SessionStatus: String, Codable, Sendable, CaseIterable {
    case running
    case idle
    case waitingForInput = "waiting_for_input"
    case error

    public var displayName: String {
        switch self {
        case .running: return "Running"
        case .idle: return "Idle"
        case .waitingForInput: return "Waiting"
        case .error: return "Error"
        }
    }
}
