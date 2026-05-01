const metaEl = document.getElementById("meta");
const errorEl = document.getElementById("error");
const coordsEl = document.getElementById("coords");
const BLOCKS_PER_CHUNK = 16;

const map = L.map("map", {
  crs: L.CRS.Simple,
  minZoom: -6,
  maxZoom: 8,
  zoomSnap: 0.125,
  attributionControl: false
});

function formatBlockScale(blocks) {
  const value = Number.isInteger(blocks)
    ? String(blocks)
    : blocks.toFixed(3).replace(/\.?0+$/, "");
  return `${value} ${blocks === 1 ? "block" : "blocks"}`;
}

function getRoundBlockScale(maxBlocks) {
  if (maxBlocks >= 1) {
    return L.Control.Scale.prototype._getRoundNum(maxBlocks);
  }

  return 2 ** Math.floor(Math.log2(maxBlocks));
}

const BlockScaleControl = L.Control.Scale.extend({
  _updateMetric(maxBlocks) {
    if (!Number.isFinite(maxBlocks) || maxBlocks <= 0) {
      this._mScale.style.display = "none";
      return;
    }

    this._mScale.style.display = "";
    const blocks = getRoundBlockScale(maxBlocks);
    this._updateScale(this._mScale, formatBlockScale(blocks), blocks / maxBlocks);
  }
});

new BlockScaleControl({ imperial: false }).addTo(map);

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
  const west = tile.x * BLOCKS_PER_CHUNK;
  const east = west + BLOCKS_PER_CHUNK;
  const north = -(tile.z * BLOCKS_PER_CHUNK);
  const south = north - BLOCKS_PER_CHUNK;
  const northWest = L.latLng(north, west);
  const southEast = L.latLng(south, east);
  return L.latLngBounds(northWest, southEast);
}

function normalizeTile(tile) {
  if (Number.isFinite(tile.centerX) && Number.isFinite(tile.centerZ)) {
    return {
      ...tile,
      x: Math.trunc((tile.centerX - (BLOCKS_PER_CHUNK / 2)) / BLOCKS_PER_CHUNK),
      z: Math.trunc((tile.centerZ - (BLOCKS_PER_CHUNK / 2)) / BLOCKS_PER_CHUNK)
    };
  }

  return tile;
}

function formatHoverCoordinates(latlng) {
  const blockX = Math.floor(latlng.lng);
  const blockZ = Math.floor(-latlng.lat);
  return `block x=${blockX} z=${blockZ}`;
}

function bindHoverCoordinates() {
  if (!coordsEl) {
    return;
  }

  map.on("mousemove", (event) => {
    coordsEl.textContent = formatHoverCoordinates(event.latlng);
  });

  map.on("mouseout", () => {
    coordsEl.textContent = "Hover map to inspect block coordinates";
  });
}

function addTiles(snapshotId, dimension, tiles) {
  const bounds = [];
  const normalizedTiles = tiles
    .map(normalizeTile)
    .sort((a, b) => (a.z - b.z) || (a.x - b.x));

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
      `scale=blocks`,
      `tiles=${meta.tileCount}`
    ].join(" | ");
  } catch (error) {
    showError(error.message);
    metaEl.textContent = "No map data found.";
  }
}

bootstrap();
