const metaEl = document.getElementById("meta");
const errorEl = document.getElementById("error");

const map = L.map("map", {
  crs: L.CRS.Simple,
  minZoom: -4,
  maxZoom: 4,
  zoomSnap: 0.25
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
  const northWest = L.latLng(tile.z, tile.x);
  const southEast = L.latLng(tile.z + 1, tile.x + 1);
  return L.latLngBounds(northWest, southEast);
}

function addTiles(snapshotId, dimension, tiles) {
  const bounds = [];

  for (const tile of tiles) {
    const src = `/api/tile?snapshot=${encodeURIComponent(snapshotId)}&dimension=${encodeURIComponent(dimension)}&x=${tile.x}&z=${tile.z}`;
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
