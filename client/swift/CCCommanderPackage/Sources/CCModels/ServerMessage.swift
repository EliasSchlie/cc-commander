import Foundation

/// Messages sent from the hub to a device, decoded from JSON with a "type" discriminator.
public enum ServerMessage: Sendable {
    case sessionList([SessionMeta])
    case machineList([MachineInfo])
    case streamText(sessionId: String, content: String)
    case toolCall(sessionId: String, toolName: String, display: String)
    case toolResult(sessionId: String, content: String)
    case userPrompt(UserPromptPayload)
    case sessionStatus(sessionId: String, status: SessionStatus, lastMessagePreview: String?)
    case sessionDone(SessionDonePayload)
    case sessionError(sessionId: String, error: String)
    case sessionHistory(sessionId: String, requestId: String, messages: [AnyCodable])
    case error(message: String)
}

extension ServerMessage: Decodable {
    private enum TypeKey: String, CodingKey {
        case type
    }

    private enum MessageType: String, Decodable {
        case sessionList = "session_list"
        case machineList = "machine_list"
        case streamText = "stream_text"
        case toolCall = "tool_call"
        case toolResult = "tool_result"
        case userPrompt = "user_prompt"
        case sessionStatus = "session_status"
        case sessionDone = "session_done"
        case sessionError = "session_error"
        case sessionHistory = "session_history"
        case error
    }

    public init(from decoder: Decoder) throws {
        let typeContainer = try decoder.container(keyedBy: TypeKey.self)
        let type = try typeContainer.decode(MessageType.self, forKey: .type)

        switch type {
        case .sessionList:
            let payload = try SessionListPayload(from: decoder)
            self = .sessionList(payload.sessions)

        case .machineList:
            let payload = try MachineListPayload(from: decoder)
            self = .machineList(payload.machines)

        case .streamText:
            let payload = try StreamTextPayload(from: decoder)
            self = .streamText(sessionId: payload.sessionId, content: payload.content)

        case .toolCall:
            let payload = try ToolCallPayload(from: decoder)
            self = .toolCall(sessionId: payload.sessionId, toolName: payload.toolName, display: payload.display)

        case .toolResult:
            let payload = try ToolResultPayload(from: decoder)
            self = .toolResult(sessionId: payload.sessionId, content: payload.content)

        case .userPrompt:
            let payload = try UserPromptPayload(from: decoder)
            self = .userPrompt(payload)

        case .sessionStatus:
            let payload = try SessionStatusPayload(from: decoder)
            self = .sessionStatus(sessionId: payload.sessionId, status: payload.status, lastMessagePreview: payload.lastMessagePreview)

        case .sessionDone:
            let payload = try SessionDonePayload(from: decoder)
            self = .sessionDone(payload)

        case .sessionError:
            let payload = try SessionErrorPayload(from: decoder)
            self = .sessionError(sessionId: payload.sessionId, error: payload.error)

        case .sessionHistory:
            let payload = try SessionHistoryPayload(from: decoder)
            self = .sessionHistory(sessionId: payload.sessionId, requestId: payload.requestId, messages: payload.messages)

        case .error:
            let payload = try ErrorPayload(from: decoder)
            self = .error(message: payload.message)
        }
    }
}

// MARK: - Internal decode-only payloads

private struct SessionListPayload: Decodable {
    let sessions: [SessionMeta]
}

private struct MachineListPayload: Decodable {
    let machines: [MachineInfo]
}

private struct StreamTextPayload: Decodable {
    let sessionId: String
    let content: String
}

private struct ToolCallPayload: Decodable {
    let sessionId: String
    let toolName: String
    let display: String
}

private struct ToolResultPayload: Decodable {
    let sessionId: String
    let content: String
}

private struct SessionStatusPayload: Decodable {
    let sessionId: String
    let status: SessionStatus
    let lastMessagePreview: String?
}

private struct SessionErrorPayload: Decodable {
    let sessionId: String
    let error: String
}

private struct SessionHistoryPayload: Decodable {
    let sessionId: String
    let requestId: String
    let messages: [AnyCodable]
}

private struct ErrorPayload: Decodable {
    let message: String
}
