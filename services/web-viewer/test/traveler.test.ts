import assert from "node:assert/strict";
import test from "node:test";
import {
  StreetViewGraph,
  StreetViewNode,
  normalizeBlockCoordinates
} from "../src/traveler";

function node(id: string, blockX: number, blockY: number, blockZ: number, createdAt = "2026-05-04T00:00:00.000Z"): StreetViewNode {
  return new StreetViewNode({
    snapshotId: `snapshot_${id}`,
    nodeId: id,
    dimension: "minecraft_overworld",
    x: blockX + 0.5,
    y: blockY + 1.62,
    z: blockZ + 0.5,
    blockX,
    blockY,
    blockZ,
    yaw: 0,
    pitch: 0,
    panoramaPath: `panoramas/${id}/pano.jpg`,
    createdAt
  });
}

test("normalizes legacy block coordinates from node id before falling back to camera coordinates", () => {
  assert.deepEqual(normalizeBlockCoordinates({
    nodeId: "node_10_64.0_-20",
    x: 10.5,
    y: 65.62,
    z: -19.5
  }), {
    blockX: 10,
    blockY: 64,
    blockZ: -20
  });

  assert.deepEqual(normalizeBlockCoordinates({
    nodeId: "custom",
    x: 10.5,
    y: 65.62,
    z: -19.5
  }), {
    blockX: 10,
    blockY: 65,
    blockZ: -20
  });
});

test("clusters nearby X/Z nodes and chooses highest Y map representative", () => {
  const low = node("low", 0, 64, 0);
  const high = node("high", 1, 90, 1);
  const far = node("far", 10, 70, 0);
  const graph = new StreetViewGraph([low, high, far]);

  const representatives = graph.mapRepresentatives();
  assert.equal(representatives.length, 2);
  assert.ok(representatives.some((representative) => representative.key === high.key));
  assert.ok(representatives.some((representative) => representative.key === far.key));
  assert.ok(!representatives.some((representative) => representative.key === low.key));
});

test("vertical targets pick nearest higher and lower levels in the same cluster", () => {
  const lower = node("lower", 0, 60, 0);
  const current = node("current", 1, 70, 1);
  const upper = node("upper", 0, 80, 0);
  const top = node("top", 0, 120, 0);
  const graph = new StreetViewGraph([lower, current, upper, top]);

  const vertical = graph.verticalTargetsFor(current);
  assert.equal(vertical.down?.key, lower.key);
  assert.equal(vertical.up?.key, upper.key);
});

test("horizontal targets use closest Y node from each target cluster", () => {
  const current = node("current", 0, 70, 0);
  const targetLower = node("target_lower", 20, 60, 0);
  const targetClosest = node("target_closest", 20, 72, 1);
  const graph = new StreetViewGraph([current, targetLower, targetClosest]);

  const horizontal = graph.horizontalTargetsFor(current);
  assert.equal(horizontal.length, 1);
  assert.equal(horizontal[0].node.key, targetClosest.key);
});

test("horizontal targets are capped at four and separated by at least thirty degrees", () => {
  const current = node("current", 0, 64, 0);
  const graph = new StreetViewGraph([
    current,
    node("north", 0, 64, 20),
    node("north_close_angle", 5, 64, 20),
    node("east", 20, 64, 0),
    node("south", 0, 64, -20),
    node("west", -20, 64, 0),
    node("far_north", 0, 64, 45)
  ]);

  const horizontal = graph.horizontalTargetsFor(current);
  assert.equal(horizontal.length, 4);
  assert.deepEqual(horizontal.map((target) => target.node.nodeId).sort(), ["east", "north", "south", "west"]);
});
