import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..", "..");
const publicRoot = path.join(__dirname, "public");
const port = Number(process.env.PORT || 4173);

const configuredOutput = process.env.MAP_OUTPUT_DIR
  ? path.resolve(process.env.MAP_OUTPUT_DIR)
  : null;

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
  const tiles = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".png")) {
      continue;
    }

    const match = /^tile_(-?\d+)_(-?\d+)\.png$/.exec(entry.name);
    if (!match) {
      continue;
    }

    tiles.push({
      x: Number(match[1]),
      z: Number(match[2]),
      fileName: entry.name
    });
  }

  return tiles;
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
    const x = url.searchParams.get("x") || "";
    const z = url.searchParams.get("z") || "";

    if (!sanitizeSegment(snapshotId) || !sanitizeSegment(dimension)) {
      sendJson(response, 400, { error: "Invalid snapshot or dimension." });
      return;
    }

    if (!/^-?\d+$/.test(x) || !/^-?\d+$/.test(z)) {
      sendJson(response, 400, { error: "Invalid tile coordinates." });
      return;
    }

    const root = getMapOutputRoot();
    const filePath = path.join(root, snapshotId, "tiles", dimension, "z0", `tile_${x}_${z}.png`);

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

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[web-viewer] Listening on http://localhost:${port}`);
  // eslint-disable-next-line no-console
  console.log(`[web-viewer] Map output root: ${getMapOutputRoot()}`);
});
