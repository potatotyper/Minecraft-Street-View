const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const Busboy = require("busboy");
const dotenv = require("dotenv");

const projectRoot = path.resolve(__dirname, "..", "..");
const publicRoot = path.join(__dirname, "public");

dotenv.config({ path: path.join(projectRoot, ".env"), quiet: true });

const DEFAULT_PORT = 4173;
const MAX_PORT_FALLBACK_ATTEMPTS = 20;
const MAX_UPLOAD_FILES = 20000;
const MAX_UPLOAD_FILE_SIZE_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_UPLOAD_DIR_NAME = ".uploads";

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

function isWithinDirectory(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeInstantId(date = new Date()) {
  return date.toISOString().replaceAll(":", "-");
}

function parseDateCandidate(value) {
  if (typeof value !== "string" || !value.trim()) {
    return NaN;
  }

  const trimmed = value.trim();
  const direct = Date.parse(trimmed);
  if (Number.isFinite(direct)) {
    return direct;
  }

  const repairedSnapshotId = trimmed.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}(?:\.\d+)?Z)$/,
    "$1T$2:$3:$4"
  );
  const repaired = Date.parse(repairedSnapshotId);
  return Number.isFinite(repaired) ? repaired : NaN;
}

function cleanSnapshotId(value, fallback = `snapshot_${safeInstantId()}`) {
  const rawValue = typeof value === "string" && value.trim() ? value.trim() : fallback;
  const cleaned = rawValue
    .replaceAll(":", "-")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 140);

  if (!cleaned || cleaned === "." || cleaned === "..") {
    return fallback;
  }

  return cleaned;
}

