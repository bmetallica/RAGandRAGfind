import { Client, type estypes } from "@elastic/elasticsearch";
import { pool } from "../db/pool";
import { env } from "../config/env";
import { logger } from "../utils/logger";

interface SearchDocumentRow {
  id: number;
  knowledge_base_id: number | null;
  title: string | null;
  source_type: string;
  source_ref: string;
  source_url: string | null;
  file_type: string | null;
  mime_type: string | null;
  extracted_text: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

interface SearchChunkRow {
  id: number;
  document_id: number;
  chunk_index: number;
  content: string;
  start_offset: number | null;
  end_offset: number | null;
  metadata: Record<string, unknown> | null;
}

export interface SearchChunkCandidate {
  chunkId: number;
  score: number;
  rank: number;
}

export interface SearchDocumentCandidate {
  documentId: number;
  score: number;
  rank: number;
}

// German analysis chain for a mostly-German corpus. The default `standard`
// analyzer indexes raw tokens, so "Dienstplaene" and "Dienstplan" are unrelated
// terms - the same problem the 'simple' tsvector had on the PostgreSQL side.
//
// No compound splitter here: `hyphenation_decompounder` needs a hyphenation
// pattern file and a German word list mounted into the Elasticsearch container.
// `german_normalization` plus the light stemmer covers the common cases without
// that operational dependency.
const INDEX_SETTINGS: estypes.IndicesIndexSettings = {
  analysis: {
    filter: {
      rag_german_stop: { type: "stop", stopwords: "_german_" },
      rag_german_stemmer: { type: "stemmer", language: "light_german" }
    },
    analyzer: {
      german_rag: {
        type: "custom",
        tokenizer: "standard",
        filter: ["lowercase", "german_normalization", "rag_german_stop", "rag_german_stemmer"]
      }
    }
  }
};

// Text field indexed twice: the default analyzer keeps verbatim matches on file
// names and identifiers, the `.de` sub-field adds stemming. Queries search both.
const GERMAN_TEXT_FIELD: estypes.MappingProperty = {
  type: "text",
  fields: {
    de: { type: "text", analyzer: "german_rag" }
  }
};

function toIsoDateString(value: string): string | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export class SearchIndexService {
  private readonly client = env.ELASTICSEARCH_URL ? new Client({ node: env.ELASTICSEARCH_URL }) : null;
  // Versioned on purpose: `indices.create` cannot change the mapping or the
  // analysis settings of an index that already exists (the call below swallows
  // the 400 it returns), so a mapping change has to move to a new index name.
  // Bump this whenever INDEX_SETTINGS or the mappings change, then run the
  // Elasticsearch reindex from the admin UI. Old indices can be deleted by hand.
  private readonly documentsIndex = `${env.ELASTICSEARCH_INDEX_PREFIX}-documents-v2`;
  private readonly chunksIndex = `${env.ELASTICSEARCH_INDEX_PREFIX}-chunks-v2`;
  private indicesEnsured = false;

  isEnabled(): boolean {
    return Boolean(this.client);
  }

  async checkHealth(): Promise<{ enabled: boolean; reachable: boolean; error: string | null }> {
    if (!this.client) {
      return {
        enabled: false,
        reachable: false,
        error: null
      };
    }

    try {
      await this.client.ping();
      return {
        enabled: true,
        reachable: true,
        error: null
      };
    } catch (error) {
      return {
        enabled: true,
        reachable: false,
        error: error instanceof Error ? error.message : "unknown error"
      };
    }
  }

  async getIndexStats(): Promise<{ documents: number; chunks: number } | null> {
    if (!this.client) {
      return null;
    }

    try {
      const [documents, chunks] = await Promise.all([
        this.client.count({ index: this.documentsIndex }, { ignore: [404] }),
        this.client.count({ index: this.chunksIndex }, { ignore: [404] })
      ]);

      return {
        documents: documents.count ?? 0,
        chunks: chunks.count ?? 0
      };
    } catch (error) {
      logger.warn({ err: error }, "failed to read elasticsearch index stats");
      return null;
    }
  }

  async refreshIndices(): Promise<void> {
    if (!this.client) {
      return;
    }

    await Promise.all([
      this.client.indices.refresh({ index: this.documentsIndex }, { ignore: [404] }),
      this.client.indices.refresh({ index: this.chunksIndex }, { ignore: [404] })
    ]);
  }

  async ensureIndices(): Promise<void> {
    if (!this.client || this.indicesEnsured) {
      return;
    }

    await this.client.indices.create({
      index: this.documentsIndex,
      settings: INDEX_SETTINGS,
      mappings: {
        properties: {
          document_id: { type: "long" },
          knowledge_base_id: { type: "long" },
          title: GERMAN_TEXT_FIELD,
          source_type: { type: "keyword" },
          source_ref: GERMAN_TEXT_FIELD,
          source_url: { type: "keyword", ignore_above: 2048 },
          file_type: { type: "keyword" },
          mime_type: { type: "keyword" },
          extracted_text: GERMAN_TEXT_FIELD,
          metadata_json: { type: "text", index: false },
          created_at: { type: "date" },
          updated_at: { type: "date" }
        }
      }
    }, { ignore: [400] });

    await this.client.indices.create({
      index: this.chunksIndex,
      settings: INDEX_SETTINGS,
      mappings: {
        properties: {
          chunk_id: { type: "long" },
          document_id: { type: "long" },
          knowledge_base_id: { type: "long" },
          chunk_index: { type: "integer" },
          title: GERMAN_TEXT_FIELD,
          source_type: { type: "keyword" },
          source_ref: GERMAN_TEXT_FIELD,
          source_url: { type: "keyword", ignore_above: 2048 },
          content: GERMAN_TEXT_FIELD,
          start_offset: { type: "integer" },
          end_offset: { type: "integer" },
          metadata_json: { type: "text", index: false }
        }
      }
    }, { ignore: [400] });

    this.indicesEnsured = true;
  }

  async syncDocument(documentId: number): Promise<void> {
    if (!this.client) {
      return;
    }

    await this.ensureIndices();

    const documentResult = await pool.query<SearchDocumentRow>(
      `
        SELECT
          id,
          knowledge_base_id,
          title,
          source_type,
          source_ref,
          source_url,
          file_type,
          mime_type,
          extracted_text,
          metadata,
          created_at::text,
          updated_at::text
        FROM documents
        WHERE id = $1
        LIMIT 1
      `,
      [documentId]
    );

    const document = documentResult.rows[0];
    if (!document) {
      await this.deleteDocument(documentId);
      return;
    }

    const chunksResult = await pool.query<SearchChunkRow>(
      `
        SELECT
          id,
          document_id,
          chunk_index,
          content,
          start_offset,
          end_offset,
          metadata
        FROM document_chunks
        WHERE document_id = $1
        ORDER BY chunk_index ASC, id ASC
      `,
      [documentId]
    );

    await this.client.index({
      index: this.documentsIndex,
      id: String(documentId),
      document: {
        document_id: document.id,
        knowledge_base_id: document.knowledge_base_id,
        title: document.title,
        source_type: document.source_type,
        source_ref: document.source_ref,
        source_url: document.source_url,
        file_type: document.file_type,
        mime_type: document.mime_type,
        extracted_text: document.extracted_text,
        metadata_json: JSON.stringify(document.metadata ?? {}),
        created_at: toIsoDateString(document.created_at),
        updated_at: toIsoDateString(document.updated_at)
      },
      refresh: false
    });

    await this.client.deleteByQuery({
      index: this.chunksIndex,
      query: {
        term: {
          document_id: documentId
        }
      }
    }, { ignore: [404] });

    if (!chunksResult.rows.length) {
      return;
    }

    await this.client.bulk({
      operations: chunksResult.rows.flatMap((chunk) => [
        {
          index: {
            _index: this.chunksIndex,
            _id: String(chunk.id)
          }
        },
        {
          chunk_id: chunk.id,
          document_id: chunk.document_id,
          knowledge_base_id: document.knowledge_base_id,
          chunk_index: chunk.chunk_index,
          title: document.title,
          source_type: document.source_type,
          source_ref: document.source_ref,
          source_url: document.source_url,
          content: chunk.content,
          start_offset: chunk.start_offset,
          end_offset: chunk.end_offset,
          metadata_json: JSON.stringify(chunk.metadata ?? {})
        }
      ]),
      refresh: false
    });
  }

  async deleteDocument(documentId: number): Promise<void> {
    if (!this.client) {
      return;
    }

    await this.ensureIndices();

    await this.client.delete({
      index: this.documentsIndex,
      id: String(documentId),
      refresh: false
    }, { ignore: [404] });

    await this.client.deleteByQuery({
      index: this.chunksIndex,
      query: {
        term: {
          document_id: documentId
        }
      }
    }, { ignore: [404] });
  }

  async searchChunkCandidates(query: string, limit: number, allowedKnowledgeBaseIds?: number[]): Promise<SearchChunkCandidate[] | null> {
    if (!this.client) {
      return null;
    }

    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return null;
    }

    await this.ensureIndices();

    try {
      const response = await this.client.search<{ chunk_id: number }>({
        index: this.chunksIndex,
        size: Math.max(1, limit),
        query: {
          bool: {
            should: [
              {
                multi_match: {
                  query: normalizedQuery,
                  fields: ["content^6", "content.de^5"],
                  type: "best_fields",
                  fuzziness: "AUTO",
                  prefix_length: 1,
                  minimum_should_match: "60%"
                }
              },
              {
                // Phrase match stays on the verbatim field only - stemming
                // shifts token positions, which makes a slop-based phrase
                // match on the `.de` field unreliable rather than more lenient.
                multi_match: {
                  query: normalizedQuery,
                  fields: ["content^8"],
                  type: "phrase",
                  slop: 3,
                  boost: 2.5
                }
              },
              {
                multi_match: {
                  query: normalizedQuery,
                  fields: ["content^3", "title^1.2", "source_ref^1.2"],
                  type: "cross_fields",
                  operator: "and",
                  boost: 1.5
                }
              },
              {
                // Same as above on the stemmed fields, at a slightly lower
                // boost: it should rescue German inflections, not outrank an
                // exact hit.
                multi_match: {
                  query: normalizedQuery,
                  fields: ["content.de^2.5", "title.de^1", "source_ref.de^1"],
                  type: "cross_fields",
                  operator: "and",
                  boost: 1.2
                }
              },
              {
                multi_match: {
                  query: normalizedQuery,
                  fields: ["title^0.4", "source_ref^0.5", "title.de^0.35", "source_ref.de^0.4"],
                  type: "best_fields",
                  fuzziness: "AUTO",
                  prefix_length: 1,
                  boost: 0.2
                }
              }
            ],
            minimum_should_match: 1,
            ...(allowedKnowledgeBaseIds && allowedKnowledgeBaseIds.length > 0
              ? {
                  filter: [
                    {
                      terms: {
                        knowledge_base_id: allowedKnowledgeBaseIds
                      }
                    }
                  ]
                }
              : {})
          }
        },
        _source: ["chunk_id"]
      });

      const candidates: SearchChunkCandidate[] = [];
      const seenChunkIds = new Set<number>();

      for (const [index, hit] of (response.hits.hits ?? []).entries()) {
        const chunkId = Number(hit._source?.chunk_id);
        if (!Number.isFinite(chunkId) || chunkId <= 0 || seenChunkIds.has(chunkId)) {
          continue;
        }

        seenChunkIds.add(chunkId);
        candidates.push({
          chunkId,
          score: typeof hit._score === "number" ? hit._score : 0,
          rank: index + 1
        });
      }

      return candidates.length > 0 ? candidates : null;
    } catch (error) {
      logger.warn({ err: error }, "failed to query elasticsearch chunk candidates");
      return null;
    }
  }

