import Foundation

enum BridgeReadiness {
    struct Snapshot: Sendable {
        let isGatewayIdentified: Bool
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

    static func inspect(
        port: Int = 4317,
        fetch: @escaping @Sendable (URL) async throws -> (Data, URLResponse) = {
            try await URLSession.shared.data(from: $0)
        }
    ) async -> Snapshot {
        let empty = Snapshot(
            isGatewayIdentified: false,
            isReady: false,
            models: [],
            defaultModel: nil,
            providers: [:]
        )
        guard let url = URL(
            string: "http://127.0.0.1:\(port)/__llm_local_gateway/readiness"
        ) else {
            return empty
        }
        do {
            let (readinessData, response) = try await fetch(url)
            guard let http = response as? HTTPURLResponse,
                  [200, 503].contains(http.statusCode),
                  (
                    http.value(forHTTPHeaderField: "x-llm-local-gateway") == "1"
                    || http.value(forHTTPHeaderField: "x-llm-gateway") == "1"
                  ),
                  let readiness = try? JSONDecoder().decode(
                    ReadinessPayload.self,
                    from: readinessData
                  ) else {
                return empty
            }

            var models: [String] = []
            if let modelsURL = URL(
                string: "http://127.0.0.1:\(port)/openai/v1/models"
            ), let result = try? await fetch(modelsURL),
               let modelsHTTP = result.1 as? HTTPURLResponse,
               modelsHTTP.statusCode == 200,
               let payload = try? JSONDecoder().decode(
                ModelsPayload.self,
                from: result.0
               ) {
                models = payload.data.map(\.id)
            }

            return Snapshot(
                isGatewayIdentified: true,
                isReady: readiness.ready,
                models: models,
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
