// Read only selector metadata in memory. Never persist protobuf frames, request
// bodies, headers, tool arguments, generated text, or provider-private thinking.
// Install after startBridge so the embedded config reads its isolated DATA_DIR.
export async function observeDevinWire() {
  const [{ __setRequestImpl }, { parseFields }, { StreamingFrameParser }, { default: https }] = await Promise.all([
    import("windsurf-api/src/devin-connect.js"),
    import("windsurf-api/src/proto.js"),
    import("windsurf-api/src/connect.js"),
    import("node:https"),
  ]);
  const requests = [];
  const modelId = (buffer) => {
    const value = buffer?.toString("utf8");
    return /^(swe-2-(medium|high|max)|gpt-6-astra-(low|medium|high|xhigh|max))$/.test(value ?? "") ? value : "unexpected";
  };
  __setRequestImpl((options, callback) => {
    const record = { selector: null, upstreamModel: null, status: null, ended: false, error: false };
    requests.push(record);
    const request = https.request(options, (response) => {
      record.status = response.statusCode;
      const parser = new StreamingFrameParser();
      if (response.statusCode === 200) response.on("data", (chunk) => {
        try {
          parser.push(chunk);
          for (const frame of parser.drain()) {
            if (frame.isEndStream) {
              record.ended = true;
              const error = JSON.parse(frame.payload.toString() || "{}").error;
              record.error = Boolean(error);
              if (error) {
                record.errorCode = ["invalid_argument", "permission_denied", "unauthenticated", "resource_exhausted", "internal", "unavailable", "not_found", "failed_precondition"].includes(error.code) ? error.code : "other";
                record.errorCategories = ["model", "quota", "credit", "limit", "tool", "system", "message", "permission", "billing", "unsupported", "thinking", "reasoning", "access", "subscription", "content policy", "blocked", "sensitive", "mcp", "configuration", "authentication", "expired"].filter((term) => String(error.message).toLowerCase().includes(term));
              }
            } else {
              const meta = parseFields(frame.payload).find((f) => f.field === 7 && f.wireType === 2);
              const model = meta && parseFields(meta.value).find((f) => f.field === 9 && f.wireType === 2);
              if (model) record.upstreamModel = modelId(model.value);
            }
          }
        } catch { record.error = true; }
      });
      callback(response);
    });
    // The pinned implementation writes one uncompressed Connect envelope.
    // Merely inspect it; the exact original Buffer is passed to https.request.
    const inspect = (data) => {
      if (!Buffer.isBuffer(data) || data[0] !== 0 || data.length < 5
          || data.readUInt32BE(1) !== data.length - 5) return;
      try {
        const selector = parseFields(data.subarray(5)).find((f) => f.field === 21 && f.wireType === 2);
        if (selector) record.selector = modelId(selector.value);
      } catch { record.error = true; }
    };
    const write = request.write.bind(request);
    const end = request.end.bind(request);
    request.write = (data, ...args) => { inspect(data); return write(data, ...args); };
    request.end = (data, ...args) => { inspect(data); return end(data, ...args); };
    return request;
  });
  return { requests, restore: () => __setRequestImpl(null) };
}
