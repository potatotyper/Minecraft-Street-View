import * as THREE from "https://unpkg.com/three@0.164.1/build/three.module.js";

const metaEl = document.getElementById("meta");
const errorEl = document.getElementById("error");
const coordsEl = document.getElementById("coords");
const uploadInputEl = document.getElementById("snapshot-upload");
const uploadButtonEl = document.getElementById("upload-button");
const uploadStatusEl = document.getElementById("upload-status");
const dimensionSelectEl = document.getElementById("dimension-select");
const panoPanelEl = document.getElementById("pano-panel");
const panoViewEl = document.getElementById("pano-view");
const panoTitleEl = document.getElementById("pano-title");
const panoCloseEl = document.getElementById("pano-close");
const BLOCKS_PER_CHUNK = 16;

const map = L.map("map", {
  crs: L.CRS.Simple,
  minZoom: -6,
  maxZoom: 8,
  zoomSnap: 0.125,
  attributionControl: false
});

const tileLayer = L.layerGroup().addTo(map);
const streetViewLayer = L.layerGroup().addTo(map);
let selectedDimension = "";
let activePanorama = null;

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

function setUploadStatus(message, isError = false) {
  if (!uploadStatusEl) {
    return;
  }

  uploadStatusEl.textContent = message;
  uploadStatusEl.classList.toggle("is-error", isError);
}

function formatShortDateTime(isoValue) {
  if (!isoValue) {
    return "unknown";
  }

  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) {
    return isoValue;
  }

  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  });
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

function tileImageSource(tile, dimension) {
  const snapshotId = tile.snapshotId;

  if (tile.fileName) {
    return `/api/tile?snapshot=${encodeURIComponent(snapshotId)}&dimension=${encodeURIComponent(dimension)}&file=${encodeURIComponent(tile.fileName)}`;
  }

  return `/api/tile?snapshot=${encodeURIComponent(snapshotId)}&dimension=${encodeURIComponent(dimension)}&x=${tile.x}&z=${tile.z}`;
}

function addTiles(dimension, tiles) {
  tileLayer.clearLayers();

  const bounds = [];
  const normalizedTiles = tiles
    .map(normalizeTile)
    .sort((a, b) => (a.z - b.z) || (a.x - b.x));

  for (const tile of normalizedTiles) {
    const src = tileImageSource(tile, dimension);
    const b = tileBounds(tile);
    bounds.push(b);

    L.imageOverlay(src, b, {
      interactive: false,
      opacity: 1
    }).addTo(tileLayer);
  }

  return L.latLngBounds(bounds.map((b) => [b.getNorth(), b.getWest()]).concat(
    bounds.map((b) => [b.getSouth(), b.getEast()])
  ));
}

function streetViewLatLng(node) {
  return L.latLng(-node.z, node.x);
}

function panoramaImageSource(node) {
  const params = new URLSearchParams({
    snapshot: node.snapshotId,
    path: node.panoramaPath
  });
  return `/api/panorama?${params}`;
}

function addStreetViewMarkers(nodes) {
  streetViewLayer.clearLayers();

  const icon = L.divIcon({
    className: "streetview-marker",
    html: "<span></span>",
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });

  for (const node of nodes) {
    L.marker(streetViewLatLng(node), {
      icon,
      keyboard: true,
      title: `Street View ${node.nodeId}`
    })
      .on("click", () => openPanorama(node))
      .addTo(streetViewLayer);
  }
}

function updateDimensionSelect(dimensions, dimension) {
  if (!dimensionSelectEl) {
    return;
  }

  dimensionSelectEl.innerHTML = "";

  for (const dimensionName of dimensions) {
    const option = document.createElement("option");
    option.value = dimensionName;
    option.textContent = dimensionName;
    option.selected = dimensionName === dimension;
    dimensionSelectEl.append(option);
  }

  dimensionSelectEl.classList.toggle("hidden", dimensions.length <= 1);
}

async function loadCurrentMap(dimension = "") {
  const params = new URLSearchParams();
  if (dimension) {
    params.set("dimension", dimension);
  }

  const current = await getJson(`/api/map/current${params.toString() ? `?${params}` : ""}`);
  selectedDimension = current.dimension;
  updateDimensionSelect(current.dimensions || [], current.dimension);

  const mapBounds = addTiles(current.dimension, current.tiles);
  addStreetViewMarkers(current.streetViewNodes || []);
  map.fitBounds(mapBounds.pad(0.08));

  metaEl.textContent = [
    "mode=current",
    `dimension=${current.dimension}`,
    `scale=blocks`,
    `tiles=${current.tileCount}`,
    `panos=${(current.streetViewNodes || []).length}`,
    `snapshots=${current.sourceSnapshotCount}/${current.snapshotCount}`,
    `updated=${formatShortDateTime(current.updatedAt)}`
  ].join(" | ");
}

