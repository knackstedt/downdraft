// ============================================================================
// threemf.ts — 3D Manufacturing Format (.3mf) parser
//
// 3MF is an OPC zip container: 3D/3dmodel.model holds XML with <object>
// resources (mesh vertices + triangles), <basematerials> colors, and a
// <build> list of items with optional 4×3 transforms. This parses the core
// mesh spec — slices, beam lattices, and production-extension items are
// skipped with warnings.
// ============================================================================

import { strFromU8, unzipSync } from "fflate";
import { assertCount, MAX_FACE_COUNT, MAX_VERTEX_COUNT } from "@downdraft/engine";
import type { MaterialData, MeshData, ModelData } from "./types";

function parseTransform(s: string): number[] | null {
  // 4×3 row-major: m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32
  const v = s.trim().split(/\s+/).map(Number);
  if (v.length !== 12 || v.some((x) => !Number.isFinite(x))) return null;
  return v;
}

function applyTransform(p: [number, number, number], t: number[]): [number, number, number] {
  const [x, y, z] = p;
  return [
    x * t[0] + y * t[3] + z * t[6] + t[9],
    x * t[1] + y * t[4] + z * t[7] + t[10],
    x * t[2] + y * t[5] + z * t[8] + t[11],
  ];
}

function parseColor(s: string): [number, number, number, number] {
  const h = s.replace("#", "");
  const n = parseInt(h.length === 6 ? h + "FF" : h, 16);
  return [((n >>> 24) & 255) / 255, ((n >>> 16) & 255) / 255, ((n >>> 8) & 255) / 255, (n & 255) / 255];
}

