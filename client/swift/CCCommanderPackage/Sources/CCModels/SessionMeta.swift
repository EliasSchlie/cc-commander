import Foundation

public struct SessionMeta: Codable, Identifiable, Sendable {
    public let sessionId: String
    public let accountId: String
    public let machineId: String
    public let directory: String
    public var status: SessionStatus
    public var lastActivity: Date
    public var lastMessagePreview: String
    public let createdAt: Date

    public var id: String { sessionId }

    public init(
        sessionId: String,
        accountId: String,
        machineId: String,
        directory: String,
        status: SessionStatus,
        lastActivity: Date,
        lastMessagePreview: String,
        createdAt: Date
    ) {
        self.sessionId = sessionId
        self.accountId = accountId
        self.machineId = machineId
        self.directory = directory
        self.status = status
        self.lastActivity = lastActivity
        self.lastMessagePreview = lastMessagePreview
        self.createdAt = createdAt
    }
}
