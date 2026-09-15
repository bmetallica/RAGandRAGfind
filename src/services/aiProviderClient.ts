import axios from "axios";

export type AiProvider = "ollama" | "openai";

export interface AiProviderConnection {
  provider: AiProvider;
  baseUrl: string;
  apiKey?: string | null;
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

interface OllamaEmbedResponse {
  embeddings?: number[][];
  embedding?: number[];
}

interface OllamaGenerateResponse {
  response?: string;
}

interface OpenAiModelsResponse {
  data?: Array<{ id?: string }>;
}

interface OpenAiEmbeddingsResponse {
  data?: Array<{ embedding?: number[] }>;
}

interface OpenAiChatCompletionsResponse {
  // `reasoning_content` is what vLLM (and llama.cpp with a reasoning parser)
  // puts the chain-of-thought in; some models then leave `content` empty.
  choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
}

// An input longer than the embedding server's physical batch size is rejected
// outright (llama.cpp: "input (N tokens) is too large to process. increase the
// physical batch size"). This is NOT a connectivity problem and must not be
// retried unchanged - the caller has to send less text instead, which is why it
// gets its own type rather than being folded into the generic provider error.
export class EmbeddingInputTooLargeError extends Error {
  constructor(detail: string) {
    super(`embedding input exceeds the provider's limit: ${detail}`);
    this.name = "EmbeddingInputTooLargeError";
  }
}

function isInputTooLargeResponse(error: unknown): string | null {
  if (!axios.isAxiosError(error) || !error.response) {
    return null;
  }

  const data = error.response.data as { error?: { message?: string } } | string | undefined;
  const message = typeof data === "string"
    ? data
    : data?.error?.message ?? "";

  // Covers llama.cpp ("too large to process", "physical batch size"), vLLM and
  // the OpenAI wording ("maximum context length").
  return /too large|too long|physical batch size|maximum context length|exceeds? the maximum/i.test(message)
    ? message
    : null;
}

// Not every OpenAI-compatible server implements structured output the same way.
// vLLM needs a guided-decoding backend for `response_format: json_object` and
// older builds reject it outright; TGI and some proxies do not know the field at
// all. Detect that specific rejection so the request can simply be repeated
// without it - the prompts ask for JSON anyway and the callers parse defensively.
function isUnsupportedResponseFormat(error: unknown): boolean {
  if (!axios.isAxiosError(error) || !error.response) {
    return false;
  }
  if (error.response.status !== 400 && error.response.status !== 422 && error.response.status !== 500) {
    return false;
  }

  const data = error.response.data as { error?: { message?: string }; message?: string } | string | undefined;
  const message = typeof data === "string"
    ? data
    : data?.error?.message ?? data?.message ?? "";
  return /response_format|json_object|guided|structured output|json schema/i.test(message);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function describeError(baseUrl: string, error: unknown): Error {
  if (axios.isAxiosError(error)) {
    // A response means the server WAS reached and answered. Reporting that as
    // "failed to reach" sends an operator hunting for a network or firewall
    // problem when the actual fault sits in the model server - a missing
    // dependency, a model that will not load, a rejected request. Keep the two
    // apart and surface the upstream message verbatim.
    if (error.response) {
      const data = error.response.data as { error?: { message?: string }; message?: string; detail?: string } | string | undefined;
      const message = typeof data === "string"
        ? data
        : data?.error?.message ?? data?.message ?? data?.detail ?? JSON.stringify(data ?? {});
      return new Error(`AI provider at ${baseUrl} answered HTTP ${error.response.status}: ${message}`);
    }

    return new Error(`failed to reach AI provider at ${baseUrl}: ${error.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function openAiHeaders(connection: AiProviderConnection): Record<string, string> {
  return connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {};
}

export async function checkReachable(connection: AiProviderConnection, timeoutMs = 5_000): Promise<void> {
  const baseUrl = trimTrailingSlash(connection.baseUrl);
  if (connection.provider === "openai") {
    await axios.get(`${baseUrl}/models`, { timeout: timeoutMs, headers: openAiHeaders(connection) });
    return;
  }

  await axios.get(`${baseUrl}/api/tags`, { timeout: timeoutMs });
}

export async function listModels(connection: AiProviderConnection, timeoutMs = 10_000): Promise<string[]> {
  const baseUrl = trimTrailingSlash(connection.baseUrl);

  try {
    if (connection.provider === "openai") {
      const response = await axios.get<OpenAiModelsResponse>(`${baseUrl}/models`, {
        timeout: timeoutMs,
        headers: openAiHeaders(connection)
      });
      return (response.data.data ?? [])
        .map((entry) => entry.id?.trim())
        .filter((id): id is string => Boolean(id))
        .sort((left, right) => left.localeCompare(right));
    }

    const response = await axios.get<OllamaTagsResponse>(`${baseUrl}/api/tags`, { timeout: timeoutMs });
    return (response.data.models ?? [])
      .map((entry) => (entry.name ?? entry.model)?.trim())
      .filter((name): name is string => Boolean(name))
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    throw describeError(baseUrl, error);
  }
}

export async function requestEmbeddings(
  connection: AiProviderConnection,
  texts: string[],
  model: string,
  timeoutMs = 60_000
): Promise<number[][]> {
  const baseUrl = trimTrailingSlash(connection.baseUrl);

  try {
    if (connection.provider === "openai") {
      const response = await axios.post<OpenAiEmbeddingsResponse>(
        `${baseUrl}/embeddings`,
        { model, input: texts },
        { timeout: timeoutMs, headers: openAiHeaders(connection) }
      );
      return (response.data.data ?? []).map((entry) => entry.embedding ?? []);
    }

    const response = await axios.post<OllamaEmbedResponse>(
      `${baseUrl}/api/embed`,
      { model, input: texts },
      { timeout: timeoutMs }
    );
    return response.data.embeddings ?? (response.data.embedding ? [response.data.embedding] : []);
  } catch (error) {
    const tooLarge = isInputTooLargeResponse(error);
    if (tooLarge) {
      throw new EmbeddingInputTooLargeError(tooLarge);
    }
    throw describeError(baseUrl, error);
  }
}

export async function requestGeneration(
  connection: AiProviderConnection,
  prompt: string,
  model: string,
  options?: { jsonResponse?: boolean; timeoutMs?: number; temperature?: number }
): Promise<string> {
  const baseUrl = trimTrailingSlash(connection.baseUrl);
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const temperature = options?.temperature ?? 0.1;

  try {
    if (connection.provider === "openai") {
      const requestBody = (withResponseFormat: boolean) => ({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature,
        ...(withResponseFormat && options?.jsonResponse ? { response_format: { type: "json_object" } } : {})
      });

      let response;
      try {
        response = await axios.post<OpenAiChatCompletionsResponse>(
          `${baseUrl}/chat/completions`,
          requestBody(true),
          { timeout: timeoutMs, headers: openAiHeaders(connection) }
        );
      } catch (error) {
        if (!options?.jsonResponse || !isUnsupportedResponseFormat(error)) {
          throw error;
        }

        response = await axios.post<OpenAiChatCompletionsResponse>(
          `${baseUrl}/chat/completions`,
          requestBody(false),
          { timeout: timeoutMs, headers: openAiHeaders(connection) }
        );
      }

      const message = response.data.choices?.[0]?.message;
      // A reasoning model can put everything into `reasoning_content` and leave
      // `content` empty. That text still contains the answer, and every caller
      // extracts the JSON object from it rather than trusting the exact shape.
      const text = message?.content?.trim() || message?.reasoning_content?.trim();
      if (!text) {
        throw new Error("empty response from OpenAI-compatible chat completions API");
      }
      return text;
    }

    const response = await axios.post<OllamaGenerateResponse>(
      `${baseUrl}/api/generate`,
      {
        model,
        prompt,
        stream: false,
        ...(options?.jsonResponse ? { format: "json" } : {}),
        options: { temperature }
      },
      { timeout: timeoutMs }
    );
    const text = response.data.response?.trim();
    if (!text) {
      throw new Error("empty response from Ollama generate API");
    }
    return text;
  } catch (error) {
    if (error instanceof Error && /empty response/.test(error.message)) {
      throw error;
    }
    throw describeError(baseUrl, error);
  }
}
