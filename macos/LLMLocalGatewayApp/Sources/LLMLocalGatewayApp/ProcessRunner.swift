import Darwin
import Foundation

struct ProcessResult: Sendable {
    let status: Int32
    let stdout: String
    let stderr: String
    let timedOut: Bool
}

private final class PipeCapture: @unchecked Sendable {
    private static let maximumBytes = 4 * 1024 * 1024
    private let handle: FileHandle
    private let finished = DispatchSemaphore(value: 0)
    private var data = Data()

    init(_ pipe: Pipe) {
        handle = pipe.fileHandleForReading
    }

    func start() {
        DispatchQueue.global(qos: .utility).async { [self] in
            defer { finished.signal() }
            while let chunk = try? handle.read(upToCount: 64 * 1024),
                  !chunk.isEmpty {
                let remaining = Self.maximumBytes - data.count
                if remaining > 0 {
                    data.append(chunk.prefix(remaining))
                }
            }
        }
    }

    func waitForData() -> Data {
        finished.wait()
        return data
    }
}

enum ProcessRunner {
    static func run(
        executable: URL,
        arguments: [String],
        environment: [String: String]? = nil,
        timeout: TimeInterval = 30
    ) throws -> ProcessResult {
        let process = Process()
        let stdout = Pipe()
        let stderr = Pipe()
        process.executableURL = executable
        process.arguments = arguments
        process.environment = environment
        process.standardOutput = stdout
        process.standardError = stderr
        let finished = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in finished.signal() }
        try process.run()
        let outputCapture = PipeCapture(stdout)
        let errorCapture = PipeCapture(stderr)
        outputCapture.start()
        errorCapture.start()
        let timedOut = finished.wait(timeout: .now() + timeout) == .timedOut
        if timedOut {
            process.terminate()
            if finished.wait(timeout: .now() + 2) == .timedOut {
                kill(process.processIdentifier, SIGKILL)
                _ = finished.wait(timeout: .now() + 2)
            }
        }
        let outputData = outputCapture.waitForData()
        let errorData = errorCapture.waitForData()
        return ProcessResult(
            status: process.terminationStatus,
            stdout: String(decoding: outputData, as: UTF8.self),
            stderr: String(decoding: errorData, as: UTF8.self),
            timedOut: timedOut
        )
    }
}
