import path from "node:path";

const documentExtensions = new Set([".pdf", ".docx", ".odt", ".txt", ".md"]);
const textDocumentExtensions = new Set([".txt", ".md"]);
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"]);
const repositoryDocumentExtensions = new Set([
  ".md", ".txt", ".rst", ".adoc", ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env", ".xml", ".csv",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".java", ".go", ".rs", ".php", ".rb", ".sh", ".ps1", ".sql",
  ".html", ".css", ".scss", ".less", ".dockerfile", ".gitignore", ".gitattributes", ".properties", ".conf", ".cnf"
]);
const repositoryDocumentBasenames = new Set(["dockerfile", "makefile", "jenkinsfile", "readme", "license", ".env", ".gitignore", ".gitattributes"]);

export function getExtension(fileName: string): string {
  return path.extname(fileName).toLowerCase();
}

export function isSupportedDocument(fileName: string): boolean {
  const extension = getExtension(fileName);
  return documentExtensions.has(extension) || imageExtensions.has(extension);
}

export function isTextLikeDocument(fileName: string): boolean {
  const extension = getExtension(fileName);
  const basename = path.basename(fileName).toLowerCase();
  return textDocumentExtensions.has(extension) || repositoryDocumentExtensions.has(extension) || repositoryDocumentBasenames.has(basename);
}

export function isSupportedRepositoryDocument(fileName: string): boolean {
  return isTextLikeDocument(fileName) || isImage(fileName);
}

export function isImage(fileName: string): boolean {
  return imageExtensions.has(getExtension(fileName));
}

export function isDownloadableDocument(url: string): boolean {
  const cleanUrl = url.split("?")[0] ?? url;
  return isSupportedDocument(cleanUrl);
}
