# RAG and RAGfind

Document-centric RAG platform with ingestion, hybrid retrieval, MCP integration, admin tooling, and a separate local-first search UI called `RAGfind`.

The stack ingests uploads, synced folders, crawled websites, and git repositories; extracts and structures their content; stores embeddings and metadata in PostgreSQL; exposes document-centric APIs and MCP tools; and provides two operator-facing surfaces:

- the admin and operations console on port `3311`
- the end-user search interface `RAGfind` on port `3312`

## What The Project Does

This repository is built for teams that need more than raw vector search.

It combines:

- ingestion for uploads, local folders, websites, and git repositories
- OCR fallback for scanned or difficult documents
- hybrid search across vector, keyword, fuzzy, and document-aware reranking signals
- persisted document structure with sections and chunk-to-section mapping
- document analysis workflows for actions, decisions, deadlines, risks, requirements, setup steps, config keys, API surfaces, and summaries
- MCP access over HTTP and stdio for Open WebUI and other MCP-capable clients
- knowledge-base-aware admin controls and principal-based access scope
- `RAGfind`, a separate search frontend with a local multisource viewer for HTML, Markdown, code, and plaintext

## Current Runtime Surfaces

### Admin / API / MCP

- URL: `http://localhost:3311`
- provides the operator UI, ingestion forms, document browser, admin settings, document APIs, and MCP endpoint
- Basic Auth is enabled for the admin console and admin APIs
- default login is `admin` / `admin` until changed in the UI

### RAGfind

- URL: `http://localhost:3312`
- separate search container and frontend
- search scope is configurable from the admin UI on port `3311`
- search is limited to the knowledge bases selected for `RAGfind`
- search results open in a local multisource viewer instead of jumping straight to remote pages

### MCP

- HTTP endpoint: `http://localhost:3311/mcp`
- local stdio entrypoint: `npm run dev:mcp:stdio` or `npm run start:mcp:stdio`

## Key Features

### Ingestion

