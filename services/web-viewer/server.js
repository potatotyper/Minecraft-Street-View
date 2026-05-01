const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const dotenv = require("dotenv");

const projectRoot = path.resolve(__dirname, "..", "..");
const publicRoot = path.join(__dirname, "public");

dotenv.config({ path: path.join(projectRoot, ".env"), quiet: true });

const DEFAULT_PORT = 4173;
const MAX_PORT_FALLBACK_ATTEMPTS = 20;

function parsePort(value) {
  const portNumber = Number(value);
  return Number.isInteger(portNumber) && portNumber > 0 && portNumber <= 65535
    ? portNumber
    : DEFAULT_PORT;
}

const port = parsePort(process.env.PORT || DEFAULT_PORT);
const canTryFallbackPorts = !process.env.PORT;

function cleanConfiguredPath(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function resolveConfiguredPath(value) {
  if (!value || !value.trim()) {
    return null;
  }

  const cleaned = cleanConfiguredPath(value);
  return path.isAbsolute(cleaned)
    ? path.normalize(cleaned)
    : path.resolve(projectRoot, cleaned);
}

const configuredOutput = resolveConfiguredPath(process.env.MAP_OUTPUT_DIR);

const fallbackRoots = [
  configuredOutput,
  path.join(projectRoot, "run", "streetview-map"),
  path.join(projectRoot, "streetview-map")
].filter(Boolean);

function getMapOutputRoot() {
  for (const candidate of fallbackRoots) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return fallbackRoots[0];
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text)
  });
  response.end(text);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  return "application/octet-stream";
}

async function readManifest(snapshotPath) {
  const manifestPath = path.join(snapshotPath, "manifest.json");
  try {
    const raw = await fsp.readFile(manifestPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function listSnapshots() {
  const root = getMapOutputRoot();
  if (!root || !fs.existsSync(root)) {
    return [];
  }

  const entries = await fsp.readdir(root, { withFileTypes: true });
  const snapshots = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const snapshotId = entry.name;
    const snapshotPath = path.join(root, snapshotId);
    const manifest = await readManifest(snapshotPath);
    snapshots.push({
      snapshotId,
      snapshotPath,
      manifest
    });
  }

  snapshots.sort((a, b) => b.snapshotId.localeCompare(a.snapshotId));
  return snapshots;
}

function sanitizeSegment(segment) {
  return typeof segment === "string" && /^[A-Za-z0-9._:-]+$/.test(segment);
}

async function getTilesForDimension(snapshotId, dimension) {
  const root = getMapOutputRoot();
  const tileDir = path.join(root, snapshotId, "tiles", dimension, "z0");
  if (!fs.existsSync(tileDir)) {
    return [];
  }

  const entries = await fsp.readdir(tileDir, { withFileTypes: true });
  const tilesByChunk = new Map();

  function maybeSetTile(tile, priority) {
    const key = `${tile.x},${tile.z}`;
    const existing = tilesByChunk.get(key);
    if (!existing || priority > existing.priority || (priority === existing.priority && tile.fileName < existing.tile.fileName)) {
      tilesByChunk.set(key, { tile, priority });
    }
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".png")) {
      continue;
    }

    const centerMatch = /^tile_center_(-?\d+)_(-?\d+)_(-?\d+)\.png$/.exec(entry.name);
    if (centerMatch) {
      const centerX = Number(centerMatch[1]);
      const centerY = Number(centerMatch[2]);
      const centerZ = Number(centerMatch[3]);
      maybeSetTile({
        x: Math.trunc((centerX - 8) / 16),
        z: Math.trunc((centerZ - 8) / 16),
        centerX,
        centerY,
        centerZ,
        fileName: entry.name
      }, 2);
      continue;
    }

    const legacyMatch = /^tile_(-?\d+)_(-?\d+)\.png$/.exec(entry.name);
    if (legacyMatch) {
      maybeSetTile({
        x: Number(legacyMatch[1]),
        z: Number(legacyMatch[2]),
        fileName: entry.name
      }, 1);
    }
  }

  return Array.from(tilesByChunk.values())
    .map((entry) => entry.tile)
    .sort((a, b) => (a.z - b.z) || (a.x - b.x));
}

