import Foundation

public struct UserPromptQuestion: Codable, Sendable {
    public let question: String
    public let header: String?
    public let options: [OptionLabel]?
    public let multiSelect: Bool?

    public struct OptionLabel: Codable, Sendable {
        public let label: String

        public init(label: String) {
            self.label = label
        }
    }

    public init(question: String, header: String? = nil, options: [OptionLabel]? = nil, multiSelect: Bool? = nil) {
        self.question = question
        self.header = header
        self.options = options
        self.multiSelect = multiSelect
    }
}

public struct UserPromptPayload: Codable, Sendable {
    public let sessionId: String
    public let promptId: String
    public let toolName: String
    public let questions: [UserPromptQuestion]?
    public let title: String?
    public let input: [String: AnyCodable]?

    public init(
        sessionId: String,
        promptId: String,
        toolName: String,
        questions: [UserPromptQuestion]? = nil,
        title: String? = nil,
        input: [String: AnyCodable]? = nil
    ) {
        self.sessionId = sessionId
        self.promptId = promptId
        self.toolName = toolName
        self.questions = questions
        self.title = title
        self.input = input
    }
}

public struct SessionDonePayload: Codable, Sendable {
    public let sessionId: String
    public let sdkSessionId: String
    public let numTurns: Int
    public let durationMs: Int
    public let totalCostUsd: Double?

    public init(sessionId: String, sdkSessionId: String, numTurns: Int, durationMs: Int, totalCostUsd: Double? = nil) {
        self.sessionId = sessionId
        self.sdkSessionId = sdkSessionId
        self.numTurns = numTurns
        self.durationMs = durationMs
        self.totalCostUsd = totalCostUsd
    }
}

public enum UserPromptResponse: Codable, Sendable {
    case answers([String: String])
    case allow(updatedInput: [String: AnyCodable]? = nil)
    case deny(message: String? = nil)

    private enum CodingKeys: String, CodingKey {
        case kind, answers, updatedInput, message
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .answers(let answers):
            try container.encode("answers", forKey: .kind)
            try container.encode(answers, forKey: .answers)
        case .allow(let updatedInput):
            try container.encode("allow", forKey: .kind)
            try container.encodeIfPresent(updatedInput, forKey: .updatedInput)
        case .deny(let message):
            try container.encode("deny", forKey: .kind)
            try container.encodeIfPresent(message, forKey: .message)
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "answers":
            let answers = try container.decode([String: String].self, forKey: .answers)
            self = .answers(answers)
        case "allow":
            let updatedInput = try container.decodeIfPresent([String: AnyCodable].self, forKey: .updatedInput)
            self = .allow(updatedInput: updatedInput)
        case "deny":
            let message = try container.decodeIfPresent(String.self, forKey: .message)
            self = .deny(message: message)
        default:
            throw DecodingError.dataCorrupted(.init(codingPath: [CodingKeys.kind], debugDescription: "Unknown kind: \(kind)"))
        }
    }
}

/// Type-erased Codable value for opaque JSON fields (input, updatedInput, messages).
public enum AnyCodable: Codable, Sendable, Equatable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case dictionary([String: AnyCodable])
    case array([AnyCodable])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let v = try? container.decode(Bool.self) {
            self = .bool(v)
        } else if let v = try? container.decode(Int.self) {
            self = .int(v)
        } else if let v = try? container.decode(Double.self) {
            self = .double(v)
        } else if let v = try? container.decode(String.self) {
            self = .string(v)
        } else if let v = try? container.decode([String: AnyCodable].self) {
            self = .dictionary(v)
        } else if let v = try? container.decode([AnyCodable].self) {
            self = .array(v)
        } else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Cannot decode AnyCodable"))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let v): try container.encode(v)
        case .int(let v): try container.encode(v)
        case .double(let v): try container.encode(v)
        case .bool(let v): try container.encode(v)
        case .dictionary(let v): try container.encode(v)
        case .array(let v): try container.encode(v)
        case .null: try container.encodeNil()
        }
    }
}