function snapshotTimeMs(snapshotId, manifest, stats) {
  const candidates = [
    manifest?.createdAt,
    manifest?.exportedAt,
    manifest?.snapshotId,
    snapshotId
  ];

  for (const candidate of candidates) {
    const parsed = parseDateCandidate(candidate);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return stats?.mtimeMs || 0;
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
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
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

async function readUploadMeta(snapshotPath) {
  const uploadMetaPath = path.join(snapshotPath, "upload.json");
  try {
    const raw = await fsp.readFile(uploadMetaPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readStreetViewIndex(snapshotPath) {
  const streetViewPath = path.join(snapshotPath, "streetview.json");
  try {
    const raw = await fsp.readFile(streetViewPath, "utf8");
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
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }

    const snapshotId = entry.name;
    const snapshotPath = path.join(root, snapshotId);
    const manifest = await readManifest(snapshotPath);
    const uploadMeta = await readUploadMeta(snapshotPath);
    const streetView = await readStreetViewIndex(snapshotPath);
    const stats = await fsp.stat(snapshotPath);
    const createdTimeMs = snapshotTimeMs(snapshotId, manifest, stats);
    const uploadTimeMs = parseDateCandidate(uploadMeta?.uploadedAt);
    snapshots.push({
      snapshotId,
      snapshotPath,
      manifest,
      uploadMeta,
      streetView,
      createdAt: Number.isFinite(createdTimeMs) && createdTimeMs > 0
        ? new Date(createdTimeMs).toISOString()
        : null,
      createdTimeMs,
      uploadTimeMs: Number.isFinite(uploadTimeMs) ? uploadTimeMs : stats.mtimeMs
    });
  }

  snapshots.sort(compareSnapshotsNewestFirst);
  return snapshots;
}

function sanitizeSegment(segment) {
  return typeof segment === "string" && /^[A-Za-z0-9._:-]+$/.test(segment);
}

function compareSnapshotsNewestFirst(a, b) {
  return (b.createdTimeMs - a.createdTimeMs) ||
    (b.uploadTimeMs - a.uploadTimeMs) ||
    b.snapshotId.localeCompare(a.snapshotId);
}

function compareTileSources(candidate, existing) {
  return (candidate.snapshotTimeMs - existing.snapshotTimeMs) ||
    (candidate.uploadTimeMs - existing.uploadTimeMs) ||
    candidate.snapshotId.localeCompare(existing.snapshotId) ||
    candidate.fileName.localeCompare(existing.fileName);
}

async function listSnapshotDimensions(snapshot) {
  const dimensions = new Set();

  if (sanitizeSegment(snapshot.manifest?.dimension)) {
    dimensions.add(snapshot.manifest.dimension);
  }

  const tilesRoot = path.join(snapshot.snapshotPath, "tiles");
  if (!fs.existsSync(tilesRoot)) {
    return Array.from(dimensions);
  }

  const entries = await fsp.readdir(tilesRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && sanitizeSegment(entry.name)) {
      dimensions.add(entry.name);
    }
  }

  return Array.from(dimensions).sort();
}

async function collectDimensions(snapshots) {
  const allDimensions = new Set();
  const dimensionsBySnapshot = new Map();

  for (const snapshot of snapshots) {
    const dimensions = await listSnapshotDimensions(snapshot);
    dimensionsBySnapshot.set(snapshot.snapshotId, dimensions);
    for (const dimension of dimensions) {
      allDimensions.add(dimension);
    }
  }

  return {
    dimensions: Array.from(allDimensions).sort(),
    dimensionsBySnapshot
  };
}

function chooseDefaultDimension(snapshots, dimensions) {
  const available = new Set(dimensions);

  for (const snapshot of snapshots) {
    const dimension = snapshot.manifest?.dimension;
    if (available.has(dimension)) {
      return dimension;
    }
  }

  return dimensions[0] || null;
}

function boundsForTiles(tiles) {
  if (tiles.length === 0) {
    return null;
  }

  const minX = Math.min(...tiles.map((tile) => tile.x));
  const maxX = Math.max(...tiles.map((tile) => tile.x));
  const minZ = Math.min(...tiles.map((tile) => tile.z));
  const maxZ = Math.max(...tiles.map((tile) => tile.z));
  return { minX, maxX, minZ, maxZ };
}

function normalizeStreetViewAssetPath(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  const fileName = parts.at(-1) || "";
  const ext = path.extname(fileName).toLowerCase();

  if (
    parts.length === 0 ||
    parts.some((part) => !isSafeUploadSegment(part)) ||
    ![".jpg", ".jpeg", ".png"].includes(ext)
  ) {
    return null;
  }

  return parts;
}

function streetViewNodeDimension(index, node) {
  return typeof node?.dimension === "string" && node.dimension.trim()
    ? node.dimension
    : index?.dimension;
}

function publicStreetViewNode(snapshot, index, node) {
  const panoramaPath = node?.panoramaPath || node?.panoPath || node?.path || "";
  const thumbnailPath = node?.thumbnailPath || node?.thumbPath || "";
  const panoramaParts = normalizeStreetViewAssetPath(panoramaPath);

  if (!panoramaParts || node?.status !== "complete") {
    return null;
  }

  return {
    snapshotId: snapshot.snapshotId,
    nodeId: node.id || node.nodeId || `${snapshot.snapshotId}_${snapshot.streetView?.nodes?.indexOf(node) || 0}`,
    dimension: streetViewNodeDimension(index, node),
    x: Number(node.x),
    y: Number(node.y),
    z: Number(node.z),
    yaw: Number(node.yaw || 0),
    pitch: Number(node.pitch || 0),
    projection: node.projection || "equirectangular",
    width: Number(node.width || 4096),
    height: Number(node.height || 2048),
    format: node.format || "jpeg",
    includesEntities: Boolean(node.includesEntities),
    panoramaPath,
    thumbnailPath: normalizeStreetViewAssetPath(thumbnailPath) ? thumbnailPath : "",
    createdAt: index?.createdAt || snapshot.createdAt
  };
}

async function getStreetViewNodesForDimension(snapshots, dimension) {
  const nodes = [];

  for (const snapshot of snapshots) {
    const index = snapshot.streetView;
    if (!index || !Array.isArray(index.nodes)) {
      continue;
    }

    for (const node of index.nodes) {
      if (streetViewNodeDimension(index, node) !== dimension) {
        continue;
      }

      const publicNode = publicStreetViewNode(snapshot, index, node);
      if (
        publicNode &&
        Number.isFinite(publicNode.x) &&
        Number.isFinite(publicNode.y) &&
        Number.isFinite(publicNode.z)
      ) {
        nodes.push(publicNode);
      }
    }
  }

  nodes.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "") || a.nodeId.localeCompare(b.nodeId));
  return nodes;
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

async function getCurrentMap(requestedDimension) {
  const snapshots = await listSnapshots();
  const { dimensions } = await collectDimensions(snapshots);

  if (snapshots.length === 0) {
    return {
      status: 404,
      payload: {
        error: "No snapshots found.",
        hint: "Run '/streetview map build' in-game or upload an exported snapshot folder.",
        searchedRoots: fallbackRoots
      }
    };
  }

  if (requestedDimension && !dimensions.includes(requestedDimension)) {
    return {
      status: 404,
      payload: {
        error: `No snapshots found for dimension '${requestedDimension}'.`,
        dimensions
      }
    };
  }

  const dimension = requestedDimension || chooseDefaultDimension(snapshots, dimensions);
  if (!dimension) {
    return {
      status: 404,
      payload: {
        error: "No map dimensions found in stored snapshots.",
        dimensions
      }
    };
  }

  const tilesByChunk = new Map();
  const sourceSnapshots = new Set();
  let newestTileTimeMs = 0;

  for (const snapshot of snapshots) {
    const tiles = await getTilesForDimension(snapshot.snapshotId, dimension);
    for (const tile of tiles) {
      const candidate = {
        ...tile,
        snapshotId: snapshot.snapshotId,
        snapshotCreatedAt: snapshot.createdAt,
        snapshotTimeMs: snapshot.createdTimeMs,
        uploadTimeMs: snapshot.uploadTimeMs
      };
      const key = `${tile.x},${tile.z}`;
      const existing = tilesByChunk.get(key);

      if (!existing || compareTileSources(candidate, existing) > 0) {
        tilesByChunk.set(key, candidate);
      }
    }
  }

  const tiles = Array.from(tilesByChunk.values())
    .sort((a, b) => (a.z - b.z) || (a.x - b.x))
    .map((tile) => {
      sourceSnapshots.add(tile.snapshotId);
      newestTileTimeMs = Math.max(newestTileTimeMs, tile.snapshotTimeMs);
      const { snapshotTimeMs: _snapshotTimeMs, uploadTimeMs: _uploadTimeMs, ...publicTile } = tile;
      return publicTile;
    });

  if (tiles.length === 0) {
    return {
      status: 404,
      payload: {
        error: "No tiles found for the selected dimension.",
        dimension,
        dimensions
      }
    };
  }

  const streetViewNodes = await getStreetViewNodesForDimension(snapshots, dimension);

  return {
    status: 200,
    payload: {
      mode: "current",
      dimension,
      dimensions,
      tileCount: tiles.length,
      snapshotCount: snapshots.length,
      sourceSnapshotCount: sourceSnapshots.size,
      updatedAt: newestTileTimeMs > 0 ? new Date(newestTileTimeMs).toISOString() : null,
      bounds: boundsForTiles(tiles),
      streetViewNodes,
      tiles
    }
  };
}

function isSafeUploadSegment(segment) {
  return typeof segment === "string" &&
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    /^[A-Za-z0-9._ -]+$/.test(segment);
}

function normalizeUploadPath(fileName) {
  if (typeof fileName !== "string" || !fileName.trim()) {
    return null;
  }

  const normalized = fileName.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);

  if (parts.length === 0 || parts.some((part) => !isSafeUploadSegment(part))) {
    return null;
  }

  return parts;
}

function isAllowedUploadedFile(fileName) {
  return fileName === "manifest.json" ||
    fileName === "upload.json" ||
    fileName === "streetview.json" ||
    fileName === "capture.json" ||
    fileName.endsWith(".png") ||
    fileName.endsWith(".jpg") ||
    fileName.endsWith(".jpeg");
}

async function removeDirectoryIfExists(directory) {
  try {
    await fsp.rm(directory, { recursive: true, force: true });
  } catch {
    // Best effort cleanup; import/upload errors are reported separately.
  }
}

async function findUploadedSnapshotDirs(root, depth = 0) {
  if (depth > 8 || !fs.existsSync(root)) {
    return [];
  }

  const manifestPath = path.join(root, "manifest.json");
  if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile()) {
    return [root];
  }

  const snapshotDirs = [];
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }

    const childDirs = await findUploadedSnapshotDirs(path.join(root, entry.name), depth + 1);
    snapshotDirs.push(...childDirs);
  }

  return snapshotDirs;
}

