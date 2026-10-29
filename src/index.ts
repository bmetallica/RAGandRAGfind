import { mkdir } from "node:fs/promises";
import express from "express";
import pinoHttp from "pino-http";
import path from "node:path";
import { env } from "./config/env";
import { logger } from "./utils/logger";
import { pool } from "./db/pool";
import runStartupMigrations from "./db/startupMigrations";
import { resolveMcpPrincipalByToken } from "./services/adminAccessService";
import { authenticateAdminUser } from "./services/adminAuthService";
import { createApiRouter } from "./routes/api";
import { createMcpRouter } from "./mcp/server";
import { createOpencodeMcpRouter } from "./mcp/opencodeServer";
import { SchedulerService } from "./services/schedulerService";
import { DocumentClassificationService } from "./services/classificationService";
import { searchIndexService } from "./services/searchIndexService";

const STARTUP_RETRY_DELAY_MS = 2_000;
const STARTUP_MAX_RETRIES = 30;
const documentClassificationService = new DocumentClassificationService();

function extractBasicCredentials(request: express.Request): { username: string; password: string } | null {
  const authorization = request.header("authorization");
  if (!authorization?.startsWith("Basic ")) {
    return null;
  }

  try {
    const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex < 0) {
      return null;
    }

    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1)
    };
  } catch {
    return null;
  }
}

function extractApiToken(request: express.Request): string | null {
  const authorization = request.header("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim() || null;
  }

  const apiKey = request.header("x-api-key");
  return apiKey?.trim() || null;
}

function isMcpTokenEligiblePath(request: express.Request): boolean {
  if (!request.path.startsWith("/api")) {
    return false;
  }

  return request.path === "/api/smart-search"
    || request.path === "/api/cross-reference"
    || request.path === "/api/documents"
    || request.path.startsWith("/api/documents/");
}

function sendAuthChallenge(request: express.Request, response: express.Response) {
  response.setHeader("WWW-Authenticate", 'Basic realm="RAG Admin", charset="UTF-8"');

  if (request.path.startsWith("/api")) {
    response.status(401).json({ error: "authentication required" });
    return;
  }

  response.status(401).send("authentication required");
}

function isRetryableStartupError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const startupError = error as Error & { code?: string; errno?: string };
  const message = error.message.toLowerCase();

  return startupError.code === "57P03"
    || startupError.code === "ECONNREFUSED"
    || startupError.code === "ENOTFOUND"
    || startupError.code === "ETIMEDOUT"
    || startupError.errno === "ECONNREFUSED"
    || message.includes("not yet accepting connections")
    || message.includes("connection refused");
}

async function sleep(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function initializeSchedulerWithRetry() {
  const schedulerService = new SchedulerService();

  for (let attempt = 1; attempt <= STARTUP_MAX_RETRIES; attempt += 1) {
    try {
      await runStartupMigrations();
      await schedulerService.ensureDefaultSyncSchedule();
      await schedulerService.reload();
      return schedulerService;
    } catch (error) {
      if (!isRetryableStartupError(error) || attempt === STARTUP_MAX_RETRIES) {
        throw error;
      }

      logger.warn(
        {
          attempt,
          maxAttempts: STARTUP_MAX_RETRIES,
          retryInMs: STARTUP_RETRY_DELAY_MS,
          err: error
        },
        "startup dependency not ready yet; retrying"
      );

      await sleep(STARTUP_RETRY_DELAY_MS);
    }
  }

  return schedulerService;
}

async function start() {
  await mkdir(env.UPLOAD_DIR, { recursive: true });
  await mkdir(env.IMPORT_DIR, { recursive: true });
  await mkdir(env.ORIGINAL_STORAGE_DIR, { recursive: true });
  await mkdir(env.GIT_REPO_CACHE_DIR, { recursive: true });

  const schedulerService = await initializeSchedulerWithRetry();

  const app = express();
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(async (request, response, next) => {
    if (request.path.startsWith("/mcp")) {
      next();
      return;
    }

    try {
      const basicCredentials = extractBasicCredentials(request);
      if (basicCredentials && await authenticateAdminUser(basicCredentials.username, basicCredentials.password)) {
        response.locals.isAdminAuthenticated = true;
        response.locals.adminUsername = basicCredentials.username;
        next();
        return;
      }

      if (isMcpTokenEligiblePath(request)) {
        const token = extractApiToken(request);
        if (token) {
          const principal = await resolveMcpPrincipalByToken(token);
          if (principal) {
            response.locals.apiPrincipal = principal;
            next();
            return;
          }
        }
      }

      sendAuthChallenge(request, response);
    } catch (error) {
      next(error);
    }
  });
  // Der zugeschnittene Endpunkt muss vor dem allgemeinen stehen: sonst faengt
  // /mcp die Anfragen ab, bevor /mcp/opencode an die Reihe kommt.
  app.use("/mcp/opencode", createOpencodeMcpRouter());
  app.use("/mcp", createMcpRouter());
  app.use("/api", createApiRouter(schedulerService));
  app.use(express.static(path.resolve(process.cwd(), "public")));

  app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    logger.error({ err: error }, "request failed");
    response.status(500).json({ error: error.message });
  });

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, "ingestor app listening");

    void searchIndexService.backfillDocuments()
      .then((result) => {
        if (result.processed > 0) {
          logger.info({ processed: result.processed }, "completed elasticsearch startup backfill");
        }
      })
      .catch((error) => {
        logger.warn({ err: error }, "failed elasticsearch startup backfill");
      });

    void documentClassificationService.backfillDocuments({ batchSize: 10 })
      .then((result) => {
        if (result.classified > 0 || result.failed > 0) {
          logger.info(result, "completed document classification startup backfill");
        }
      })
      .catch((error) => {
        logger.warn({ err: error }, "failed document classification startup backfill");
      });
  });

  const shutdown = async () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((error) => {
  logger.error({ err: error }, "failed to start application");
  process.exit(1);
});