  async searchDocumentCandidates(query: string, limit: number, allowedKnowledgeBaseIds?: number[]): Promise<SearchDocumentCandidate[] | null> {
    if (!this.client) {
      return null;
    }

    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return null;
    }

    await this.ensureIndices();

    try {
      const response = await this.client.search<{ document_id: number }>({
        index: this.documentsIndex,
        size: Math.max(1, limit),
        query: {
          bool: {
            must: [
              {
                multi_match: {
                  query: normalizedQuery,
                  fields: [
                    "title^4",
                    "source_ref^3",
                    "extracted_text",
                    "title.de^3.5",
                    "source_ref.de^2.5",
                    "extracted_text.de^0.8"
                  ],
                  type: "best_fields",
                  fuzziness: "AUTO"
                }
              }
            ],
            ...(allowedKnowledgeBaseIds && allowedKnowledgeBaseIds.length > 0
              ? {
                  filter: [
                    {
                      terms: {
                        knowledge_base_id: allowedKnowledgeBaseIds
                      }
                    }
                  ]
                }
              : {})
          }
        },
        _source: ["document_id"]
      });

      const candidates: SearchDocumentCandidate[] = [];
      const seenDocumentIds = new Set<number>();

      for (const [index, hit] of (response.hits.hits ?? []).entries()) {
        const documentId = Number(hit._source?.document_id);
        if (!Number.isFinite(documentId) || documentId <= 0 || seenDocumentIds.has(documentId)) {
          continue;
        }

        seenDocumentIds.add(documentId);
        candidates.push({
          documentId,
          score: typeof hit._score === "number" ? hit._score : 0,
          rank: index + 1
        });
      }

      return candidates.length > 0 ? candidates : null;
    } catch (error) {
      logger.warn({ err: error }, "failed to query elasticsearch document candidates");
      return null;
    }
  }

  async backfillDocuments(batchSize = 100, maxDocuments?: number): Promise<{ processed: number }> {
    if (!this.client) {
      return { processed: 0 };
    }

    await this.ensureIndices();

    const safeBatchSize = Math.max(batchSize, 1);
    const effectiveLimit = Number.isFinite(maxDocuments) && Number(maxDocuments) > 0
      ? Math.max(1, Number(maxDocuments))
      : null;
    let processed = 0;
    let lastDocumentId = 0;

    while (effectiveLimit === null || processed < effectiveLimit) {
      const remaining = effectiveLimit === null ? safeBatchSize : Math.min(safeBatchSize, effectiveLimit - processed);
      if (remaining <= 0) {
        break;
      }

      const result = await pool.query<{ id: number }>(
        `
          SELECT id
          FROM documents
          WHERE id > $1
          ORDER BY id ASC
          LIMIT $2
        `,
        [lastDocumentId, remaining]
      );

      if (!result.rows.length) {
        break;
      }

      for (const row of result.rows) {
        try {
          await this.syncDocument(row.id);
          processed += 1;
          lastDocumentId = row.id;
        } catch (error) {
          lastDocumentId = row.id;
          logger.warn({ err: error, documentId: row.id }, "failed to backfill document into elasticsearch");
        }
      }
    }

    return { processed };
  }
}

export const searchIndexService = new SearchIndexService();