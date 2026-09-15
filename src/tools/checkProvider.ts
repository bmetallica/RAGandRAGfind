import axios from "axios";
import {
  EmbeddingInputTooLargeError,
  checkReachable,
  listModels,
  requestEmbeddings,
  requestGeneration,
  type AiProvider,
  type AiProviderConnection
} from "../services/aiProviderClient";
import { resolveTaskPrefix } from "../services/embeddingInputService";

// Probes an OpenAI-compatible (or Ollama) endpoint with the exact client code
// the application uses, so "it works with vLLM" is something you verify rather
// than something you hope. Needs no database and changes nothing on the server.

interface CliOptions {
  provider: AiProvider;
  baseUrl: string;
  apiKey: string | null;
  embeddingModel: string | null;
  llmModel: string | null;
  rerankerUrl: string | null;
  rerankerModel: string | null;
}

type Status = "ok" | "warn" | "fail" | "skip";

const results: Array<{ status: Status; label: string; detail: string }> = [];

function record(status: Status, label: string, detail: string): void {
  const icon = { ok: "OK  ", warn: "WARN", fail: "FEHL", skip: "--  " }[status];
  process.stdout.write(`  [${icon}] ${label}\n         ${detail}\n`);
  results.push({ status, label, detail });
}

function describe(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data;
    const detail = typeof data === "string" ? data : JSON.stringify(data ?? error.message);
    return `HTTP ${error.response?.status ?? "?"}: ${detail.slice(0, 220)}`;
  }
  return error instanceof Error ? error.message.slice(0, 220) : String(error);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    provider: "openai",
    baseUrl: "",
    apiKey: null,
    embeddingModel: null,
    llmModel: null,
    rerankerUrl: null,
    rerankerModel: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].includes("=")
      ? [argv[index].slice(0, argv[index].indexOf("=")), argv[index].slice(argv[index].indexOf("=") + 1)]
      : [argv[index], null];
    const value = (): string => {
      if (inline !== null) {
        return inline;
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`missing value for ${flag}`);
      }
      index += 1;
      return next;
    };

    switch (flag) {
      case "--provider": {
        const provider = value();
        if (provider !== "openai" && provider !== "ollama") {
          throw new Error("--provider must be 'openai' or 'ollama'");
        }
        options.provider = provider;
        break;
      }
      case "--base-url": options.baseUrl = value(); break;
      case "--api-key": options.apiKey = value(); break;
      case "--embedding-model": options.embeddingModel = value(); break;
      case "--llm-model": options.llmModel = value(); break;
      case "--reranker-url": options.rerankerUrl = value(); break;
      case "--reranker-model": options.rerankerModel = value(); break;
      case "--help":
        process.stdout.write(
          [
            "Usage: npm run check:provider -- --base-url <url> [options]",
            "",
            "  --base-url <url>          z.B. http://host:8000/v1 (vLLM) oder http://host:11434 (Ollama)",
            "  --provider <openai|ollama>  Default: openai",
            "  --api-key <key>           nur wenn der Server Authentifizierung verlangt",
            "  --embedding-model <name>  Embedding-Modell, das geprueft werden soll",
            "  --llm-model <name>        Modell fuer Klassifikation/Zusammenfassung",
            "  --reranker-url <url>      Basis-URL des Rerankers (optional)",
            "  --reranker-model <name>   Reranker-Modell (optional)",
            ""
          ].join("\n")
        );
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        throw new Error(`unknown argument: ${argv[index]}`);
    }
  }

  if (!options.baseUrl) {
    throw new Error("--base-url is required (see --help)");
  }

  return options;
}

async function checkModels(connection: AiProviderConnection, options: CliOptions): Promise<string[]> {
  try {
    await checkReachable(connection, 15_000);
  } catch (error) {
    record("fail", "Erreichbarkeit", describe(error));
    return [];
  }

  try {
    const models = await listModels(connection, 20_000);
    record("ok", "Erreichbarkeit und Modell-Liste", `${models.length} Modelle: ${models.slice(0, 6).join(", ")}${models.length > 6 ? " ..." : ""}`);

    for (const [label, name] of [["Embedding-Modell", options.embeddingModel], ["LLM-Modell", options.llmModel]] as Array<[string, string | null]>) {
      if (!name) {
        continue;
      }
      if (models.includes(name)) {
        record("ok", `${label} vorhanden`, name);
      } else {
        record("warn", `${label} nicht in der Liste`, `"${name}" fehlt - manche Server listen nur geladene Modelle, ein Test folgt trotzdem.`);
      }
    }

    return models;
  } catch (error) {
    record("fail", "Modell-Liste", describe(error));
    return [];
  }
}