- manual uploads
- import directory sync via mounted folder, by default with one subdirectory per knowledge base (see [Directory sync per knowledge base](#directory-sync-per-knowledge-base))
- recursive website crawling with file download support
- git repository sync with optional branch and subpath scoping
- extraction for PDF, DOCX, ODT, TXT, Markdown, HTML, JSON, YAML, SQL, JS, TS, Python, shell scripts, and other text/code formats
- OCR fallback using Tesseract and Ghostscript when direct extraction is insufficient
- SHA-256 deduplication before chunk/vector persistence
- type-aware chunking: Ollama classification runs before chunking and determines both the stored document type and the chunk size/overlap (overridable per type in document-type settings, otherwise falls back to the global default)
- embedding runs fully asynchronously in the background: chunks are persisted immediately as `pending`, are searchable right away through full-text/trigram search, and are embedded by a separate worker once Ollama is reachable — the ingestion transaction never blocks on an Ollama round trip

### Retrieval

- semantic vector search in PostgreSQL + pgvector
- PostgreSQL full-text search
- fuzzy matching via trigram indexes
- exact-match boosts for title, source reference, and content
- document-aware reranking and document-focus refinement
- small-to-big context expansion around strong hits
- inventory mode for "which documents exist?" style queries
- search improvements for repo-style and entity-style queries in MCP/Open WebUI flows

### Document-Centric Access

- full document fulltext retrieval
- persisted sections and structure navigation
- original file metadata and stable download URLs
- document comparison and version comparison
- cross-reference queries across documents
- local viewer for crawled websites, Markdown, code files, and plaintext

### Analysis

- meeting action extraction
- decision extraction
- deadline extraction
- requirement extraction
- config key extraction
- setup step extraction
- API surface extraction
- operational note extraction
- risk extraction
- entity extraction
- document and section summaries

### Admin And Multi-KB Controls

- knowledge base CRUD in the admin UI
- MCP principal management with KB scoping
- admin user management and password change flow
- editable document-type settings used by heuristics, classification, smart search, and per-type chunk size/overlap overrides (empty = global default)
- configurable `RAGfind` knowledge-base scope

## Architecture

Core runtime components:

- `ingestor-app`: Express API, admin dashboard, document APIs, MCP over HTTP
- `ingestor-worker`: BullMQ worker for background ingestion and sync jobs
- `ragfind`: separate Express runtime for the `RAGfind` search UI and local viewer
- `rag-db`: PostgreSQL with pgvector
- `redis`: BullMQ backend
- `elasticsearch`: optional hybrid search signal source
- external Ollama endpoint: embeddings, summaries, and document classification

Primary ingestion flow:

1. extract text from uploaded, synced, crawled, or git-based content
2. fall back to OCR when extraction is insufficient
3. normalize the content and classify it through Ollama — the classification result determines both the stored document type and the chunk size/overlap configured for that type (or the global default)
4. split the content into chunks using those parameters and persist documents, chunks, sections, original-file metadata, and analysis artifacts in PostgreSQL — chunks start out with `embedding_status = 'pending'` and are immediately searchable through full-text and trigram search
5. embeddings are then generated asynchronously by a background worker: a health check waits for a reachable Ollama endpoint, transient errors (connection drops, timeouts, 5xx) are retried indefinitely with backoff, and permanent configuration errors (e.g. dimension mismatches) immediately mark the affected chunks as `failed` instead of blocking the queue
6. expose retrieval through HTTP, admin UI, MCP, and `RAGfind` — live progress of the embedding backlog is visible in the admin dashboard (see "Dashboard And Admin UI")

## Repository Layout

```text
src/
  config/          environment handling
  db/              pool, migrations, startup migration runner
  mcp/             MCP HTTP and stdio entrypoints
  ragfind/         separate RAGfind server entrypoint
  routes/          HTTP endpoints and shared retrieval logic
  services/        ingestion, retrieval, OCR, analysis, sync, crawl, auth
  utils/           chunking, files, hashing, logging
  workers/         BullMQ worker runtime
migrations/        PostgreSQL schema and index migrations
public/            admin/operator frontend
public/ragfind/    RAGfind frontend
import-dir/        mounted import directory for sync-based ingestion
scripts/           helper scripts for deployment workflows
```

## Directory sync per knowledge base

The directory sync maps every immediate subdirectory of `IMPORT_DIR` to exactly one knowledge
base, so documents from different knowledge spaces cannot mix. The directory name is the
knowledge base slug:

```
import-dir/
  default/       -> knowledge base "default"
  contracts/     -> knowledge base "contracts"
  engineering/   -> knowledge base "engineering"
```

A sync without an explicitly selected knowledge base works like this:

1. Every enabled knowledge base gets its directory created if it does not exist yet.
2. Each subdirectory is read recursively and assigned to the knowledge base with that slug.
3. A subdirectory without a matching knowledge base is created as a new knowledge base
   (disable via `SYNC_AUTO_CREATE_KNOWLEDGE_BASES=false`; the directory is then skipped and reported in the result).
4. Files directly in the root directory are assigned to `default`.

If a concrete `knowledgeBaseId` is passed in the admin UI or via `POST /api/jobs/sync`, the previous
behaviour still applies: the whole tree below the root directory goes into that one knowledge base.
Set `SYNC_KNOWLEDGE_BASE_SUBDIRS=false` to disable the subdirectory mapping globally.

Deduplication is per knowledge base (`content_hash` + `knowledge_base_id`), so the same file can
deliberately live in several knowledge bases. The job result in the queue view reports scanned,
imported, and duplicate counts per knowledge base.

## Updating

`./update.sh` brings a running installation up to date without losing data:

```bash
./update.sh                  # back up, git pull, rebuild, start, verify
./update.sh --no-pull        # rebuild and start only
./update.sh --skip-backup    # without a backup
```

The order is deliberate — back up first, then pull. Before anything changes, a PostgreSQL dump, an
archive of the original files from the `app-data` volume, and the `.env` land in
`backups/<timestamp>/` together with restore instructions. If a step fails, the script aborts
before changing anything.

`docker compose down -v` deliberately never appears: it would delete the volumes and with them the
database and the original files. Elasticsearch is not backed up because the index can be rebuilt
from PostgreSQL at any time from the admin UI.

Afterwards the script reports which keys from `.env.example` are missing in your `.env`, and
reminds you about reindexing or re-embedding when a change requires it.

## Measuring retrieval quality

`npm run eval` measures Recall@k, MRR, nDCG@k, and Precision@1 against a goldenset of real
questions. The run uses the same search path as RAGfind and MCP (`executeSmartSearchQuery`),
including reranking and small-to-big.

```bash
cp eval/goldenset.example.json eval/goldenset.json   # or:
npm run eval:bootstrap                               # template from your own corpus
# fill in the questions in eval/goldenset.json
npm run eval -- --tag baseline
npm run eval -- --tag after --baseline eval/results/baseline.json
```

Comparing against a baseline reports per-question what improved and what regressed — averages alone
hide regressions. Details and the planned follow-ups are in `optimierungsplan.md` (German).

`eval/goldenset.json` and `eval/results/` are deliberately not in the repository: they contain
questions and hit lists from whatever corpus the instance holds.

## German full-text search

Alongside the `simple` tsvector columns there are German variants (`*_tsv_de`, migration 021) with
Snowball stemming and German stop words, so "Dienstpläne" also matches "Dienstplan". Both are
queried and the better rank wins — `simple` stays responsible for verbatim matches on file names,
reference numbers, and identifiers. Elasticsearch mirrors this through a `.de` sub-field using the
`german_rag` analyzer.

The Elasticsearch indices therefore carry a version suffix (`rag-documents-v2`, `rag-chunks-v2`).
Run *Reindex starten* in the admin UI once after deploying; the old unsuffixed indices can then be
deleted.

## Cross-encoder reranking

The top candidates of a search are optionally re-sorted by a reranking model that scores the
question and the passage together. Configure it in the admin UI under *Config-AI*: base URL, model
name, and how many candidates (`top_n`) are handed to the reranker. Cost grows linearly with the
candidate count (measured with Qwen3-Reranker-0.6B: 8 candidates ~740 ms, 12 ~1090 ms, 20 ~1800 ms),
so the default is 12.

Any server exposing `POST /v1/rerank` (falling back to `/rerank`) in the Cohere/Jina shape works —
llama.cpp with `--reranking`, TEI, Infinity, and vLLM. Recommended for a German corpus:
`bge-reranker-v2-m3` or `Qwen3-Reranker-0.6B`.

The reranker sits in the live query path and is guarded accordingly: hard timeout, bounded
concurrency, and a 30-second cooldown after a failure. When it is off, unreachable, or in cooldown,
the previous heuristic reranking takes over automatically — search always returns results, at worst
ordered less well. `crossEncoderRerank` in the debug log and the `rerankMs` stage timing show which
path each request took.

## Embedding input

What gets embedded is not the raw chunk but a context header built from the document title and
section heading plus the chunk content, carrying the model's task prefix (`search_document:` /
`search_query:` for nomic, `passage:` / `query:` for e5 — derived from the model name, overridable
via `EMBEDDING_DOCUMENT_PREFIX` / `EMBEDDING_QUERY_PREFIX`). The header exists only in the embedding
input, never in `document_chunks.content`.

`document_chunks.embedding_input_version` records which input shape produced a vector. When that
shape changes without a model change, a normal re-embedding run finds nothing — use *Re-Embedding
starten* in the Config-AI section (equivalent to `POST /admin/embeddings/reembed` with
`{"force": true}`).

## Running with vLLM

vLLM speaks the same OpenAI-compatible API as llama.cpp, LM Studio, or TGI. In the admin UI under
*Config-AI*, pick provider **OpenAI-kompatibel**, enter the `/v1` path as the base URL (e.g.
`http://host:8000/v1`), and leave the API key empty — it is optional and only needed when the
server was started with `--api-key`.

The three roles can run on separate vLLM instances; embedding and LLM share the provider
configuration, the reranker has its own base URL.

```bash
# Embeddings
vllm serve nomic-ai/nomic-embed-text-v1.5 \
  --served-model-name nomic-embed-text --trust-remote-code \
  --port 8000 --max-model-len 2048

# Reranker (cross-encoder)
vllm serve BAAI/bge-reranker-v2-m3 \
  --served-model-name bge-reranker-v2-m3 --port 8001

# LLM for classification and summarisation
vllm serve Qwen/Qwen2.5-7B-Instruct --port 8002
```

The flags that select a model's role differ between vLLM versions (`--task embed` / `--task score`
in older ones, `--runner pooling` in newer ones). Rather than relying on that, check an endpoint
directly:

