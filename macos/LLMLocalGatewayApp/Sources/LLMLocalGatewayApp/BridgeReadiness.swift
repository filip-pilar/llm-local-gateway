import Foundation

enum BridgeReadiness {
    struct Snapshot: Sendable {
        let isReady: Bool
        let models: [String]
        let defaultModel: String?
        let providers: [String: Bool]

        func isProviderReady(_ provider: String) -> Bool {
            providers[provider] == true
        }
    }

    static func verify(port: Int = 4317) async -> Bool {
        await inspect(port: port).isReady
    }

    static func inspect(port: Int = 4317) async -> Snapshot {
        let empty = Snapshot(isReady: false, models: [], defaultModel: nil, providers: [:])
        guard let url = URL(
            string: "http://127.0.0.1:\(port)/__llm_local_gateway/readiness"
        ) else {
            return empty
        }
        do {
            let (readinessData, response) = try await URLSession.shared.data(from: url)
            guard let http = response as? HTTPURLResponse,
                  [200, 503].contains(http.statusCode),
                  (
                    http.value(forHTTPHeaderField: "x-llm-local-gateway") == "1"
                    || http.value(forHTTPHeaderField: "x-llm-gateway") == "1"
                  ),
                  let readiness = try? JSONDecoder().decode(ReadinessPayload.self, from: readinessData),
                  let modelsURL = URL(string: "http://127.0.0.1:\(port)/openai/v1/models") else {
                return empty
            }
            let (data, modelsResponse) = try await URLSession.shared.data(from: modelsURL)
            guard let modelsHTTP = modelsResponse as? HTTPURLResponse,
                  modelsHTTP.statusCode == 200,
                  let payload = try? JSONDecoder().decode(ModelsPayload.self, from: data) else {
                return empty
            }
            return Snapshot(
                isReady: readiness.ready,
                models: payload.data.map(\.id),
                defaultModel: readiness.default_model,
                providers: readiness.providers.mapValues(\.ready)
            )
        } catch {
            return empty
        }
    }

    private struct ModelsPayload: Decodable {
        let data: [Model]
    }

    private struct Model: Decodable {
        let id: String
    }

    private struct ReadinessPayload: Decodable {
        let ready: Bool
        let default_model: String
        let providers: [String: Provider]
    }

    private struct Provider: Decodable {
        let ready: Bool
    }
}
