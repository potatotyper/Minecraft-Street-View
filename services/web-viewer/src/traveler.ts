export const CLUSTER_RADIUS_BLOCKS = 2;
export const HORIZONTAL_NAV_RADIUS_BLOCKS = 50;
export const MIN_HOTSPOT_SEPARATION_DEGREES = 30;
export const MAX_HORIZONTAL_HOTSPOTS = 4;

export interface RawStreetViewNode {
  worldId?: string;
  snapshotId: string;
  nodeId: string;
  dimension: string;
  x: number;
  y: number;
  z: number;
  blockX?: number;
  blockY?: number;
  blockZ?: number;
  yaw?: number;
  pitch?: number;
  projection?: string;
  width?: number;
  height?: number;
  format?: string;
  includesEntities?: boolean;
  panoramaPath: string;
  thumbnailPath?: string;
  createdAt?: string;
}

export interface HorizontalTarget {
  node: StreetViewNode;
  cluster: NodeCluster;
  bearingDegrees: number;
  distanceBlocks: number;
}

export interface VerticalTargets {
  up: StreetViewNode | null;
  down: StreetViewNode | null;
}

interface ParsedBlockCoordinates {
  blockX: number;
  blockY: number;
  blockZ: number;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseNodeIdCoordinates(nodeId: string): ParsedBlockCoordinates | null {
  const match = /^node_(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)$/.exec(nodeId);
  if (!match) {
    return null;
  }

  return {
    blockX: Math.floor(Number(match[1])),
    blockY: Math.floor(Number(match[2])),
    blockZ: Math.floor(Number(match[3]))
  };
}

export function normalizeBlockCoordinates(raw: Pick<RawStreetViewNode, "nodeId" | "x" | "y" | "z" | "blockX" | "blockY" | "blockZ">): ParsedBlockCoordinates {
  if (finiteNumber(raw.blockX) && finiteNumber(raw.blockY) && finiteNumber(raw.blockZ)) {
    return {
      blockX: Math.floor(raw.blockX),
      blockY: Math.floor(raw.blockY),
      blockZ: Math.floor(raw.blockZ)
    };
  }

  const parsed = parseNodeIdCoordinates(raw.nodeId);
  if (parsed) {
    return parsed;
  }

  return {
    blockX: Math.floor(raw.x),
    blockY: Math.floor(raw.y),
    blockZ: Math.floor(raw.z)
  };
}

function parseCreatedTime(value?: string): number {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class StreetViewNode {
  readonly worldId: string;
  readonly snapshotId: string;
  readonly nodeId: string;
  readonly dimension: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly blockX: number;
  readonly blockY: number;
  readonly blockZ: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly projection: string;
  readonly width: number;
  readonly height: number;
  readonly format: string;
  readonly includesEntities: boolean;
  readonly panoramaPath: string;
  readonly thumbnailPath: string;
  readonly createdAt: string;
  readonly createdTimeMs: number;

  constructor(raw: RawStreetViewNode) {
    const block = normalizeBlockCoordinates(raw);

    this.worldId = raw.worldId ?? "";
    this.snapshotId = raw.snapshotId;
    this.nodeId = raw.nodeId;
    this.dimension = raw.dimension;
    this.x = raw.x;
    this.y = raw.y;
    this.z = raw.z;
    this.blockX = block.blockX;
    this.blockY = block.blockY;
    this.blockZ = block.blockZ;
    this.yaw = raw.yaw ?? 0;
    this.pitch = raw.pitch ?? 0;
    this.projection = raw.projection ?? "equirectangular";
    this.width = raw.width ?? 4096;
    this.height = raw.height ?? 2048;
    this.format = raw.format ?? "jpeg";
    this.includesEntities = Boolean(raw.includesEntities);
    this.panoramaPath = raw.panoramaPath;
    this.thumbnailPath = raw.thumbnailPath ?? "";
    this.createdAt = raw.createdAt ?? "";
    this.createdTimeMs = parseCreatedTime(raw.createdAt);
  }

  get key(): string {
    return `${this.snapshotId}:${this.nodeId}`;
  }

  distance3dTo(other: StreetViewNode): number {
    const dx = this.blockX - other.blockX;
    const dy = this.blockY - other.blockY;
    const dz = this.blockZ - other.blockZ;
    return Math.sqrt((dx * dx) + (dy * dy) + (dz * dz));
  }

  horizontalDistanceTo(other: StreetViewNode): number {
    return horizontalDistance(this, other);
  }

  bearingTo(other: StreetViewNode): number {
    return bearingDegrees(this, other);
  }

  panoramaUrl(): string {
    const params = new URLSearchParams({
      snapshot: this.snapshotId,
      path: this.panoramaPath
    });
    if (this.worldId) {
      params.set("world", this.worldId);
    }
    return `/api/panorama?${params}`;
  }
}

export class NodeCluster {
  readonly id: string;
  readonly nodes: StreetViewNode[];

  constructor(id: string, nodes: StreetViewNode[]) {
    this.id = id;
    this.nodes = [...nodes].sort(compareNodesStable);
  }

  get representative(): StreetViewNode {
    return [...this.nodes].sort(compareMapRepresentatives)[0];
  }

  contains(node: StreetViewNode): boolean {
    return this.nodes.some((candidate) => candidate.key === node.key);
  }

  horizontalDistanceTo(node: StreetViewNode): number {
    return Math.min(...this.nodes.map((candidate) => candidate.horizontalDistanceTo(node)));
  }

  closestNodeToY(blockY: number): StreetViewNode {
    return [...this.nodes].sort((a, b) =>
      Math.abs(a.blockY - blockY) - Math.abs(b.blockY - blockY) ||
      b.createdTimeMs - a.createdTimeMs ||
      a.key.localeCompare(b.key)
    )[0];
  }

  nearestHigherThan(node: StreetViewNode): StreetViewNode | null {
    return this.nodes
      .filter((candidate) => candidate.blockY > node.blockY)
      .sort((a, b) =>
        a.blockY - b.blockY ||
        b.createdTimeMs - a.createdTimeMs ||
        a.key.localeCompare(b.key)
      )[0] ?? null;
  }

  nearestLowerThan(node: StreetViewNode): StreetViewNode | null {
    return this.nodes
      .filter((candidate) => candidate.blockY < node.blockY)
      .sort((a, b) =>
        b.blockY - a.blockY ||
        b.createdTimeMs - a.createdTimeMs ||
        a.key.localeCompare(b.key)
      )[0] ?? null;
  }
}

export class StreetViewGraph {
  readonly nodes: StreetViewNode[];
  readonly clusters: NodeCluster[];
  private readonly clusterByNodeKey = new Map<string, NodeCluster>();

  constructor(nodes: StreetViewNode[]) {
    this.nodes = [...nodes].sort(compareNodesStable);
    this.clusters = buildNodeClusters(this.nodes);

    for (const cluster of this.clusters) {
      for (const node of cluster.nodes) {
        this.clusterByNodeKey.set(node.key, cluster);
      }
    }
  }

  clusterFor(node: StreetViewNode): NodeCluster | null {
    return this.clusterByNodeKey.get(node.key) ?? null;
  }

  mapRepresentatives(): StreetViewNode[] {
    return this.clusters
      .map((cluster) => cluster.representative)
      .sort((a, b) => (a.blockZ - b.blockZ) || (a.blockX - b.blockX) || a.key.localeCompare(b.key));
  }

  verticalTargetsFor(node: StreetViewNode): VerticalTargets {
    const cluster = this.clusterFor(node);
    return {
      up: cluster?.nearestHigherThan(node) ?? null,
      down: cluster?.nearestLowerThan(node) ?? null
    };
  }

  horizontalTargetsFor(node: StreetViewNode): HorizontalTarget[] {
    const currentCluster = this.clusterFor(node);
    const candidates: HorizontalTarget[] = [];

    for (const cluster of this.clusters) {
      if (cluster === currentCluster) {
        continue;
      }

      const targetNode = cluster.closestNodeToY(node.blockY);
      const distanceBlocks = node.horizontalDistanceTo(targetNode);
      if (distanceBlocks > HORIZONTAL_NAV_RADIUS_BLOCKS) {
        continue;
      }

      candidates.push({
        node: targetNode,
        cluster,
        bearingDegrees: node.bearingTo(targetNode),
        distanceBlocks
      });
    }

    candidates.sort((a, b) =>
      a.distanceBlocks - b.distanceBlocks ||
      Math.abs(a.node.blockY - node.blockY) - Math.abs(b.node.blockY - node.blockY) ||
      a.node.key.localeCompare(b.node.key)
    );

    const selected: HorizontalTarget[] = [];
    for (const candidate of candidates) {
      if (selected.every((existing) => angleDifferenceDegrees(existing.bearingDegrees, candidate.bearingDegrees) >= MIN_HOTSPOT_SEPARATION_DEGREES)) {
        selected.push(candidate);
      }

      if (selected.length >= MAX_HORIZONTAL_HOTSPOTS) {
        break;
      }
    }

    return selected;
  }
}

export function buildNodeClusters(nodes: StreetViewNode[], radiusBlocks = CLUSTER_RADIUS_BLOCKS): NodeCluster[] {
  const parent = new Map<string, string>();

  for (const node of nodes) {
    parent.set(node.key, node.key);
  }

  function find(key: string): string {
    const parentKey = parent.get(key);
    if (!parentKey || parentKey === key) {
      return key;
    }

    const root = find(parentKey);
    parent.set(key, root);
    return root;
  }

  function union(a: string, b: string): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent.set(rootB, rootA);
    }
  }

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (horizontalDistance(nodes[i], nodes[j]) <= radiusBlocks) {
        union(nodes[i].key, nodes[j].key);
      }
    }
  }

  const grouped = new Map<string, StreetViewNode[]>();
  for (const node of nodes) {
    const root = find(node.key);
    const group = grouped.get(root) ?? [];
    group.push(node);
    grouped.set(root, group);
  }

  return Array.from(grouped.values())
    .map((group, index) => new NodeCluster(`cluster_${index}`, group))
    .sort((a, b) =>
      a.representative.blockZ - b.representative.blockZ ||
      a.representative.blockX - b.representative.blockX ||
      a.id.localeCompare(b.id)
    );
}