async function hasTiles(snapshotPath) {
  const tilesRoot = path.join(snapshotPath, "tiles");
  if (!fs.existsSync(tilesRoot)) {
    return false;
  }

  const dimensions = await fsp.readdir(tilesRoot, { withFileTypes: true });
  for (const dimension of dimensions) {
    if (!dimension.isDirectory()) {
      continue;
    }

    const tileDir = path.join(tilesRoot, dimension.name, "z0");
    if (!fs.existsSync(tileDir)) {
      continue;
    }

    const files = await fsp.readdir(tileDir, { withFileTypes: true });
    if (files.some((file) => file.isFile() && file.name.endsWith(".png"))) {
      return true;
    }
  }

  return false;
}

async function uniqueSnapshotDestination(baseSnapshotId) {
  const root = getMapOutputRoot();
  const safeBaseId = cleanSnapshotId(baseSnapshotId);
  let snapshotId = safeBaseId;
  let destination = path.join(root, snapshotId);
  let attempt = 0;

  while (fs.existsSync(destination)) {
    attempt++;
    snapshotId = `${safeBaseId}_upload_${safeInstantId()}${attempt > 1 ? `_${attempt}` : ""}`;
    destination = path.join(root, snapshotId);
  }

  return { snapshotId, destination };
}

async function importUploadedSnapshots(stagingDir, uploadStartedAt, uploadedBy) {
  const root = getMapOutputRoot();
  await fsp.mkdir(root, { recursive: true });

  const snapshotDirs = await findUploadedSnapshotDirs(stagingDir);
  const imported = [];
  const skipped = [];

  for (const snapshotDir of snapshotDirs) {
    const manifest = await readManifest(snapshotDir);
    const sourceLabel = path.relative(stagingDir, snapshotDir) || ".";

    if (!manifest) {
      skipped.push({ source: sourceLabel, reason: "Missing or invalid manifest.json." });
      continue;
    }

    if (!(await hasTiles(snapshotDir))) {
      skipped.push({ source: sourceLabel, reason: "No PNG tiles found under tiles/<dimension>/z0." });
      continue;
    }

    const baseSnapshotId = manifest.snapshotId || path.basename(snapshotDir);
    const { snapshotId, destination } = await uniqueSnapshotDestination(baseSnapshotId);

    await fsp.cp(snapshotDir, destination, {
      recursive: true,
      force: false,
      errorOnExist: true
    });

    const uploadMeta = {
      uploadedAt: uploadStartedAt,
      uploadedBy: uploadedBy || null,
      originalSnapshotId: manifest.snapshotId || null,
      storedSnapshotId: snapshotId,
      sourcePath: sourceLabel
    };
    await fsp.writeFile(path.join(destination, "upload.json"), JSON.stringify(uploadMeta, null, 2));

    imported.push({
      snapshotId,
      originalSnapshotId: manifest.snapshotId || null,
      dimension: manifest.dimension || null,
      source: sourceLabel
    });
  }

  return { imported, skipped };
}

