import Foundation

/// A value that decodes to nil instead of failing. A reply whose `result` is not a full snapshot
/// (a pong, a single alert, the small public reply) must not take the whole line down with it.
struct Lenient<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

/// One line from the daemon, understood. What matters to the client is three things: which request
/// it answers (`id`), whether that request failed (`error`), and whether it carried a full
/// snapshot to show (`snapshot`). Everything else in a reply is optional and ignored.
struct Reply: Equatable {
    var id: Int?
    var error: String?
    var snapshot: Snapshot?
    /// Pushed by a subscription rather than asked for.
    var isEvent: Bool
}

enum Wire {
    private struct Message: Decodable {
        var id: Int?
        var error: String?
        var result: Lenient<Snapshot>?
        var event: Lenient<Snapshot>?
    }

    /// Nil only for something that is not a JSON object at all. A reply that is an object but holds
    /// no snapshot still comes back with its id, because the request that is waiting for it must
    /// be released whatever the reply contains.
    static func parse(_ line: Data) -> Reply? {
        guard !line.isEmpty,
              let first = line.first(where: { $0 != 0x20 && $0 != 0x09 }), first == UInt8(ascii: "{"),
              let msg = try? JSONDecoder().decode(Message.self, from: line) else { return nil }
        if let event = msg.event?.value {
            return Reply(id: msg.id, error: msg.error, snapshot: event, isEvent: true)
        }
        return Reply(id: msg.id, error: msg.error, snapshot: msg.result?.value, isEvent: false)
    }
}