export function horizontalDistance(a: Pick<StreetViewNode, "blockX" | "blockZ">, b: Pick<StreetViewNode, "blockX" | "blockZ">): number {
  const dx = a.blockX - b.blockX;
  const dz = a.blockZ - b.blockZ;
  return Math.sqrt((dx * dx) + (dz * dz));
}

export function bearingDegrees(a: Pick<StreetViewNode, "blockX" | "blockZ">, b: Pick<StreetViewNode, "blockX" | "blockZ">): number {
  const dx = b.blockX - a.blockX;
  const dz = b.blockZ - a.blockZ;
  return normalizeDegrees((Math.atan2(dx, dz) * 180) / Math.PI);
}

export function angleDifferenceDegrees(a: number, b: number): number {
  const diff = Math.abs(normalizeDegrees(a) - normalizeDegrees(b));
  return Math.min(diff, 360 - diff);
}

function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

function compareMapRepresentatives(a: StreetViewNode, b: StreetViewNode): number {
  return b.blockY - a.blockY ||
    b.createdTimeMs - a.createdTimeMs ||
    a.key.localeCompare(b.key);
}

function compareNodesStable(a: StreetViewNode, b: StreetViewNode): number {
  return a.blockX - b.blockX ||
    a.blockY - b.blockY ||
    a.blockZ - b.blockZ ||
    b.createdTimeMs - a.createdTimeMs ||
    a.key.localeCompare(b.key);
}
