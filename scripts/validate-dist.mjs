import { access, readFile, readdir } from "node:fs/promises";

const requiredFiles = [
  "dist/manifest.json",
  "dist/service-worker.js",
  "dist/content.js",
  "dist/content.css",
  "dist/icons/icon-128.png",
  "dist/popup.html",
  "dist/options.html",
  "dist/translator.html",
  "dist/pdf.html",
  "dist/pdf.js",
  "dist/pdf.css"
];

await Promise.all(requiredFiles.map((file) => access(file)));

async function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(`${directory}/${entry.name}`, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function cspSources(policy, directive) {
  const value = policy.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${directive} `));
  return value?.split(/\s+/).slice(1) ?? [];
}

const manifest = JSON.parse(await readFile("dist/manifest.json", "utf8"));
if (manifest.manifest_version !== 3) throw new Error("manifest_version 必须为 3");
if (manifest.background?.service_worker !== "service-worker.js") throw new Error("service worker 产物名不匹配");
if (manifest.background?.type !== "module") throw new Error("service worker 必须为 module");
if (manifest.action?.default_popup !== "popup.html") throw new Error("popup 产物名不匹配");
if (manifest.minimum_chrome_version !== "115") throw new Error("minimum_chrome_version 必须为 115");
for (const permission of ["http://*/*", "https://*/*"]) {
  if (!manifest.optional_host_permissions?.includes(permission)) throw new Error(`缺少可选来源权限：${permission}`);
}

const extensionPolicy = manifest.content_security_policy?.extension_pages ?? "";
for (const directive of ["script-src", "worker-src"]) {
  const sources = cspSources(extensionPolicy, directive);
  if (sources.length !== 1 || sources[0] !== "'self'") throw new Error(`${directive} 只能允许 'self'`);
}
const connectSources = cspSources(extensionPolicy, "connect-src");
if (!connectSources.includes("http:") || !connectSources.includes("https:")) {
  throw new Error("connect-src 必须允许经授权访问 HTTP/HTTPS PDF");
}

const content = await readFile("dist/content.js", "utf8");
if (/^\s*import\s/m.test(content)) {
  throw new Error("动态注入的 content.js 不能包含 ESM import");
}

const pdfHtml = await readFile("dist/pdf.html", "utf8");
const scriptSources = [...pdfHtml.matchAll(/<script\b[^>]*\bsrc=(['"])(.*?)\1/gi)].map((match) => match[2]);
if (!scriptSources.some((source) => source.replace(/^\.?(?:\/)/, "") === "pdf.js")) {
  throw new Error("pdf.html 未引用 pdf.js");
}
for (const source of scriptSources) {
  if (/^(?:https?:)?\/\//i.test(source)) throw new Error("pdf.html 不得引用远程 script");
  if (/[?#]/.test(source)) throw new Error("pdf.html 的 script URL 不得包含 query/hash");
}

const distFiles = await listFiles("dist");
const workerFiles = distFiles.filter((file) => /^pdf\.worker(?:\.min)?(?:-[\w-]+)?\.mjs$/.test(file));
if (workerFiles.length !== 1) throw new Error(`必须生成一个 PDF worker，实际为 ${workerFiles.length} 个`);
const workerFile = workerFiles[0];
const pdfBundle = await readFile("dist/pdf.js", "utf8");
const workerReferences = [...pdfBundle.matchAll(/(['"`])([^'"`]*pdf\.worker(?:\.min)?(?:-[\w-]+)?\.mjs)\1/g)]
  .map((match) => match[2]);
if (workerReferences.some((reference) => /^(?:https?:)?\/\//i.test(reference))) {
  throw new Error("PDF bundle 不得引用远程 worker");
}
if (!workerReferences.some((reference) => reference.replace(/^\.?(?:\/)/, "") === workerFile)) {
  throw new Error(`PDF bundle 未引用扩展本地 worker：${workerFile}`);
}
if (!pdfBundle.includes("__core-js_shared__") || !pdfBundle.includes("core-js")) {
  throw new Error("PDF bundle 缺少 legacy 构建的兼容性 polyfill 标记");
}

console.log(`Validated ${requiredFiles.length + workerFiles.length} extension artifacts (worker: ${workerFile}; PDF.js legacy polyfills detected).`);