```bash
npm run check:provider -- \
  --base-url http://host:8000/v1 \
  --embedding-model nomic-embed-text \
  --llm-model Qwen/Qwen2.5-7B-Instruct \
  --reranker-url http://host:8001 \
  --reranker-model bge-reranker-v2-m3
```

The tool runs the application's own client code against the endpoint — model listing, single and
batch embeddings, dimension, task prefixes, maximum input length, text generation, the JSON
response the classifier needs, and the rerank endpoint — then prints the values to enter in
*Config-AI*. It needs no database and changes nothing on the server.

Things to watch:

- **Input length:** on vLLM, `--max-model-len` caps a single input. The checker measures the limit
  and says whether it covers the chunk sizes this application produces.
- **Embedding dimension:** if it differs from the existing corpus, run
  `ALTER TABLE document_chunks ALTER COLUMN embedding TYPE VECTOR(n)` before switching, then a full
  re-embedding. The admin UI probes the dimension on save and rejects a conflict.
- **Task prefixes** are derived from the model name. vLLM often reports the full HF path
  (`nomic-ai/nomic-embed-text-v1.5`), which is recognised; for unusual names use
  `EMBEDDING_DOCUMENT_PREFIX` / `EMBEDDING_QUERY_PREFIX`.
- **First inference fails while the model list works:** if the server reports
  `Failed to find C compiler` or points at `triton.knobs.build.impl`, the vLLM
  container has no C compiler. vLLM compiles Triton kernels on the first real
  call, so `/v1/models` succeeds while `/v1/embeddings` does not. Install `gcc` /
  `build-essential` in the vLLM image, or point `CC` at an existing compiler.
  Such a failure is now reported as `AI provider at ... answered HTTP 500: ...`,
  making clear the server was reachable and the fault is upstream.
