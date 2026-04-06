import Foundation

public enum SessionStatus: String, Codable, Sendable {
    case running
    case idle
    case waitingForInput = "waiting_for_input"
    case error
}