async function checkEmbeddings(connection: AiProviderConnection, model: string): Promise<number | null> {
  let dimension: number | null = null;

  try {
    const [vector] = await requestEmbeddings(connection, ["Dies ist ein deutscher Testsatz für die Einbettung."], model, 60_000);
    if (!vector || vector.length === 0) {
      record("fail", "Embedding (einzeln)", "leerer Vektor zurueckgekommen");
      return null;
    }
    dimension = vector.length;
    record("ok", "Embedding (einzeln)", `Dimension ${dimension}`);
  } catch (error) {
    record("fail", "Embedding (einzeln)", describe(error));
    return null;
  }

  // The ingestion path always sends batches; a server that only answers with a
  // single vector would silently break it.
  try {
    const batch = await requestEmbeddings(connection, ["Erster Abschnitt.", "Zweiter Abschnitt.", "Dritter Abschnitt."], model, 60_000);
    if (batch.length !== 3) {
      record("fail", "Embedding (Batch)", `3 Texte geschickt, ${batch.length} Vektoren erhalten - der Ingest-Pfad braucht 1:1`);
    } else if (batch.some((vector) => vector.length !== dimension)) {
      record("fail", "Embedding (Batch)", "unterschiedliche Dimensionen innerhalb eines Batches");
    } else {
      record("ok", "Embedding (Batch von 3)", `3 Vektoren, jeweils Dimension ${dimension}`);
    }
  } catch (error) {
    record("fail", "Embedding (Batch)", describe(error));
  }

  for (const task of ["document", "query"] as const) {
    const prefix = resolveTaskPrefix(model, task);
    if (prefix) {
      record("ok", `Task-Prefix (${task})`, `"${prefix}" wird automatisch gesetzt`);
    } else {
      record("warn", `Task-Prefix (${task})`, `keiner - passt fuer bge-m3/jina/qwen3-embedding. Andernfalls EMBEDDING_${task === "document" ? "DOCUMENT" : "QUERY"}_PREFIX setzen.`);
    }
  }

  return dimension;
}

// Longest accepted input, found by bisection. Tells an operator directly whether
// the server's limit is above the chunk sizes this application produces.
async function checkInputLimit(connection: AiProviderConnection, model: string): Promise<void> {
  const sample = "Der Dienstplan für den Maiausschank enthält die Schichteinteilung der Getränkeausgabe und des Grillstands. ";
  const build = (chars: number): string => sample.repeat(Math.ceil(chars / sample.length)).slice(0, chars);

  const accepts = async (chars: number): Promise<boolean> => {
    try {
      await requestEmbeddings(connection, [build(chars)], model, 120_000);
      return true;
    } catch (error) {
      if (error instanceof EmbeddingInputTooLargeError) {
        return false;
      }
      throw error;
    }
  };

  try {
    const ceiling = 32_000;
    if (await accepts(ceiling)) {
      record("ok", "Eingabelimit", `mindestens ${ceiling} Zeichen - mehr als genug`);
      return;
    }

    let low = 200;
    let high = ceiling;
    while (high - low > 250) {
      const middle = Math.floor((low + high) / 2);
      if (await accepts(middle)) {
        low = middle;
      } else {
        high = middle;
      }
    }

    // ~3 characters per token for German prose; CHUNK_SIZE 300 plus the context
    // header lands around 1700 characters in the worst case.
    const status = low >= 2_000 ? "ok" : low >= 1_400 ? "warn" : "fail";
    const advice = low >= 2_000
      ? "reicht fuer die Chunk-Groessen dieser Anwendung"
      : low >= 1_400
        ? "knapp - lange Chunks werden gekuerzt. vLLM: --max-model-len erhoehen, llama.cpp: --ubatch-size."
        : "zu klein - viele Chunks werden gekuerzt. vLLM: --max-model-len erhoehen, llama.cpp: --ubatch-size.";
    record(status, "Eingabelimit", `~${low} Zeichen deutscher Text (~${Math.round(low / 3)} Token) - ${advice}`);
  } catch (error) {
    record("warn", "Eingabelimit", `nicht bestimmbar: ${describe(error)}`);
  }
}

async function checkGeneration(connection: AiProviderConnection, model: string): Promise<void> {
  try {
    const text = await requestGeneration(connection, "Antworte mit genau einem Wort: Test", model, { timeoutMs: 120_000 });
    record("ok", "Textgenerierung", `Antwort erhalten (${text.length} Zeichen)`);
  } catch (error) {
    record("fail", "Textgenerierung", describe(error));
    return;
  }

  // The document classifier depends on this. `requestGeneration` retries without
  // `response_format` when the server rejects it, so a pass here can mean either
  // native support or a successful fallback - both are fine for the application.
  try {
    const text = await requestGeneration(
      connection,
      'Antworte ausschliesslich mit JSON in der Form {"documentType":"invoice"}.',
      model,
      { jsonResponse: true, timeoutMs: 120_000 }
    );
    const looksLikeJson = /\{[\s\S]*\}/.test(text);
    if (looksLikeJson) {
      record("ok", "JSON-Antwort (Klassifikation)", "verwertbares JSON erhalten");
    } else {
      record("warn", "JSON-Antwort (Klassifikation)", `kein JSON erkennbar: ${text.slice(0, 120)}`);
    }
  } catch (error) {
    record("fail", "JSON-Antwort (Klassifikation)", describe(error));
  }
}