- **Structured output:** if a server rejects `response_format: json_object`, the request is retried
  without it automatically, so classification also works on servers without guided decoding.

## Model server input limits

When the embedding or reranking model runs on llama.cpp, its physical batch size (`ubatch`,
512 tokens by default) caps the length of a single input. A longer input is rejected with HTTP 500
and would otherwise fail the whole batch. `CHUNK_SIZE` does not protect against this: it counts
with `gpt-tokenizer`, while German text encodes roughly twice as densely in the model's own
tokenizer — 300 "chunk tokens" can be 600 model tokens, and OCR'd tables with run-together words
more still.

The stack handles this in two stages:

1. `EMBEDDING_MAX_INPUT_CHARS` and `RERANKER_DOCUMENT_MAX_CHARS` cap the input up front.
2. If the server rejects it anyway, the batch is split, the offending entry is shortened step by
   step and resent. This is tokenizer-agnostic and keeps working after a model change.

The cleaner fix is to start the server with a larger batch (`llama-server -ub 2048 -b 2048`). The
truncation paths then never trigger and both embedding and reranking see the full text.

## Requirements

- Node.js `20.11+`
- PostgreSQL with pgvector
- Redis
- external Ollama endpoint
- Docker and Docker Compose for the simplest local deployment
- optional OCR dependencies for scanned content

## Quick Start With Docker Compose

1. Copy the environment template.

```bash
cp .env.example .env
```

2. Adjust at least these values:

- `OLLAMA_BASE_URL` (seed value only; the running AI provider configuration is then managed in the Admin UI under "Config-AI")
- optionally `PUBLIC_BASE_URL`