function waitForWrite(stream, file) {
  return new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
    file.on("error", reject);
  });
}

async function handleSnapshotUpload(request, response) {
  const requestContentType = request.headers["content-type"] || "";
  if (!requestContentType.includes("multipart/form-data")) {
    sendJson(response, 415, { error: "Upload must use multipart/form-data." });
    return;
  }

  const root = getMapOutputRoot();
  const uploadStartedAt = new Date().toISOString();
  const stagingDir = path.join(root, SNAPSHOT_UPLOAD_DIR_NAME, `${Date.now()}-${crypto.randomUUID()}`);
  await fsp.mkdir(stagingDir, { recursive: true });

  const busboy = Busboy({
    headers: request.headers,
    preservePath: true,
    limits: {
      files: MAX_UPLOAD_FILES,
      fileSize: MAX_UPLOAD_FILE_SIZE_BYTES
    }
  });

  const pendingWrites = [];
  const fields = new Map();
  let acceptedFiles = 0;
  let ignoredFiles = 0;
  let uploadError = null;

  await new Promise((resolve) => {
    let isDone = false;
    function done() {
      if (!isDone) {
        isDone = true;
        resolve();
      }
    }

    busboy.on("field", (name, value) => {
      fields.set(name, value.slice(0, 200));
    });

    busboy.on("file", (_name, file, info) => {
      const parts = normalizeUploadPath(info.filename);
      const uploadedFileName = parts?.at(-1);

      if (!parts || !isAllowedUploadedFile(uploadedFileName)) {
        ignoredFiles++;
        file.resume();
        return;
      }

      const destination = path.resolve(stagingDir, ...parts);
      if (!isWithinDirectory(stagingDir, destination)) {
        ignoredFiles++;
        file.resume();
        return;
      }

      acceptedFiles++;
      const writePromise = fsp.mkdir(path.dirname(destination), { recursive: true })
        .then(() => {
          const writeStream = fs.createWriteStream(destination);
          file.on("limit", () => {
            uploadError = new Error(`Upload file '${info.filename}' exceeded ${MAX_UPLOAD_FILE_SIZE_BYTES} bytes.`);
            writeStream.destroy(uploadError);
          });
          file.pipe(writeStream);
          return waitForWrite(writeStream, file);
        })
        .catch((error) => {
          uploadError = error;
        });

      pendingWrites.push(writePromise);
    });

    busboy.on("filesLimit", () => {
      uploadError = new Error(`Upload exceeded ${MAX_UPLOAD_FILES} files.`);
    });

    busboy.on("error", (error) => {
      uploadError = error;
      done();
    });

    busboy.on("finish", done);
    busboy.on("close", done);
    request.pipe(busboy);
  });

  await Promise.all(pendingWrites);

  if (uploadError) {
    await removeDirectoryIfExists(stagingDir);
    sendJson(response, 400, { error: uploadError.message });
    return;
  }

  if (acceptedFiles === 0) {
    await removeDirectoryIfExists(stagingDir);
    sendJson(response, 400, {
      error: "No snapshot files were uploaded.",
      hint: "Choose a snapshot folder or a streetview-map folder containing manifest.json and PNG tiles."
    });
    return;
  }

  const uploadResult = await importUploadedSnapshots(
    stagingDir,
    uploadStartedAt,
    fields.get("uploadedBy") || ""
  );
  await removeDirectoryIfExists(stagingDir);

  if (uploadResult.imported.length === 0) {
    sendJson(response, 400, {
      error: "No valid snapshots were found in the upload.",
      ignoredFiles,
      skipped: uploadResult.skipped
    });
    return;
  }

  sendJson(response, 201, {
    ok: true,
    acceptedFiles,
    ignoredFiles,
    imported: uploadResult.imported,
    skipped: uploadResult.skipped
  });
}

