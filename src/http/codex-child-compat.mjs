const CODEX_CHILD_HEADER = "x-openai-subagent";
const COMPACT_EXEC_DESCRIPTION = "Run raw JavaScript to compose the child coding tools available on the `tools` object. Inspect `ALL_TOOLS` for deferred tools. For a safe shell read, call `await tools.exec_command({cmd, workdir, yield_time_ms, max_output_tokens})`, then return its output with `text(result.output)`.";

function compactChildTool(tool) {
  if (tool?.type !== "custom" || tool?.name !== "exec" || typeof tool.description !== "string") return tool;
  return { ...tool, description: COMPACT_EXEC_DESCRIPTION };
}

export function prepareCodexChildRequest(headers, body) {
  if (typeof headers?.[CODEX_CHILD_HEADER] !== "string") return { body, changed: false };
  if (!body || typeof body !== "object" || Array.isArray(body)) return { body, changed: false };
  if (Array.isArray(body.tools) && body.tools.length > 0) return { body, changed: false };
  if (!Array.isArray(body.input)) return { body, changed: false };

  const declarations = body.input.filter((item) => item?.type === "additional_tools");
  if (declarations.length === 0) return { body, changed: false };
  const tools = declarations.flatMap((item) => Array.isArray(item.tools) ? item.tools : []).map(compactChildTool);
  if (tools.length === 0) return { body, changed: false };

  return {
    changed: true,
    body: {
      ...body,
      tools,
      input: body.input.filter((item) => item?.type !== "additional_tools"),
    },
  };
}