async function handleApi(request, response, url) {
  if (url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, mapOutputRoot: getMapOutputRoot() });
    return;
  }

  if (url.pathname === "/api/snapshot/latest") {
    const snapshots = await listSnapshots();
    if (snapshots.length === 0) {
      sendJson(response, 404, {
        error: "No snapshots found.",
        hint: "Run '/streetview map build' in-game, then restart this web server if needed.",
        searchedRoots: fallbackRoots
      });
      return;
    }

    const latest = snapshots[0];
    sendJson(response, 200, {
      snapshotId: latest.snapshotId,
      manifest: latest.manifest
    });
    return;
  }

  if (url.pathname === "/api/snapshot/meta") {
    const snapshotId = url.searchParams.get("snapshot") || "";
    const dimension = url.searchParams.get("dimension") || "";

    if (!sanitizeSegment(snapshotId) || !sanitizeSegment(dimension)) {
      sendJson(response, 400, { error: "Invalid snapshot or dimension." });
      return;
    }

    const tiles = await getTilesForDimension(snapshotId, dimension);
    if (tiles.length === 0) {
      sendJson(response, 404, { error: "No tiles found for snapshot/dimension." });
      return;
    }

    const minX = Math.min(...tiles.map((tile) => tile.x));
    const maxX = Math.max(...tiles.map((tile) => tile.x));
    const minZ = Math.min(...tiles.map((tile) => tile.z));
    const maxZ = Math.max(...tiles.map((tile) => tile.z));

    sendJson(response, 200, {
      snapshotId,
      dimension,
      tileCount: tiles.length,
      bounds: { minX, maxX, minZ, maxZ },
      tiles
    });
    return;
  }

  if (url.pathname === "/api/tile") {
    const snapshotId = url.searchParams.get("snapshot") || "";
    const dimension = url.searchParams.get("dimension") || "";
    const fileName = url.searchParams.get("file") || "";
    const x = url.searchParams.get("x") || "";
    const z = url.searchParams.get("z") || "";

    if (!sanitizeSegment(snapshotId) || !sanitizeSegment(dimension)) {
      sendJson(response, 400, { error: "Invalid snapshot or dimension." });
      return;
    }

    const root = getMapOutputRoot();
    const tileDir = path.join(root, snapshotId, "tiles", dimension, "z0");
    let filePath = "";

    if (fileName && /^tile_[A-Za-z0-9._-]+\.png$/.test(fileName)) {
      filePath = path.join(tileDir, fileName);
    } else {
      if (!/^-?\d+$/.test(x) || !/^-?\d+$/.test(z)) {
        sendJson(response, 400, { error: "Invalid tile coordinates." });
        return;
      }
      filePath = path.join(tileDir, `tile_${x}_${z}.png`);
    }

    if (!fs.existsSync(filePath)) {
      sendJson(response, 404, { error: "Tile not found." });
      return;
    }

    const stream = fs.createReadStream(filePath);
    response.writeHead(200, { "Content-Type": "image/png" });
    stream.pipe(response);
    return;
  }

  sendJson(response, 404, { error: "Unknown API route." });
}

async function handleStatic(response, urlPathname) {
  const normalized = urlPathname === "/" ? "/index.html" : urlPathname;
  const resolved = path.resolve(publicRoot, `.${normalized}`);

  if (!resolved.startsWith(publicRoot)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    sendText(response, 404, "Not found");
    return;
  }

  const body = await fsp.readFile(resolved);
  response.writeHead(200, {
    "Content-Type": contentType(resolved),
    "Content-Length": body.byteLength
  });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);

  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }

    await handleStatic(response, url.pathname);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error";
    sendJson(response, 500, { error: message });
  }
});

function listen(portToTry, remainingFallbackAttempts = MAX_PORT_FALLBACK_ATTEMPTS) {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && canTryFallbackPorts && remainingFallbackAttempts > 0) {
      const nextPort = portToTry + 1;
      // eslint-disable-next-line no-console
      console.warn(`[web-viewer] Port ${portToTry} is in use, trying ${nextPort}...`);
      listen(nextPort, remainingFallbackAttempts - 1);
      return;
    }

    if (error.code === "EADDRINUSE") {
      // eslint-disable-next-line no-console
      console.error(`[web-viewer] Port ${portToTry} is already in use. Set PORT=another_number or stop the existing server.`);
    } else {
      // eslint-disable-next-line no-console
      console.error(error);
    }

    process.exitCode = 1;
  });

  server.listen(portToTry, () => {
    // eslint-disable-next-line no-console
    console.log(`[web-viewer] Listening on http://localhost:${portToTry}`);
    // eslint-disable-next-line no-console
    console.log(`[web-viewer] Map output root: ${getMapOutputRoot()}`);
    // eslint-disable-next-line no-console
    console.log(`[web-viewer] Project env: ${path.join(projectRoot, ".env")}`);
  });
}

listen(port);