3. Build and start the full stack.

```bash
docker compose up --build
```

4. Open the admin console at `http://localhost:3311`.

5. Open `RAGfind` at `http://localhost:3312`.

The default Compose stack starts:

- admin/API/MCP on `3311`
- `RAGfind` on `3312`
- PostgreSQL on host port `5433`
- Redis on host port `6379`
- Elasticsearch on host port `9200`

## Local Development

1. Install dependencies.

```bash
npm install
```

2. Copy and adjust the environment file.

```bash
cp .env.example .env
```

3. Start PostgreSQL, Redis, Elasticsearch if desired, and your Ollama endpoint.

4. Run migrations.

```bash
npm run migrate
```

5. Start the API, worker, and optionally `RAGfind` in separate terminals.

```bash
npm run dev
```

```bash
npm run dev:worker
```

```bash
npm run dev:ragfind
```

## Available Scripts

```bash
npm run dev              # start API in watch mode
npm run dev:worker       # start BullMQ worker in watch mode
npm run dev:ragfind      # start RAGfind server in watch mode
npm run dev:mcp:stdio    # run MCP server over stdio in watch mode
npm run build            # compile TypeScript
npm run start            # start compiled API
npm run start:worker     # start compiled worker
npm run start:ragfind    # start compiled RAGfind server
npm run start:mcp:stdio  # start compiled MCP stdio server
npm run migrate          # run SQL migrations
```

## Important Environment Variables

Core services:

- `PORT`: admin/API port, default `3311`
- `DATABASE_URL`: PostgreSQL connection string
- `REDIS_URL`: Redis connection string
- `PUBLIC_BASE_URL`: used for emitted download links and external references

LLM and embedding (seed values for the initial setup only - the persistent configuration is then managed in the Admin UI under "Config-AI", see below):

- `OLLAMA_BASE_URL`
- `EMBEDDING_MODEL`
- `LLM_MODEL`
- `DOCUMENT_CLASSIFIER_MODEL`
- `EMBEDDING_DIMENSION`

Storage and ingestion:

- `IMPORT_DIR`
- `UPLOAD_DIR`
- `ORIGINAL_STORAGE_DIR`
- `GIT_REPO_CACHE_DIR`
- `GIT_REPO_MAX_FILE_BYTES`
- `CRAWL_DEFAULT_MAX_DEPTH`

Retrieval tuning:

- `QUERY_TOP_K`
- `QUERY_CANDIDATE_K`
- `QUERY_MAX_CHUNKS_PER_DOCUMENT`
- `QUERY_VECTOR_WEIGHT`
- `QUERY_KEYWORD_WEIGHT`
- `QUERY_EXACT_MATCH_BOOST`
- `QUERY_RERANK_TOP_N`
- `QUERY_SMALL_TO_BIG_WINDOW`

Search-layer integration:

- `ELASTICSEARCH_URL`
- `ELASTICSEARCH_INDEX_PREFIX`

See `.env.example` for the current defaults.

## Dashboard And Admin UI