async function checkReranker(baseUrl: string, model: string, apiKey: string | null): Promise<void> {
  const root = baseUrl.replace(/\/+$/, "");
  const paths = root.endsWith("/v1") ? ["/rerank", "/v2/rerank"] : ["/v1/rerank", "/rerank", "/v2/rerank"];
  const body = {
    model,
    query: "Wer hatte beim Maiausschank Dienst am Grill?",
    documents: [
      "Die Lizenz dieses Projekts ist MIT. Copyright 2024.",
      "Maiausschank Dienstplan 2017 - Grill: Christopher und Otto, Schicht 10 bis 15 Uhr.",
      "Rechnung Nr. 4711 vom 03.09.2023, Betrag 84,50 EUR."
    ],
    top_n: 3
  };

  for (const path of paths) {
    try {
      const response = await axios.post<{ results?: Array<{ index?: number; relevance_score?: number; score?: number }> }>(
        `${root}${path}`,
        body,
        { timeout: 120_000, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} }
      );

      const rows = response.data.results ?? [];
      if (rows.length === 0) {
        record("fail", `Reranker (${path})`, "Antwort ohne results-Feld");
        return;
      }

      const best = rows.reduce((a, b) => ((b.relevance_score ?? b.score ?? 0) > (a.relevance_score ?? a.score ?? 0) ? b : a));
      if (best.index === 1) {
        record("ok", `Reranker (${path})`, `sortiert korrekt, beste Passage hat Score ${(best.relevance_score ?? best.score ?? 0).toFixed(3)}`);
      } else {
        record("warn", `Reranker (${path})`, `antwortet, sortiert die erwartete Passage aber nicht nach oben (Index ${best.index})`);
      }
      return;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        continue;
      }
      record("fail", `Reranker (${path})`, describe(error));
      return;
    }
  }

  record("fail", "Reranker", `kein Rerank-Endpunkt gefunden (geprueft: ${paths.join(", ")})`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const connection: AiProviderConnection = {
    provider: options.provider,
    baseUrl: options.baseUrl,
    apiKey: options.apiKey
  };

  process.stdout.write(`\nPruefe ${options.provider === "openai" ? "OpenAI-kompatiblen" : "Ollama"} Endpunkt ${options.baseUrl}\n\n`);

  await checkModels(connection, options);

  let dimension: number | null = null;
  if (options.embeddingModel) {
    dimension = await checkEmbeddings(connection, options.embeddingModel);
    if (dimension !== null) {
      await checkInputLimit(connection, options.embeddingModel);
    }
  } else {
    record("skip", "Embedding", "kein --embedding-model angegeben");
  }

  if (options.llmModel) {
    await checkGeneration(connection, options.llmModel);
  } else {
    record("skip", "Textgenerierung", "kein --llm-model angegeben");
  }

  if (options.rerankerUrl && options.rerankerModel) {
    await checkReranker(options.rerankerUrl, options.rerankerModel, options.apiKey);
  } else {
    record("skip", "Reranker", "kein --reranker-url / --reranker-model angegeben");
  }

  const failed = results.filter((entry) => entry.status === "fail");
  const warned = results.filter((entry) => entry.status === "warn");

  process.stdout.write("\n");
  if (failed.length === 0) {
    process.stdout.write(`Ergebnis: nutzbar${warned.length > 0 ? ` (${warned.length} Hinweis(e))` : ""}.\n`);
    if (dimension !== null) {
      process.stdout.write(
        [
          "",
          "Im Admin-UI unter Config-AI eintragen:",
          `  Provider:              ${options.provider === "openai" ? "OpenAI-kompatibel" : "Ollama"}`,
          `  Basis-URL:             ${options.baseUrl}`,
          `  API-Key:               ${options.apiKey ? "wie geprueft" : "leer lassen"}`,
          `  Embedding-Modell:      ${options.embeddingModel}`,
          `  Embedding-Dimension:   ${dimension}`,
          ...(options.rerankerUrl ? [`  Reranker:              ${options.rerankerUrl} / ${options.rerankerModel}`] : []),
          "",
          ...(dimension !== 768
            ? [
                `ACHTUNG: Dimension ${dimension} weicht vom Bestand ab. Vor dem Umschalten:`,
                `  ALTER TABLE document_chunks ALTER COLUMN embedding TYPE VECTOR(${dimension});`,
                "  Danach Index neu bauen und ein vollstaendiges Re-Embedding starten.",
                ""
              ]
            : [])
        ].join("\n")
      );
    }
  } else {
    process.stdout.write(`Ergebnis: NICHT nutzbar - ${failed.length} Pruefung(en) fehlgeschlagen:\n`);
    for (const entry of failed) {
      process.stdout.write(`  - ${entry.label}: ${entry.detail}\n`);
    }
  }

  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
