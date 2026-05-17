import L from "leaflet";
import * as THREE from "three";
import {
  type HorizontalTarget,
  type RawStreetViewNode,
  StreetViewGraph,
  StreetViewNode
} from "./traveler";

const BLOCKS_PER_CHUNK = 16;
const STREETVIEW_MARKER_SIZE = 18;

interface ApiTile {
  snapshotId: string;
  x: number;
  z: number;
  centerX?: number;
  centerZ?: number;
  fileName?: string;
}

interface WorldDescriptor {
  id: string;
  name: string;
  description: string;
  serverAddress?: string;
  href: string;
}

interface CurrentMapResponse {
  world?: WorldDescriptor | null;
  dimension: string;
  dimensions: string[];
  tileCount: number;
  snapshotCount: number;
  sourceSnapshotCount: number;
  updatedAt: string | null;
  streetViewNodes: RawStreetViewNode[];
  tiles: ApiTile[];
}

interface UploadResponse {
  imported?: unknown[];
}

interface WorldSummary {
  id: string;
  name: string;
  description: string;
  serverAddress?: string;
  href: string;
  dimensions: string[];
  snapshotCount: number;
  tileCount: number;
  streetViewNodeCount: number;
  updatedAt: string | null;
  status: "ready" | "map-only" | "empty" | string;
}

interface WorldsResponse {
  worlds: WorldSummary[];
}

interface PanoramaDispose {
  dispose(): void;
}

const activeWorldId = worldIdFromPath();

const homeViewEl = requiredElement<HTMLElement>("home-view");
const viewerViewEl = requiredElement<HTMLElement>("viewer-view");
const worldListEl = requiredElement<HTMLElement>("world-list");
const worldCountEl = requiredElement<HTMLElement>("world-count");
const homeStatusEl = requiredElement<HTMLElement>("home-status");
const viewerTitleEl = requiredElement<HTMLElement>("viewer-title");
const viewerSubtitleEl = requiredElement<HTMLElement>("viewer-subtitle");
const metaEl = requiredElement<HTMLElement>("meta");
const errorEl = requiredElement<HTMLElement>("error");
const coordsEl = requiredElement<HTMLElement>("coords");
const uploadInputEl = requiredElement<HTMLInputElement>("snapshot-upload");
const uploadButtonEl = requiredElement<HTMLButtonElement>("upload-button");
const uploadStatusEl = requiredElement<HTMLElement>("upload-status");
const dimensionSelectEl = requiredElement<HTMLSelectElement>("dimension-select");
const panoPanelEl = requiredElement<HTMLElement>("pano-panel");
const panoViewEl = requiredElement<HTMLElement>("pano-view");
const panoTitleEl = requiredElement<HTMLElement>("pano-title");
const panoCloseEl = requiredElement<HTMLButtonElement>("pano-close");

let map: L.Map;
let tileLayer: L.LayerGroup;
let streetViewLayer: L.LayerGroup;
let selectedDimension = "";
let activePanorama: PanoramaViewer | null = null;
let streetViewGraph = new StreetViewGraph([]);

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element #${id}.`);
  }

  return element as T;
}