export function parse3MF(data: ArrayBuffer, name: string): ModelData {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(data));
  } catch {
    throw new Error("3MF: not a valid zip container");
  }
  const modelPath = Object.keys(files).find((k) => /(^|\/)3d\/[^/]*\.model$/i.test(k))
    ?? Object.keys(files).find((k) => /\.model$/i.test(k));
  if (!modelPath) throw new Error("3MF: no 3D/*.model part found");
  const xml = strFromU8(files[modelPath]);
  const warnings: string[] = [];

  // ── basematerials: <basematerials id="N"><base name=".." displaycolor="#RRGGBBAA"/></basematerials>
  const materials: MaterialData[] = [];
  const baseMatGroups = new Map<number, number[]>(); // basematerials id → material indices
  const bmRe = /<basematerials\s+id="(\d+)"[^>]*>([\s\S]*?)<\/basematerials>/gi;
  let bm: RegExpExecArray | null;
  while ((bm = bmRe.exec(xml))) {
    const gid = parseInt(bm[1], 10);
    const idxs: number[] = [];
    const baseRe = /<base\s+[^>]*displaycolor="([^"]+)"[^>]*\/>/gi;
    let b: RegExpExecArray | null;
    while ((b = baseRe.exec(bm[2]))) {
      idxs.push(materials.length);
      const nameM = /name="([^"]*)"/.exec(b[0]);
      materials.push({
        name: nameM?.[1] || `mat${materials.length}`,
        baseColor: parseColor(b[1]),
        metallic: 0,
        roughness: 0.9,
      });
    }
    baseMatGroups.set(gid, idxs);
  }

  // ── objects: <object id="N" ...><mesh><vertices>..</vertices><triangles>..</triangles></mesh></object>
  interface Obj { verts: number[][]; tris: { v: [number, number, number]; pid?: number; p1?: number; p2?: number; p3?: number }[]; pid?: number; pindex?: number }
  const objects = new Map<number, Obj>();
  const objRe = /<object\s+([^>]*)>([\s\S]*?)<\/object>/gi;
  let om: RegExpExecArray | null;
  while ((om = objRe.exec(xml))) {
    const attrs = om[1];
    const id = parseInt(/id="(\d+)"/.exec(attrs)?.[1] ?? "-1", 10);
    if (id < 0) continue;
    const type = /type="([^"]+)"/.exec(attrs)?.[1] ?? "model";
    if (type !== "model") { warnings.push(`object ${id} type "${type}" skipped`); continue; }
    const pid = /pid="(\d+)"/.exec(attrs)?.[1];
    const pindex = /pindex="(\d+)"/.exec(attrs)?.[1];
    const obj: Obj = { verts: [], tris: [], pid: pid ? parseInt(pid, 10) : undefined, pindex: pindex ? parseInt(pindex, 10) : undefined };

    const body = om[2];
    const vRe = /<vertex\s+([^>]*)\/>/gi;
    let vm: RegExpExecArray | null;
    while ((vm = vRe.exec(body))) {
      const a = vm[1];
      obj.verts.push([
        parseFloat(/x="([^"]+)"/.exec(a)?.[1] ?? "0"),
        parseFloat(/y="([^"]+)"/.exec(a)?.[1] ?? "0"),
        parseFloat(/z="([^"]+)"/.exec(a)?.[1] ?? "0"),
      ]);
    }
    const tRe = /<triangle\s+([^>]*)\/>/gi;
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(body))) {
      const a = tm[1];
      const num = (k: string) => { const m2 = new RegExp(`${k}="(\\d+)"`).exec(a); return m2 ? parseInt(m2[1], 10) : undefined; };
      obj.tris.push({
        v: [num("v1") ?? 0, num("v2") ?? 0, num("v3") ?? 0],
        pid: num("pid"), p1: num("p1"), p2: num("p2"), p3: num("p3"),
      });
    }
    objects.set(id, obj);
  }

  if (objects.size === 0) throw new Error("3MF: no model objects found");

  // ── build items (transforms); fall back to all objects when <build> is absent
  const items: { id: number; t: number[] | null }[] = [];
  const buildRe = /<item\s+([^>]*)\/>/gi;
  let im: RegExpExecArray | null;
  while ((im = buildRe.exec(xml))) {
    const a = im[1];
    const oid = parseInt(/objectid="(\d+)"/.exec(a)?.[1] ?? "-1", 10);
    const t = /transform="([^"]+)"/.exec(a)?.[1];
    if (oid >= 0 && objects.has(oid)) items.push({ id: oid, t: t ? parseTransform(t) : null });
  }
  if (items.length === 0) for (const id of objects.keys()) items.push({ id, t: null });

  // ── emit: one mesh per (item × material-group) — a triangle's pid picks the
  // basematerials group; per-vertex p1/p2/p3 index into it. We bake the common
  // case (uniform material per triangle) into materialIndex.
  const meshes: MeshData[] = [];
  const positions: number[] = [];

  items.forEach((item) => {
    const obj = objects.get(item.id)!;
    // Group triangles by resolved material index (-1 = none).
    const byMat = new Map<number, number[]>();
    const triMat = (t: Obj["tris"][number]): number => {
      const gid = t.pid ?? obj.pid;
      if (gid === undefined) return -1;
      const group = baseMatGroups.get(gid);
      if (!group || group.length === 0) return -1;
      const p = t.p1 ?? obj.pindex ?? 0;
      return group[Math.min(p, group.length - 1)] ?? -1;
    };
    obj.tris.forEach((t) => {
      const mi = triMat(t);
      let arr = byMat.get(mi);
      if (!arr) { arr = []; byMat.set(mi, arr); }
      arr.push(t.v[0], t.v[1], t.v[2]);
    });

    for (const [mi, triIdx] of byMat.entries()) {
      // Remap: local vertex list per material mesh.
      const local = new Map<number, number>();
      const indexArr: number[] = [];
      const startPos = positions.length / 3;
      triIdx.forEach((gv) => {
        let li = local.get(gv);
        if (li === undefined) {
          li = positions.length / 3 - startPos;
          const p = obj.verts[gv] ?? [0, 0, 0];
          const w = item.t ? applyTransform(p as [number, number, number], item.t) : p;
          positions.push(w[0], w[1], w[2]);
          local.set(gv, li);
        }
        indexArr.push(li);
      });
      const vCount = positions.length / 3 - startPos;
      if (vCount === 0 || indexArr.length === 0) continue;
      const verts = new Float32Array(vCount * 6);
      for (let v = 0; v < vCount; v++) {
        verts[v * 6] = positions[(startPos + v) * 3];
        verts[v * 6 + 1] = positions[(startPos + v) * 3 + 1];
        verts[v * 6 + 2] = positions[(startPos + v) * 3 + 2];
      }
      const mesh: MeshData = {
        vertices: verts,
        indices: indexArr.length > 65535 ? new Uint32Array(indexArr) : new Uint16Array(indexArr),
        vertexCount: vCount,
        indexCount: indexArr.length,
        uvs: null,
        colors: null,
      };
      if (mi >= 0) mesh.materialIndex = mi;
      meshes.push(mesh);
    }
  });

  if (meshes.length === 0) throw new Error("3MF: objects contain no triangles");
  const totalVerts = meshes.reduce((s, m) => s + m.vertexCount, 0);
  assertCount("3mf vertices", totalVerts, MAX_VERTEX_COUNT);
  assertCount("3mf triangles", meshes.reduce((s, m) => s + m.indexCount / 3, 0), MAX_FACE_COUNT);

  const model: ModelData = {
    meshes,
    name,
    format: "3mf",
    materials: materials.length > 0 ? materials : undefined,
  };
  if (warnings.length > 0) model.warnings = warnings;
  return model;
}
