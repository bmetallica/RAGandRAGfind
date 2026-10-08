import http from "node:http";
import https from "node:https";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";

// Zugriffsweg fuer ausgehende Anfragen: optionaler Proxy, optional ohne
// Zertifikatspruefung. Beides ist pro Vorgang gedacht - ein Crawl ins Intranet
// braucht es, der naechste ins offene Netz nicht. Deshalb wird hier nichts
// global gesetzt: NODE_TLS_REJECT_UNAUTHORIZED bleibt unberuehrt, und die
// Nachsicht gilt nur fuer die Anfragen, die diese Optionen mitbekommen.
export interface HttpAccessOptions {
  proxyUrl?: string | null;
  ignoreTlsErrors?: boolean;
}

interface AgentPair {
  httpAgent: http.Agent;
  httpsAgent: https.Agent;
}

// Agenten halten Verbindungen offen. Fuer jede Anfrage einen neuen zu bauen
// hiesse, bei jedem Seitenabruf erneut durch Proxy- und TLS-Handschlag zu
// gehen - bei einem Crawl ueber hunderte Seiten ein spuerbarer Unterschied.
const agentCache = new Map<string, AgentPair>();

export function normalizeProxyUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  // Ohne Schema ist "10.50.174.124:3128" gemeint - die Schreibweise, die man
  // aus Proxy-Einstellungen kennt. Sie als ungueltig abzulehnen waere unnoetig
  // streng.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`proxyUrl is not a valid address: ${trimmed}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`proxyUrl must use http or https, got ${parsed.protocol.replace(":", "")}`);
  }

  if (!parsed.hostname) {
    throw new Error(`proxyUrl is missing a host: ${trimmed}`);
  }

  return parsed.toString();
}

// Fuer Protokoll und Metadaten: ein Proxy darf Zugangsdaten in der Adresse
// tragen, und die haben weder im Log noch in der Datenbank etwas zu suchen.
export function redactProxyUrl(proxyUrl: string | null | undefined): string | null {
  if (!proxyUrl) {
    return null;
  }

  try {
    const parsed = new URL(proxyUrl);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

// Die Nachsicht muss fuer die Verbindung zum ZIEL gelten, nicht fuer die zum
// Proxy. HttpsProxyAgent reicht seine Konstruktor-Optionen aber nur an den
// Proxy-Anschluss weiter; den TLS-Handschlag dahinter baut er aus den
// Anfrageoptionen. Ohne dieses Einhaengen scheitert ein selbstsigniertes
// Zertifikat hinter dem Proxy weiterhin - geprueft, genau so war es.
class InsecureHttpsProxyAgent extends HttpsProxyAgent<string> {
  async connect(request: http.ClientRequest, options: Parameters<HttpsProxyAgent<string>["connect"]>[1]) {
    // Der Typ der Anfrageoptionen kennt rejectUnauthorized nur fuer den
    // TLS-Fall; weitergereicht wird es in beiden, ausgewertet nur dort.
    return super.connect(request, { ...options, rejectUnauthorized: false } as typeof options);
  }
}

function buildAgents(access: HttpAccessOptions): AgentPair {
  const proxyUrl = access.proxyUrl ?? null;
  const ignoreTlsErrors = access.ignoreTlsErrors === true;
  const cacheKey = `${proxyUrl ?? ""}|${ignoreTlsErrors}`;
  const cached = agentCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const tlsOptions = ignoreTlsErrors ? { rejectUnauthorized: false } : {};
  const pair: AgentPair = proxyUrl
    ? {
        // Ein https-Ziel hinter einem http-Proxy braucht einen CONNECT-Tunnel.
        // Die eingebaute proxy-Option von axios stellt stattdessen die
        // vollstaendige Adresse in die Anfragezeile; bei https scheitert das.
        httpAgent: new HttpProxyAgent(proxyUrl, { keepAlive: true }),
        httpsAgent: ignoreTlsErrors
          ? new InsecureHttpsProxyAgent(proxyUrl, { keepAlive: true, rejectUnauthorized: false })
          : new HttpsProxyAgent(proxyUrl, { keepAlive: true })
      }
    : {
        httpAgent: new http.Agent({ keepAlive: true }),
        httpsAgent: new https.Agent({ keepAlive: true, ...tlsOptions })
      };

  agentCache.set(cacheKey, pair);
  return pair;
}

export function hasHttpAccessOptions(access: HttpAccessOptions | null | undefined): boolean {
  return Boolean(access && (access.proxyUrl || access.ignoreTlsErrors));
}

// Fertiges Stueck axios-Konfiguration. `proxy: false` schaltet die eigene
// Proxy-Behandlung von axios ab - sonst wuerde sie zusaetzlich greifen, sobald
// im Container HTTP_PROXY gesetzt ist, und sich mit dem Agenten beissen.
export function buildHttpAccessConfig(access: HttpAccessOptions | null | undefined) {
  if (!hasHttpAccessOptions(access)) {
    return {};
  }

  const agents = buildAgents(access as HttpAccessOptions);
  return {
    httpAgent: agents.httpAgent,
    httpsAgent: agents.httpsAgent,
    proxy: false as const
  };
}
