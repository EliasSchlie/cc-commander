import Foundation

/// Messages sent from the hub to a device, decoded from JSON with a "type" discriminator.
public enum ServerMessage: Sendable {
    case sessionList([SessionMeta])
    case machineList([MachineInfo])
    case streamText(sessionId: String, content: String)
    case toolCall(sessionId: String, toolCallId: String, toolName: String, display: String)
    case toolResult(sessionId: String, toolCallId: String, content: String)
    case userPrompt(UserPromptPayload)
    case sessionStatus(sessionId: String, status: SessionStatus, lastMessagePreview: String?)
    case sessionDone(SessionDonePayload)
    case sessionError(sessionId: String, error: String)
    case sessionHistory(sessionId: String, requestId: String, messages: [AnyCodable], error: String?)
    case error(message: String)
}

extension ServerMessage: Decodable {
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

    private enum CodingKeys: String, CodingKey {
        case type, sessions, machines, sessionId, content, toolCallId, toolName, display
        case status, lastMessagePreview, error, requestId, messages, message
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(MessageType.self, forKey: .type)

        switch type {
        case .sessionList:
            self = .sessionList(try c.decode([SessionMeta].self, forKey: .sessions))

        case .machineList:
            self = .machineList(try c.decode([MachineInfo].self, forKey: .machines))

        case .streamText:
            self = .streamText(
                sessionId: try c.decode(String.self, forKey: .sessionId),
                content: try c.decode(String.self, forKey: .content)
            )

        case .toolCall:
            self = .toolCall(
                sessionId: try c.decode(String.self, forKey: .sessionId),
                toolCallId: try c.decode(String.self, forKey: .toolCallId),
                toolName: try c.decode(String.self, forKey: .toolName),
                display: try c.decode(String.self, forKey: .display)
            )

        case .toolResult:
            self = .toolResult(
                sessionId: try c.decode(String.self, forKey: .sessionId),
                toolCallId: try c.decode(String.self, forKey: .toolCallId),
                content: try c.decode(String.self, forKey: .content)
            )

        case .userPrompt:
            self = .userPrompt(try UserPromptPayload(from: decoder))

        case .sessionStatus:
            self = .sessionStatus(
                sessionId: try c.decode(String.self, forKey: .sessionId),
                status: try c.decode(SessionStatus.self, forKey: .status),
                lastMessagePreview: try c.decodeIfPresent(String.self, forKey: .lastMessagePreview)
            )

        case .sessionDone:
            self = .sessionDone(try SessionDonePayload(from: decoder))

        case .sessionError:
            self = .sessionError(
                sessionId: try c.decode(String.self, forKey: .sessionId),
                error: try c.decode(String.self, forKey: .error)
            )

        case .sessionHistory:
            self = .sessionHistory(
                sessionId: try c.decode(String.self, forKey: .sessionId),
                requestId: try c.decode(String.self, forKey: .requestId),
                messages: try c.decode([AnyCodable].self, forKey: .messages),
                error: try c.decodeIfPresent(String.self, forKey: .error)
            )

        case .error:
            self = .error(message: try c.decode(String.self, forKey: .message))
        }
    }
}
