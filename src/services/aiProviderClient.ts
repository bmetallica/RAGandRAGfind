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
  choices?: Array<{ message?: { content?: string } }>;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function describeError(baseUrl: string, error: unknown): Error {
  if (axios.isAxiosError(error)) {
    const detail = error.response?.data ?? error.message;
    return new Error(`failed to reach AI provider at ${baseUrl}: ${JSON.stringify(detail)}`);
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
      const response = await axios.post<OpenAiChatCompletionsResponse>(
        `${baseUrl}/chat/completions`,
        {
          model,
          messages: [{ role: "user", content: prompt }],
          temperature,
          ...(options?.jsonResponse ? { response_format: { type: "json_object" } } : {})
        },
        { timeout: timeoutMs, headers: openAiHeaders(connection) }
      );
      const text = response.data.choices?.[0]?.message?.content?.trim();
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
