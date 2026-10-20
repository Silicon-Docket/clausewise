import { json } from "./anthropic-support.js";

/** A Chat Completions answer, as the openai-compatible provider reads it. */
export function chatCompletion(text: string, finishReason = "stop"): Response {
  return json({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "llama3.1",
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: finishReason },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

/** A Responses API answer, as the openai provider reads it. */
export function openaiResponse(text: string): Response {
  return json({
    id: "resp_test",
    object: "response",
    created_at: 1,
    model: "test-model",
    output: [
      {
        type: "message",
        role: "assistant",
        id: "msg_test",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

/** An OpenAI-style error body: `{"error": {"message", "type", "code"}}`. */
export function openaiError(
  status: number,
  error: { message: string; type?: string; code?: string | null },
): Response {
  return json(
    { error: { message: error.message, type: error.type ?? null, code: error.code ?? null } },
    status,
  );
}