The admin console on port `3311` is organized around a navigation menu with seven areas (hash-based routing, so each view is directly linkable and supports the browser's back/forward navigation):

- **Overview** — stats, system health (Ollama/Elasticsearch/Postgres), and live progress of the asynchronous embedding pipeline (a progress bar showing "X / Y chunks embedded" plus a note about failed chunks once `failed > 0`)
- **Ingestion** — upload, crawl, directory sync, schedule, and git import forms, queue jobs, and embedding progress
- **Documents** — document browser with preview, filtering, the analysis workbench, and document reclassification support
- **Search** — RAG query testing against the search stack
- **Knowledge Base & Types** — knowledge base management, document-type settings (including per-type chunk size/overlap), and `RAGfind` KB selection
- **System** — MCP principal management, admin user management, password change, Elasticsearch operations, git repository import status, and runtime configuration
- **Config-AI** — configuration of the AI provider (Ollama or an OpenAI-compatible API): server URL, optional API key, and a dropdown per component (embedding, summarization, document classification) populated live with the models actually available on the configured server. Changes take effect immediately, without a restart — switching the embedding model is verified via a test call for dimension compatibility on save and rejected with a clear error message on conflict (see `EMBEDDING_DIMENSION` above)

The admin console is the place where `RAGfind` search scope is configured.

Embedding progress is updated through live polling (`GET /api/admin/embeddings/pending-status`): while chunks remain `pending` or `failed`, the UI polls the status every 5 seconds and hides the panel once everything has been embedded.

## RAGfind

`RAGfind` is a separate container and frontend intended for end-user document search.

Current behavior:

- searches only in the knowledge bases enabled for `RAGfind`
- groups chunk hits into document-level results
- supplements grouped search results with direct title/source-reference matches when needed
- always opens a local viewer instead of redirecting crawled pages to the live website
- provides a multisource viewer with rendered HTML, rendered Markdown, syntax-highlighted code, and a plaintext tab

## Open WebUI Integration

Open WebUI should connect through MCP only.

Recommended endpoint:

```text
http://localhost:3311/mcp
```

There are no repository-managed Open WebUI Python filter, tool, or action files in this repository anymore.

## MCP Support

The service exposes MCP in two modes.

### Streamable HTTP MCP

Endpoint:

```text
http://localhost:3311/mcp
```

### Local stdio MCP

Development:

```bash
npm run dev:mcp:stdio
```

Production build:

```bash
npm run build
npm run start:mcp:stdio
```

### MCP Tool Categories

Available tools cover:

- retrieval and smart search
- document listing and lookup
- fulltext, sections, and structure access
- original file access metadata
- document analysis and summaries
- document comparison and cross-reference workflows

## HTTP API Highlights

### Retrieval

- `POST /api/smart-search`
- `POST /api/cross-reference`

### Documents

- `GET /api/documents`
- `GET /api/documents/:id`
- `GET /api/documents/:id/fulltext`
- `GET /api/documents/:id/sections`
- `GET /api/documents/:id/structure`
- `GET /api/documents/:id/section`
- `GET /api/documents/:id/original/meta`
- `GET /api/documents/:id/original`

### Analysis

- `GET /api/documents/:id/analysis/actions`
- `GET /api/documents/:id/analysis/decisions`
- `GET /api/documents/:id/analysis/deadlines`
- `GET /api/documents/:id/analysis/requirements`
- `GET /api/documents/:id/analysis/config-keys`
- `GET /api/documents/:id/analysis/setup-steps`
- `GET /api/documents/:id/analysis/api-surface`
- `GET /api/documents/:id/analysis/operational-notes`
- `GET /api/documents/:id/analysis/risks`
- `GET /api/documents/:id/analysis/entities`
- `GET /api/documents/:id/summary`
- `GET /api/documents/:id/section-summary`
- `GET /api/documents/:id/compare`
- `GET /api/documents/:id/compare-version`

## Crawl And Git Notes

- website crawling follows same-site links and downloadable files
- redirected domains such as `bmetallica.de -> www.bmetallica.de` are crawled correctly across the redirected origin
- git ingestion supports optional branch and subpath selection and indexes common text/code formats

## GitHub Repository Preparation

This repository is prepared to be published on GitHub with:

- a repository-focused README
- an MIT license
- `.gitignore` for Node, build, local env, and import artifacts
- container-based and local development instructions
- explicit separation between admin surface and `RAGfind`

## License

This project is licensed under the MIT License. See `LICENSE`.

## Roadmap And Design Notes

For deeper product direction and retrieval design notes, see:

- `ROADMAP.md`
- `rag-logik.md`

## Status

This is an actively evolving repository, but the current implementation already includes:

- multi-source ingestion
- type-aware chunking driven by classification that runs ahead of chunking
- fully asynchronous embedding pipeline with health checks, error-classified retries, and live progress tracking in the dashboard
- persisted structure and original file references
- analysis and summary workflows
- MCP integration
- knowledge-base-aware admin configuration
- navigation-based admin UI with seven clearly separated areas
- separate `RAGfind` search experience with local viewer