import Foundation
import Testing
@testable import LLMLocalGatewayApp

@Test func drainsLargeStandardOutputAndErrorWithoutDeadlocking() throws {
    let command = """
    i=0
    while [ "$i" -lt 12000 ]; do
      printf 'stdout-%05d\n' "$i"
      printf 'stderr-%05d\n' "$i" >&2
      i=$((i + 1))
    done
    """

    let result = try ProcessRunner.run(
        executable: URL(filePath: "/bin/sh"),
        arguments: ["-c", command],
        timeout: 10
    )

    #expect(!result.timedOut)
    #expect(result.status == 0)
    #expect(result.stdout.contains("stdout-11999"))
    #expect(result.stderr.contains("stderr-11999"))
}