function worldIdFromPath(): string {
  const match = /^\/world\/([^/?#]+)/.exec(window.location.pathname);
  return match ? decodeURIComponent(match[1]) : "";
}

function scopedApiUrl(pathname: string, params = new URLSearchParams()): string {
  const scopedParams = new URLSearchParams(params);
  if (activeWorldId) {
    scopedParams.set("world", activeWorldId);
  }

  const query = scopedParams.toString();
  return `${pathname}${query ? `?${query}` : ""}`;
}

function showHome(): void {
  homeViewEl.hidden = false;
  viewerViewEl.hidden = true;
  document.body.classList.add("is-home");
  document.body.classList.remove("is-viewer");
}

function showViewer(): void {
  homeViewEl.hidden = true;
  viewerViewEl.hidden = false;
  document.body.classList.add("is-viewer");
  document.body.classList.remove("is-home");
}

function initializeMap(): void {
  map = L.map("map", {
    crs: L.CRS.Simple,
    minZoom: -6,
    maxZoom: 8,
    zoomSnap: 0.125,
    attributionControl: false
  });

  tileLayer = L.layerGroup().addTo(map);
  streetViewLayer = L.layerGroup().addTo(map);
  new BlockScaleControl({ imperial: false } as L.Control.ScaleOptions).addTo(map);
  window.requestAnimationFrame(() => map.invalidateSize());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBlockScale(blocks: number): string {
  const value = Number.isInteger(blocks)
    ? String(blocks)
    : blocks.toFixed(3).replace(/\.?0+$/, "");
  return `${value} ${blocks === 1 ? "block" : "blocks"}`;
}

function getRoundBlockScale(maxBlocks: number): number {
  if (maxBlocks >= 1) {
    return (L.Control.Scale.prototype as unknown as { _getRoundNum(value: number): number })._getRoundNum(maxBlocks);
  }

  return 2 ** Math.floor(Math.log2(maxBlocks));
}

const BlockScaleControl = L.Control.Scale.extend({
  _updateMetric(this: L.Control.Scale & { _mScale: HTMLElement; _updateScale(scale: HTMLElement, text: string, ratio: number): void }, maxBlocks: number) {
    if (!Number.isFinite(maxBlocks) || maxBlocks <= 0) {
      this._mScale.style.display = "none";
      return;
    }

    this._mScale.style.display = "";
    const blocks = getRoundBlockScale(maxBlocks);
    this._updateScale(this._mScale, formatBlockScale(blocks), blocks / maxBlocks);
  }
});

function showError(message: string): void {
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
}

function clearError(): void {
  errorEl.textContent = "";
  errorEl.classList.add("hidden");
}

function setUploadStatus(message: string, isError = false): void {
  uploadStatusEl.textContent = message;
  uploadStatusEl.classList.toggle("is-error", isError);
}

function formatShortDateTime(isoValue: string | null): string {
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

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const data = await response.json() as T & { error?: string };

  if (!response.ok) {
    throw new Error(data.error || `Request failed for ${url}`);
  }

  return data;
}

function safeCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatCount(value: number | undefined, singular: string, plural = `${singular}s`): string {
  const count = safeCount(value);
  const label = count === 1 ? singular : plural;
  return `${count.toLocaleString()} ${label}`;
}

function worldStatusLabel(world: WorldSummary): string {
  if (world.status === "ready") {
    return "Street View on";
  }

  if (world.status === "map-only") {
    return "Map only";
  }

  return "Waiting for snapshots";
}

function setViewerWorldSummary(world: WorldSummary): void {
  viewerTitleEl.textContent = world.name;
  viewerSubtitleEl.textContent = [
    world.serverAddress || world.description,
    formatCount(world.streetViewNodeCount, "panorama"),
    formatCount(world.snapshotCount, "snapshot")
  ].filter(Boolean).join(" | ");
  document.title = `${world.name} - Minecraft Street View`;
}

function createWorldStat(label: string, value: string): HTMLElement {
  const stat = document.createElement("span");
  const strong = document.createElement("strong");
  const text = document.createElement("span");
  strong.textContent = value;
  text.textContent = label;
  stat.append(strong, text);
  return stat;
}

function createWorldCard(world: WorldSummary): HTMLAnchorElement {
  const card = document.createElement("a");
  card.className = "world-card";
  card.href = world.href;

  const header = document.createElement("span");
  header.className = "world-card-header";

  const titleGroup = document.createElement("span");
  const eyebrow = document.createElement("span");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = worldStatusLabel(world);
  const title = document.createElement("strong");
  title.textContent = world.name;
  titleGroup.append(eyebrow, title);

  const action = document.createElement("span");
  action.className = "world-card-action";
  action.textContent = "Open viewer";
  header.append(titleGroup, action);

  const description = document.createElement("span");
  description.className = "world-card-description";
  description.textContent = world.description;

  const stats = document.createElement("span");
  stats.className = "world-card-stats";
  stats.append(
    createWorldStat("Panoramas", safeCount(world.streetViewNodeCount).toLocaleString()),
    createWorldStat("Snapshots", safeCount(world.snapshotCount).toLocaleString()),
    createWorldStat("Tiles", safeCount(world.tileCount).toLocaleString())
  );

  const footer = document.createElement("span");
  footer.className = "world-card-footer";
  const dimensions = document.createElement("span");
  dimensions.textContent = world.dimensions.length > 0
    ? world.dimensions.join(", ")
    : "No dimensions yet";
  const updated = document.createElement("span");
  updated.textContent = `Updated ${formatShortDateTime(world.updatedAt)}`;
  footer.append(dimensions, updated);

  card.append(header, description, stats, footer);
  return card;
}

function renderWorlds(worlds: WorldSummary[]): void {
  worldListEl.innerHTML = "";
  worldCountEl.textContent = formatCount(worlds.length, "world");

  if (worlds.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-worlds";
    empty.textContent = "No worlds have registered Street View yet.";
    worldListEl.append(empty);
    return;
  }

  for (const world of worlds) {
    worldListEl.append(createWorldCard(world));
  }
}

async function loadWorlds(): Promise<void> {
  homeStatusEl.textContent = "Loading worlds...";
  const { worlds } = await getJson<WorldsResponse>("/api/worlds");
  renderWorlds(worlds);
  homeStatusEl.textContent = worlds.length > 0
    ? "Choose a world to open its map and panoramas."
    : "Run the future init command from a server to add it here.";
}

async function loadViewerWorldSummary(): Promise<void> {
  const { worlds } = await getJson<WorldsResponse>("/api/worlds");
  const activeWorld = worlds.find((world) => world.id === activeWorldId);
  if (activeWorld) {
    setViewerWorldSummary(activeWorld);
  }
}

function tileBounds(tile: ApiTile): L.LatLngBounds {
  const west = tile.x * BLOCKS_PER_CHUNK;
  const east = west + BLOCKS_PER_CHUNK;
  const north = -(tile.z * BLOCKS_PER_CHUNK);
  const south = north - BLOCKS_PER_CHUNK;
  return L.latLngBounds(L.latLng(north, west), L.latLng(south, east));
}

function normalizeTile(tile: ApiTile): ApiTile {
  if (Number.isFinite(tile.centerX) && Number.isFinite(tile.centerZ)) {
    return {
      ...tile,
      x: Math.trunc(((tile.centerX ?? 0) - (BLOCKS_PER_CHUNK / 2)) / BLOCKS_PER_CHUNK),
      z: Math.trunc(((tile.centerZ ?? 0) - (BLOCKS_PER_CHUNK / 2)) / BLOCKS_PER_CHUNK)
    };
  }

  return tile;
}

function formatHoverCoordinates(latlng: L.LatLng): string {
  const blockX = Math.floor(latlng.lng);
  const blockZ = Math.floor(-latlng.lat);
  return `block x=${blockX} z=${blockZ}`;
}

function bindHoverCoordinates(): void {
  map.on("mousemove", (event: L.LeafletMouseEvent) => {
    coordsEl.textContent = formatHoverCoordinates(event.latlng);
  });

  map.on("mouseout", () => {
    coordsEl.textContent = "Hover map to inspect block coordinates";
  });
}

function tileImageSource(tile: ApiTile, dimension: string): string {
  const snapshotId = tile.snapshotId;
  const params = new URLSearchParams({
    snapshot: snapshotId,
    dimension
  });

  if (tile.fileName) {
    params.set("file", tile.fileName);
    return scopedApiUrl("/api/tile", params);
  }

  params.set("x", String(tile.x));
  params.set("z", String(tile.z));
  return scopedApiUrl("/api/tile", params);
}

function addTiles(dimension: string, tiles: ApiTile[]): L.LatLngBounds {
  tileLayer.clearLayers();

  const bounds: L.LatLngBounds[] = [];
  const normalizedTiles = tiles
    .map(normalizeTile)
    .sort((a, b) => (a.z - b.z) || (a.x - b.x));

  for (const tile of normalizedTiles) {
    const imageBounds = tileBounds(tile);
    bounds.push(imageBounds);

    L.imageOverlay(tileImageSource(tile, dimension), imageBounds, {
      interactive: false,
      opacity: 1
    }).addTo(tileLayer);
  }

  return L.latLngBounds(
    bounds.map((bound) => [bound.getNorth(), bound.getWest()] as L.LatLngTuple)
      .concat(bounds.map((bound) => [bound.getSouth(), bound.getEast()] as L.LatLngTuple))
  );
}

function streetViewLatLng(node: StreetViewNode): L.LatLng {
  return L.latLng(-node.blockZ, node.blockX);
}

function addStreetViewMarkers(nodes: RawStreetViewNode[]): void {
  streetViewGraph = new StreetViewGraph(nodes.map((node) => new StreetViewNode({
    ...node,
    worldId: activeWorldId || undefined
  })));
  renderStreetViewLayer();
}

function renderStreetViewLayer(): void {
  streetViewLayer.clearLayers();

  const nodes = streetViewGraph.mapRepresentatives();
  if (nodes.length === 0) {
    return;
  }

  const icon = L.divIcon({
    className: "streetview-marker",
    html: "<span></span>",
    iconSize: [STREETVIEW_MARKER_SIZE, STREETVIEW_MARKER_SIZE],
    iconAnchor: [STREETVIEW_MARKER_SIZE / 2, STREETVIEW_MARKER_SIZE / 2]
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

function updateDimensionSelect(dimensions: string[], dimension: string): void {
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

async function loadCurrentMap(dimension = ""): Promise<void> {
  const params = new URLSearchParams();
  if (dimension) {
    params.set("dimension", dimension);
  }

  const current = await getJson<CurrentMapResponse>(scopedApiUrl("/api/map/current", params));
  selectedDimension = current.dimension;
  updateDimensionSelect(current.dimensions || [], current.dimension);

  const mapBounds = addTiles(current.dimension, current.tiles);
  streetViewGraph = new StreetViewGraph([]);
  streetViewLayer.clearLayers();
  map.fitBounds(mapBounds.pad(0.08));
  addStreetViewMarkers(current.streetViewNodes || []);

  metaEl.textContent = [
    "mode=current",
    `dimension=${current.dimension}`,
    "scale=blocks",
    `tiles=${current.tileCount}`,
    `panos=${(current.streetViewNodes || []).length}`,
    `snapshots=${current.sourceSnapshotCount}/${current.snapshotCount}`,
    `updated=${formatShortDateTime(current.updatedAt)}`
  ].join(" | ");
}

function updatePanoramaTitle(node: StreetViewNode): void {
  panoTitleEl.textContent = `x=${node.blockX} y=${node.blockY} z=${node.blockZ}`;
}

function closePanorama(): void {
  activePanorama?.dispose();
  activePanorama = null;
  panoPanelEl.classList.add("hidden");
}

function openPanorama(node: StreetViewNode): void {
  panoPanelEl.classList.remove("hidden");

  if (activePanorama) {
    activePanorama.loadNode(node);
    return;
  }

  activePanorama = new PanoramaViewer(panoViewEl, streetViewGraph, node, {
    onNodeChange: updatePanoramaTitle,
    onError: showError
  });
}

class PanoramaViewer implements PanoramaDispose {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(75, 1, 1, 1100);
  private readonly geometry = new THREE.SphereGeometry(500, 64, 32);
  private readonly material = new THREE.MeshBasicMaterial({ color: 0xffffff });
  private readonly loader = new THREE.TextureLoader();
  private readonly overlay = document.createElement("div");
  private readonly horizontalHotspots: Array<{ target: HorizontalTarget; element: HTMLButtonElement }> = [];
  private readonly onNodeChange: (node: StreetViewNode) => void;
  private readonly onError: (message: string) => void;

  private currentNode: StreetViewNode;
  private yaw = 0;
  private pitch = 0;
  private isDragging = false;
  private lastX = 0;
  private lastY = 0;
  private frameId = 0;
  private disposed = false;
  private textureLoadId = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly graph: StreetViewGraph,
    initialNode: StreetViewNode,
    callbacks: {
      onNodeChange: (node: StreetViewNode) => void;
      onError: (message: string) => void;
    }
  ) {
    this.currentNode = initialNode;
    this.onNodeChange = callbacks.onNodeChange;
    this.onError = callbacks.onError;
    this.camera.rotation.order = "YXZ";
    this.geometry.scale(-1, 1, 1);
    this.scene.add(new THREE.Mesh(this.geometry, this.material));

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.overlay.className = "pano-hotspots";

    this.container.innerHTML = "";
    this.container.append(this.renderer.domElement, this.overlay);
    this.bindEvents();
    this.resize();
    this.loadNode(initialNode);
    this.render();
  }

  loadNode(node: StreetViewNode): void {
    this.currentNode = node;
    this.yaw = THREE.MathUtils.degToRad(node.yaw || 0);
    this.pitch = THREE.MathUtils.degToRad(node.pitch || 0);
    this.onNodeChange(node);
    this.loadTexture(node.panoramaUrl());
    this.renderHotspots();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    window.removeEventListener("resize", this.resize);
    this.renderer.domElement.removeEventListener("pointerdown", this.pointerDown);
    this.renderer.domElement.removeEventListener("pointermove", this.pointerMove);
    this.renderer.domElement.removeEventListener("pointerup", this.pointerUp);
    this.renderer.domElement.removeEventListener("pointercancel", this.pointerUp);
    this.geometry.dispose();
    this.material.map?.dispose();
    this.material.dispose();
    this.renderer.dispose();
    this.container.innerHTML = "";
  }

  private bindEvents(): void {
    this.renderer.domElement.addEventListener("pointerdown", this.pointerDown);
    this.renderer.domElement.addEventListener("pointermove", this.pointerMove);
    this.renderer.domElement.addEventListener("pointerup", this.pointerUp);
    this.renderer.domElement.addEventListener("pointercancel", this.pointerUp);
    window.addEventListener("resize", this.resize);
  }

  private loadTexture(imageUrl: string): void {
    const loadId = ++this.textureLoadId;
    this.loader.load(imageUrl, (texture) => {
      if (this.disposed || loadId !== this.textureLoadId) {
        texture.dispose();
        return;
      }

      this.material.map?.dispose();
      texture.colorSpace = THREE.SRGBColorSpace;
      this.material.map = texture;
      this.material.needsUpdate = true;
    }, undefined, () => this.onError("Panorama image could not be loaded."));
  }

  private renderHotspots(): void {
    this.overlay.innerHTML = "";
    this.horizontalHotspots.length = 0;

    const verticalTargets = this.graph.verticalTargetsFor(this.currentNode);
    if (verticalTargets.up) {
      this.overlay.append(this.createVerticalHotspot("Up", "up", verticalTargets.up));
    }
    if (verticalTargets.down) {
      this.overlay.append(this.createVerticalHotspot("Down", "down", verticalTargets.down));
    }

    for (const target of this.graph.horizontalTargetsFor(this.currentNode)) {
      const button = document.createElement("button");
      button.className = "pano-hotspot pano-hotspot-horizontal";
      button.type = "button";
      button.textContent = `${Math.round(target.distanceBlocks)}b`;
      button.setAttribute("aria-label", `Go to x ${target.node.blockX}, y ${target.node.blockY}, z ${target.node.blockZ}`);
      button.addEventListener("click", () => this.loadNode(target.node));
      this.overlay.append(button);
      this.horizontalHotspots.push({ target, element: button });
    }
  }

  private createVerticalHotspot(label: string, direction: "up" | "down", node: StreetViewNode): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = `pano-hotspot pano-hotspot-vertical pano-hotspot-${direction}`;
    button.type = "button";
    button.textContent = label;
    button.setAttribute("aria-label", `${label} to x ${node.blockX}, y ${node.blockY}, z ${node.blockZ}`);
    button.addEventListener("click", () => this.loadNode(node));
    return button;
  }

  private updateHorizontalHotspotPositions(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);

    for (const hotspot of this.horizontalHotspots) {
      const vector = directionVector(this.currentNode, hotspot.target.node);
      vector.project(this.camera);

      const visible = vector.z >= -1 && vector.z <= 1 && Math.abs(vector.x) <= 1.08 && Math.abs(vector.y) <= 1.08;
      hotspot.element.classList.toggle("is-hidden", !visible);
      if (!visible) {
        continue;
      }

      const x = ((vector.x + 1) / 2) * width;
      const y = ((-vector.y + 1) / 2) * height;
      hotspot.element.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    }
  }

  private readonly resize = (): void => {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  };

  private readonly render = (): void => {
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    this.renderer.render(this.scene, this.camera);
    this.updateHorizontalHotspotPositions();
    this.frameId = requestAnimationFrame(this.render);
  };

  private readonly pointerDown = (event: PointerEvent): void => {
    this.isDragging = true;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.renderer.domElement.setPointerCapture(event.pointerId);
  };

  private readonly pointerMove = (event: PointerEvent): void => {
    if (!this.isDragging) {
      return;
    }

    this.yaw -= (event.clientX - this.lastX) * 0.004;
    this.pitch -= (event.clientY - this.lastY) * 0.004;
    this.pitch = Math.max(-Math.PI / 2 + 0.02, Math.min(Math.PI / 2 - 0.02, this.pitch));
    this.lastX = event.clientX;
    this.lastY = event.clientY;
  };

  private readonly pointerUp = (event: PointerEvent): void => {
    this.isDragging = false;
    if (this.renderer.domElement.hasPointerCapture(event.pointerId)) {
      this.renderer.domElement.releasePointerCapture(event.pointerId);
    }
  };
}

function directionVector(from: StreetViewNode, to: StreetViewNode): THREE.Vector3 {
  const dx = to.blockX - from.blockX;
  const dz = to.blockZ - from.blockZ;
  const length = Math.max(1, Math.sqrt((dx * dx) + (dz * dz)));
  return new THREE.Vector3(dx / length, 0, dz / length).multiplyScalar(260);
}

function bindDimensionSelect(): void {
  dimensionSelectEl.addEventListener("change", async () => {
    try {
      clearError();
      closePanorama();
      await loadCurrentMap(dimensionSelectEl.value);
    } catch (error) {
      showError(errorMessage(error));
    }
  });
}

async function uploadSnapshots(files: File[]): Promise<UploadResponse> {
  const formData = new FormData();

  for (const file of files) {
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    formData.append("files", file, relativePath || file.name);
  }

  const response = await fetch(scopedApiUrl("/api/snapshot/upload"), {
    method: "POST",
    body: formData
  });
  const result = await response.json() as UploadResponse & { error?: string };

  if (!response.ok) {
    throw new Error(result.error || "Upload failed.");
  }

  return result;
}

function bindUploadControls(): void {
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
      closePanorama();
      await loadCurrentMap(selectedDimension);
    } catch (error) {
      setUploadStatus("Upload failed.", true);
      showError(errorMessage(error));
    } finally {
      uploadButtonEl.disabled = false;
      uploadInputEl.value = "";
    }
  });
}

function bindPanoramaControls(): void {
  panoCloseEl.addEventListener("click", closePanorama);
}

function bindStreetViewZoomRendering(): void {
  map.on("zoomend", renderStreetViewLayer);
  map.on("viewreset", renderStreetViewLayer);
}

async function bootstrap(): Promise<void> {
  if (!activeWorldId) {
    showHome();
    try {
      await loadWorlds();
    } catch (error) {
      homeStatusEl.textContent = errorMessage(error);
    }
    return;
  }

  showViewer();
  initializeMap();
  viewerTitleEl.textContent = activeWorldId;
  viewerSubtitleEl.textContent = "Loading world...";

  try {
    clearError();
    bindHoverCoordinates();
    bindDimensionSelect();
    bindUploadControls();
    bindPanoramaControls();
    bindStreetViewZoomRendering();
    await loadViewerWorldSummary();
    await loadCurrentMap();
  } catch (error) {
    showError(errorMessage(error));
    metaEl.textContent = "No map data found.";
  }
}

void bootstrap();