function closePanorama() {
  if (activePanorama) {
    activePanorama.dispose();
    activePanorama = null;
  }

  panoPanelEl?.classList.add("hidden");
}

function openPanorama(node) {
  if (!panoPanelEl || !panoViewEl) {
    return;
  }

  closePanorama();
  panoPanelEl.classList.remove("hidden");
  panoTitleEl.textContent = `x=${Math.round(node.x)} y=${Math.round(node.y)} z=${Math.round(node.z)}`;
  activePanorama = createPanoramaViewer(panoViewEl, panoramaImageSource(node), node);
}

function createPanoramaViewer(container, imageUrl, node) {
  container.innerHTML = "";

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1, 1, 1100);
  camera.rotation.order = "YXZ";

  const geometry = new THREE.SphereGeometry(500, 64, 32);
  geometry.scale(-1, 1, 1);
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const sphere = new THREE.Mesh(geometry, material);
  scene.add(sphere);

  const loader = new THREE.TextureLoader();
  loader.load(imageUrl, (texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    material.map = texture;
    material.needsUpdate = true;
  }, undefined, () => showError("Panorama image could not be loaded."));

  let yaw = THREE.MathUtils.degToRad(node.yaw || 0);
  let pitch = THREE.MathUtils.degToRad(node.pitch || 0);
  let isDragging = false;
  let lastX = 0;
  let lastY = 0;
  let frameId = 0;

  function resize() {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function render() {
    camera.rotation.y = yaw;
    camera.rotation.x = pitch;
    renderer.render(scene, camera);
    frameId = requestAnimationFrame(render);
  }

  function pointerDown(event) {
    isDragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    renderer.domElement.setPointerCapture(event.pointerId);
  }

  function pointerMove(event) {
    if (!isDragging) {
      return;
    }

    yaw -= (event.clientX - lastX) * 0.004;
    pitch -= (event.clientY - lastY) * 0.004;
    pitch = Math.max(-Math.PI / 2 + 0.02, Math.min(Math.PI / 2 - 0.02, pitch));
    lastX = event.clientX;
    lastY = event.clientY;
  }

  function pointerUp(event) {
    isDragging = false;
    renderer.domElement.releasePointerCapture(event.pointerId);
  }

  renderer.domElement.addEventListener("pointerdown", pointerDown);
  renderer.domElement.addEventListener("pointermove", pointerMove);
  renderer.domElement.addEventListener("pointerup", pointerUp);
  renderer.domElement.addEventListener("pointercancel", pointerUp);
  window.addEventListener("resize", resize);

  resize();
  render();

  return {
    dispose() {
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", resize);
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointermove", pointerMove);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      renderer.domElement.removeEventListener("pointercancel", pointerUp);
      geometry.dispose();
      material.map?.dispose();
      material.dispose();
      renderer.dispose();
      container.innerHTML = "";
    }
  };
}

function bindDimensionSelect() {
  if (!dimensionSelectEl) {
    return;
  }

  dimensionSelectEl.addEventListener("change", async () => {
    try {
      clearError();
      await loadCurrentMap(dimensionSelectEl.value);
    } catch (error) {
      showError(error.message);
    }
  });
}

async function uploadSnapshots(files) {
  const formData = new FormData();

  for (const file of files) {
    formData.append("files", file, file.webkitRelativePath || file.name);
  }

  const response = await fetch("/api/snapshot/upload", {
    method: "POST",
    body: formData
  });
  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Upload failed.");
  }

  return result;
}

function bindUploadControls() {
  if (!uploadInputEl || !uploadButtonEl) {
    return;
  }

  uploadButtonEl.addEventListener("click", () => {
    uploadInputEl.click();
  });

  uploadInputEl.addEventListener("change", async () => {
    const files = Array.from(uploadInputEl.files || []);
    if (files.length === 0) {
      return;
    }

    uploadButtonEl.disabled = true;
    setUploadStatus(`Uploading ${files.length} files...`);

    try {
      clearError();
      const result = await uploadSnapshots(files);
      const importedCount = result.imported?.length || 0;
      setUploadStatus(`Imported ${importedCount} snapshot${importedCount === 1 ? "" : "s"}.`);
      await loadCurrentMap(selectedDimension);
    } catch (error) {
      setUploadStatus("Upload failed.", true);
      showError(error.message);
    } finally {
      uploadButtonEl.disabled = false;
      uploadInputEl.value = "";
    }
  });
}

function bindPanoramaControls() {
  panoCloseEl?.addEventListener("click", closePanorama);
}

async function bootstrap() {
  try {
    clearError();
    bindHoverCoordinates();
    bindDimensionSelect();
    bindUploadControls();
    bindPanoramaControls();
    await loadCurrentMap();
  } catch (error) {
    showError(error.message);
    metaEl.textContent = "No map data found.";
  }
}

bootstrap();