async function handleApi(request, response, url) {
  if (url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, mapOutputRoot: getMapOutputRoot() });
    return;
  }

  if (url.pathname === "/api/snapshot/upload") {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Use POST to upload snapshots." });
      return;
    }

    await handleSnapshotUpload(request, response);
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "API route only supports GET." });
    return;
  }

  if (url.pathname === "/api/snapshots") {
    const snapshots = await listSnapshots();
    const { dimensions } = await collectDimensions(snapshots);
    sendJson(response, 200, {
      mapOutputRoot: getMapOutputRoot(),
      snapshotCount: snapshots.length,
      dimensions,
      snapshots: snapshots.map((snapshot) => ({
        snapshotId: snapshot.snapshotId,
        manifest: snapshot.manifest,
        uploadMeta: snapshot.uploadMeta,
        streetView: snapshot.streetView,
        createdAt: snapshot.createdAt
      }))
    });
    return;
  }

  if (url.pathname === "/api/map/current") {
    const dimension = url.searchParams.get("dimension") || "";
    if (dimension && !sanitizeSegment(dimension)) {
      sendJson(response, 400, { error: "Invalid dimension." });
      return;
    }

    const result = await getCurrentMap(dimension || null);
    sendJson(response, result.status, result.payload);
    return;
  }

  if (url.pathname === "/api/streetview/current") {
    const dimension = url.searchParams.get("dimension") || "";
    if (dimension && !sanitizeSegment(dimension)) {
      sendJson(response, 400, { error: "Invalid dimension." });
      return;
    }

    const snapshots = await listSnapshots();
    const { dimensions } = await collectDimensions(snapshots);
    const selectedDimension = dimension || chooseDefaultDimension(snapshots, dimensions);
    if (!selectedDimension) {
      sendJson(response, 404, { error: "No dimensions found.", dimensions });
      return;
    }

    sendJson(response, 200, {
      dimension: selectedDimension,
      dimensions,
      nodes: await getStreetViewNodesForDimension(snapshots, selectedDimension)
    });
    return;
  }

  if (url.pathname === "/api/snapshot/latest") {
    const snapshots = await listSnapshots();
    if (snapshots.length === 0) {
      sendJson(response, 404, {
        error: "No snapshots found.",
        hint: "Run '/streetview map build' in-game or upload an exported snapshot folder.",
        searchedRoots: fallbackRoots
      });
      return;
    }

    const latest = snapshots[0];
    sendJson(response, 200, {
      snapshotId: latest.snapshotId,
      manifest: latest.manifest,
      createdAt: latest.createdAt
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

    sendJson(response, 200, {
      snapshotId,
      dimension,
      tileCount: tiles.length,
      bounds: boundsForTiles(tiles),
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

  if (url.pathname === "/api/panorama") {
    const snapshotId = url.searchParams.get("snapshot") || "";
    const assetPath = url.searchParams.get("path") || "";
    const assetParts = normalizeStreetViewAssetPath(assetPath);

    if (!sanitizeSegment(snapshotId) || !assetParts) {
      sendJson(response, 400, { error: "Invalid panorama request." });
      return;
    }

    const root = getMapOutputRoot();
    const snapshotDir = path.resolve(root, snapshotId);
    const filePath = path.resolve(snapshotDir, ...assetParts);

    if (!isWithinDirectory(snapshotDir, filePath)) {
      sendJson(response, 403, { error: "Forbidden panorama path." });
      return;
    }

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      sendJson(response, 404, { error: "Panorama not found." });
      return;
    }

    const stream = fs.createReadStream(filePath);
    response.writeHead(200, { "Content-Type": contentType(filePath) });
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
