const metaEl = document.getElementById("meta");
const errorEl = document.getElementById("error");
const coordsEl = document.getElementById("coords");
let tileByChunk = new Map();

const map = L.map("map", {
  crs: L.CRS.Simple,
  minZoom: -6,
  maxZoom: 8,
  zoomSnap: 0.125
});

L.control.scale({ imperial: false }).addTo(map);

function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
}

function clearError() {
  errorEl.textContent = "";
  errorEl.classList.add("hidden");
}

async function getJson(url) {
  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || `Request failed for ${url}`);
  }

  return data;
}

function tileBounds(tile) {
  const northWest = L.latLng(-tile.z, tile.x);
  const southEast = L.latLng(-(tile.z + 1), tile.x + 1);
  return L.latLngBounds(northWest, southEast);
}

function normalizeTile(tile) {
  if (Number.isFinite(tile.centerX) && Number.isFinite(tile.centerZ)) {
    return {
      ...tile,
      x: Math.trunc((tile.centerX - 8) / 16),
      z: Math.trunc((tile.centerZ - 8) / 16)
    };
  }

  return tile;
}

function formatHoverCoordinates(latlng) {
  const mapX = latlng.lng;
  const mapY = latlng.lat;
  const chunkX = Math.floor(mapX);
  const chunkZ = Math.floor(-mapY);
  const blockX = Math.floor(mapX * 16);
  const blockZ = Math.floor(-mapY * 16);
  const key = `${chunkX},${chunkZ}`;
  const tile = tileByChunk.get(key);
  const centerText = tile && Number.isFinite(tile.centerX) && Number.isFinite(tile.centerY) && Number.isFinite(tile.centerZ)
    ? `tileCenter x=${tile.centerX} y=${tile.centerY} z=${tile.centerZ}`
    : "tileCenter n/a";

  return [
    `map x=${mapX.toFixed(3)} y=${mapY.toFixed(3)}`,
    `chunk x=${chunkX} z=${chunkZ}`,
    `block x=${blockX} z=${blockZ}`,
    centerText
  ].join(" | ");
}

function bindHoverCoordinates() {
  if (!coordsEl) {
    return;
  }

  map.on("mousemove", (event) => {
    coordsEl.textContent = formatHoverCoordinates(event.latlng);
  });

  map.on("mouseout", () => {
    coordsEl.textContent = "Hover map to inspect coordinates";
  });
}

function addTiles(snapshotId, dimension, tiles) {
  const bounds = [];
  const normalizedTiles = tiles
    .map(normalizeTile)
    .sort((a, b) => (a.z - b.z) || (a.x - b.x));

  tileByChunk = new Map(normalizedTiles.map((tile) => [`${tile.x},${tile.z}`, tile]));

  for (const tile of normalizedTiles) {
    const src = tile.fileName
      ? `/api/tile?snapshot=${encodeURIComponent(snapshotId)}&dimension=${encodeURIComponent(dimension)}&file=${encodeURIComponent(tile.fileName)}`
      : `/api/tile?snapshot=${encodeURIComponent(snapshotId)}&dimension=${encodeURIComponent(dimension)}&x=${tile.x}&z=${tile.z}`;
    const b = tileBounds(tile);
    bounds.push(b);

    L.imageOverlay(src, b, {
      interactive: false,
      opacity: 1
    }).addTo(map);
  }

  return L.latLngBounds(bounds.map((b) => [b.getNorth(), b.getWest()]).concat(
    bounds.map((b) => [b.getSouth(), b.getEast()])
  ));
}

async function bootstrap() {
  try {
    clearError();
    bindHoverCoordinates();

    const latest = await getJson("/api/snapshot/latest");
    const snapshotId = latest.snapshotId;
    const defaultDimension = latest.manifest?.dimension || "minecraft_overworld";

    const meta = await getJson(
      `/api/snapshot/meta?snapshot=${encodeURIComponent(snapshotId)}&dimension=${encodeURIComponent(defaultDimension)}`
    );

    const mapBounds = addTiles(snapshotId, defaultDimension, meta.tiles);
    map.fitBounds(mapBounds.pad(0.08));

    metaEl.textContent = [
      `snapshot=${snapshotId}`,
      `dimension=${defaultDimension}`,
      `tiles=${meta.tileCount}`
    ].join(" | ");
  } catch (error) {
    showError(error.message);
    metaEl.textContent = "No map data found.";
  }
}

bootstrap();
