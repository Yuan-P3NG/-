/* =========================================================================
 * mathx.js —— 数学 + 几何工具
 *
 * 只放"和具体乐器无关"的东西：
 *   · 插值（PCHIP 单调三次 Hermite、稠密采样）
 *   · 噪声 / 伪随机（木纹、漆面颗粒）
 *   · 网格生成（沿折线的变径管、环带、带孔的板面、多边形内缩）
 *   · 弦的"动态管"：顶点一次分配，之后每帧只改写 position，不重建几何
 * ========================================================================= */
(function (global) {
  'use strict';

  const T = global.THREE;
  const MX = {};

  const TAU = Math.PI * 2;
  MX.TAU = TAU;
  MX.deg = function (d) { return (d * Math.PI) / 180; };
  MX.clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
  MX.lerp = function (a, b, t) { return a + (b - a) * t; };
  MX.invLerp = function (a, b, v) { return b === a ? 0 : (v - a) / (b - a); };
  MX.smoothstep = function (t) { t = MX.clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  MX.easeInOut = function (t) {
    t = MX.clamp(t, 0, 1);
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  };
  MX.damp = function (cur, target, lambda, dt) {
    return target + (cur - target) * Math.exp(-lambda * dt);
  };

  /* ---------------------------------------------------------------- 随机 */
  MX.hash01 = function (n) {
    n = (n << 13) ^ n;
    const m = (n * (n * n * 15731 + 789221) + 1376312589) & 0x7fffffff;
    return m / 0x7fffffff;
  };
  MX.prng = function (seed) {
    let s = (seed >>> 0) || 0x9e3779b9;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  };
  /** 平滑的一维值噪声：给木纹用 */
  MX.noise1 = function (seed) {
    return function (x) {
      const i = Math.floor(x), f = x - i;
      const s = f * f * (3 - 2 * f);
      const a = MX.hash01(i * 374761393 + seed * 668265263);
      const b = MX.hash01((i + 1) * 374761393 + seed * 668265263);
      return a + (b - a) * s;
    };
  };
  /** 分形一维噪声（木纹的细密纹理） */
  MX.fbm1 = function (seed, octaves, lac, gain) {
    octaves = octaves || 4; lac = lac || 2.03; gain = gain || 0.5;
    const layers = [];
    for (let i = 0; i < octaves; i++) layers.push(MX.noise1(seed + i * 131));
    return function (x) {
      let sum = 0, amp = 1, freq = 1, norm = 0;
      for (let i = 0; i < octaves; i++) {
        sum += layers[i](x * freq) * amp;
        norm += amp;
        amp *= gain; freq *= lac;
      }
      return sum / norm;
    };
  };

  /* -------------------------------------------------------------- 插值 */
  /**
   * 单调三次 Hermite（PCHIP / Fritsch–Carlson）。
   * 为什么不用余弦或分段 smoothstep：那些插值在每个控制点导数归零，
   * 一圈控制点就会在曲面上复制出一圈波浪。PCHIP 保单调、不越界、无平台。
   * @returns {(x:number)=>number}
   */
  MX.pchip = function (xs, ys) {
    const n = xs.length;
    if (n === 0) return function () { return 0; };
    if (n === 1) return function () { return ys[0]; };
    const h = new Array(n - 1), d = new Array(n - 1), m = new Array(n);
    for (let i = 0; i < n - 1; i++) {
      h[i] = xs[i + 1] - xs[i];
      d[i] = (ys[i + 1] - ys[i]) / h[i];
    }
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) {
      if (d[i - 1] * d[i] <= 0) {
        m[i] = 0;                                  // 极值点：按 Fritsch–Carlson 归零
      } else {
        const w1 = 2 * h[i] + h[i - 1];
        const w2 = h[i] + 2 * h[i - 1];
        m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
      }
    }
    return function (x) {
      if (x <= xs[0]) return ys[0] + m[0] * (x - xs[0]);
      if (x >= xs[n - 1]) return ys[n - 1] + m[n - 1] * (x - xs[n - 1]);
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (xs[mid] <= x) lo = mid; else hi = mid;
      }
      const t = (x - xs[lo]) / h[lo], t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      return h00 * ys[lo] + h10 * h[lo] * m[lo] + h01 * ys[lo + 1] + h11 * h[lo] * m[lo + 1];
    };
  };
  /** 把 (xs, ys) 用 PCHIP 密采样成 [x, y] 数组 */
  MX.pchipSamples = function (xs, ys, count) {
    const f = MX.pchip(xs, ys);
    const out = [];
    const x0 = xs[0], x1 = xs[xs.length - 1];
    for (let i = 0; i < count; i++) {
      const x = x0 + ((x1 - x0) * i) / (count - 1);
      out.push([x, f(x)]);
    }
    return out;
  };

  /* --------------------------------------------------- 多边形工具 (2D) */
  MX.polyArea = function (pts) {
    let a = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  };
  /** 保证逆时针（CCW） */
  MX.polyCCW = function (pts) { return MX.polyArea(pts) < 0 ? pts.slice().reverse() : pts; };
  MX.polyCentroid = function (pts) {
    let x = 0, y = 0;
    for (const p of pts) { x += p[0]; y += p[1]; }
    return [x / pts.length, y / pts.length];
  };
  /**
   * 多边形内缩（沿顶点角平分线，斜接长度做钳制）。
   * 用来做侧板（比面板轮廓小 2.4%）和镶线。
   */
  MX.polyInset = function (pts, dist) {
    const n = pts.length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const p = pts[i], a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
      const e1 = [p[0] - a[0], p[1] - a[1]];
      const e2 = [b[0] - p[0], b[1] - p[1]];
      const l1 = Math.hypot(e1[0], e1[1]) || 1e-6, l2 = Math.hypot(e2[0], e2[1]) || 1e-6;
      const n1 = [-e1[1] / l1, e1[0] / l1];        // CCW 环的内法线在左侧
      const n2 = [-e2[1] / l2, e2[0] / l2];
      let mx = n1[0] + n2[0], my = n1[1] + n2[1];
      const ml = Math.hypot(mx, my) || 1e-6;
      mx /= ml; my /= ml;
      const cos = MX.clamp(n1[0] * mx + n1[1] * my, 0.2, 1);
      const miter = MX.clamp(dist / cos, dist, dist * 3.2);   // 尖角处限斜接
      out.push([p[0] + mx * miter, p[1] + my * miter]);
    }
    return out;
  };
  /** 点到闭合多边形的最短距离（正 = 在内部） */
  MX.polySignedDist = function (pts, x, y) {
    let best = Infinity, inside = false;
    for (let i = 0, n = pts.length; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const l2 = ex * ex + ey * ey || 1e-9;
      let t = ((x - a[0]) * ex + (y - a[1]) * ey) / l2;
      t = MX.clamp(t, 0, 1);
      const dx = x - (a[0] + ex * t), dy = y - (a[1] + ey * t);
      best = Math.min(best, Math.hypot(dx, dy));
      if ((a[1] > y) !== (b[1] > y)) {
        const xx = a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
        if (xx > x) inside = !inside;
      }
    }
    return inside ? best : -best;
  };

  /**
   * 从中心原点沿各方向到轮廓的距离表（角度分箱）。
   * 板面"同心环"参数化就靠它：ringS(x,z) = r / R(θ)。
   */
  MX.radialTable = function (pts, bins) {
    bins = bins || 720;
    const table = new Float32Array(bins);
    for (let b = 0; b < bins; b++) {
      const th = (b / bins) * TAU - Math.PI;
      const dx = Math.cos(th), dy = Math.sin(th);
      let best = 0;
      for (let i = 0, n = pts.length; i < n; i++) {
        const a = pts[i], c = pts[(i + 1) % n];
        const ex = c[0] - a[0], ey = c[1] - a[1];
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-12) continue;
        const t = (a[0] * ey - a[1] * ex) / den;
        const u = (a[0] * dy - a[1] * dx) / den;
        if (t > 0 && u >= 0 && u <= 1 && t > best) best = t;
      }
      table[b] = best;
    }
    return {
      bins: bins,
      /** 某方向的轮廓半径 */
      radiusAt: function (x, z) {
        let raw = ((Math.atan2(z, x) + Math.PI) / TAU) * bins;
        raw = ((raw % bins) + bins) % bins;
        const i0 = Math.floor(raw), i1 = (i0 + 1) % bins, f = raw - i0;
        return table[i0] + (table[i1] - table[i0]) * f;
      },
      /** 归一化环参数：0 = 中心，1 = 轮廓 */
      s: function (x, z) {
        const r = Math.hypot(x, z);
        const R = this.radiusAt(x, z);
        return R > 1e-6 ? r / R : 0;
      }
    };
  };

  /* ------------------------------------------------------------ 网格生成 */
  /**
   * 由"环"数组生成四边形网格。
   * rings: [ [ [x,y,z], ... ], ... ]，每个环的点数必须一致。
   */
  MX.meshFromRings = function (rings, opts) {
    opts = opts || {};
    const closedRing = opts.closedRing !== false;
    const nR = rings.length, nP = rings[0].length;
    const pos = [], uv = [], idx = [];
    for (let r = 0; r < nR; r++) {
      for (let p = 0; p < nP; p++) {
        const v = rings[r][p];
        pos.push(v[0], v[1], v[2]);
        uv.push(r / Math.max(1, nR - 1), p / nP);
      }
    }
    const span = closedRing ? nP : nP - 1;
    for (let r = 0; r < nR - 1; r++) {
      for (let p = 0; p < span; p++) {
        const p1 = (p + 1) % nP;
        const a = r * nP + p, b = r * nP + p1, c = (r + 1) * nP + p1, d = (r + 1) * nP + p;
        idx.push(a, d, c, a, c, b);
      }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  };

  /** 由参数曲面 (u,v)=>[x,y,z] 建网格 */
  MX.meshFromParam = function (fn, nU, nV, opts) {
    const rings = [];
    for (let i = 0; i < nU; i++) {
      const u = i / (nU - 1);
      const ring = [];
      for (let j = 0; j < nV; j++) ring.push(fn(u, j / (nV - 1)));
      rings.push(ring);
    }
    return MX.meshFromRings(rings, opts);
  };

  /**
   * 动态变径管：顶点一次分配，之后 setPath() 只改写 position。
   * 琴弦每帧都要振动 / 按弦 / 装弦，不能每帧重建几何。
   */
  MX.dynTube = function (nPts, radial, material) {
    const geo = new T.BufferGeometry();
    const pos = new Float32Array(nPts * radial * 3);
    const idx = [];
    for (let i = 0; i < nPts - 1; i++) {
      for (let j = 0; j < radial; j++) {
        const j1 = (j + 1) % radial;
        const a = i * radial + j, b = i * radial + j1;
        const c = (i + 1) * radial + j, d = (i + 1) * radial + j1;
        idx.push(a, c, d, a, d, b);
      }
    }
    geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const mesh = new T.Mesh(geo, material);
    mesh.frustumCulled = false;
    const T1 = new T.Vector3(), N1 = new T.Vector3(), B1 = new T.Vector3();
    const up = new T.Vector3(0, 1, 0);
    const tmp = new T.Vector3();
    /**
     * @param path 中心线点（THREE.Vector3 或 [x,y,z]）
     * @param radiusOf 半径：数字或 (i, t) => number
     * @param hint 侧向参考（默认 +Y；沿 Y 走的弦要传 +X）
     */
    mesh.setPath = function (path, radiusOf, hint) {
      const n = Math.min(nPts, path.length);
      const rad = typeof radiusOf === 'function' ? radiusOf : function () { return radiusOf; };
      const h = hint || up;
      for (let i = 0; i < n; i++) {
        const p = path[i];
        const hasXYZ = p.x !== undefined;
        const px = hasXYZ ? p.x : p[0], py = hasXYZ ? p.y : p[1], pz = hasXYZ ? p.z : p[2];
        const q = path[Math.min(n - 1, i + 1)], o = path[Math.max(0, i - 1)];
        const qx = q.x !== undefined ? q.x : q[0], qy = q.x !== undefined ? q.y : q[1], qz = q.x !== undefined ? q.z : q[2];
        const ox = o.x !== undefined ? o.x : o[0], oy = o.x !== undefined ? o.y : o[1], oz = o.x !== undefined ? o.z : o[2];
        T1.set(qx - ox, qy - oy, qz - oz);
        if (T1.lengthSq() < 1e-12) T1.set(0, 1, 0);
        T1.normalize();
        N1.copy(h).cross(T1);
        if (N1.lengthSq() < 1e-9) {
          tmp.set(1, 0, 0).cross(T1);
          N1.copy(tmp);
        }
        N1.normalize();
        B1.copy(T1).cross(N1).normalize();
        const r = rad(i, n > 1 ? i / (n - 1) : 0);
        for (let j = 0; j < radial; j++) {
          const a = (j / radial) * TAU;
          const ca = Math.cos(a) * r, sa = Math.sin(a) * r;
          const o3 = (i * radial + j) * 3;
          pos[o3] = px + N1.x * ca + B1.x * sa;
          pos[o3 + 1] = py + N1.y * ca + B1.y * sa;
          pos[o3 + 2] = pz + N1.z * ca + B1.z * sa;
        }
      }
      geo.setDrawRange(0, Math.max(0, (n - 1) * radial * 6));
      geo.attributes.position.needsUpdate = true;
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
    };
    return mesh;
  };

  /**
   * 板面（面板/背板）：轮廓 + 挖孔，再用"轮廓缩放环"的高度函数塑形。
   *
   * 做法：THREE.ShapeGeometry（内部走 Earcut，天生支持孔洞）
   *      → 中点细分若干级 → 每个顶点 y = height(x,z)。
   * 高度永远取自同一个解析曲面，所以板面处处光滑；
   * 之后所有贴面配件（指板、琴马、f 孔…）用同一个 height 算高度就一定落在面上。
   *
   * @param outline 二维轮廓（CCW，[x,z] 数组）
   * @param holes   孔洞轮廓数组
   * @param height  (x, z) => y
   */
  MX.plateMesh = function (outline, holes, height, opts) {
    opts = opts || {};
    const subdiv = opts.subdiv === undefined ? 2 : opts.subdiv;
    const flip = !!opts.flip;
    const shape = new T.Shape();
    outline.forEach(function (p, i) {
      if (i === 0) shape.moveTo(p[0], p[1]); else shape.lineTo(p[0], p[1]);
    });
    shape.closePath();
    (holes || []).forEach(function (h) {
      const path = new T.Path();
      h.forEach(function (p, i) {
        if (i === 0) path.moveTo(p[0], p[1]); else path.lineTo(p[0], p[1]);
      });
      path.closePath();
      shape.holes.push(path);
    });
    const g0 = new T.ShapeGeometry(shape);
    // ShapeGeometry 的顶点全在边界上（外轮廓或孔边）
    const P = [];                                  // [x, z]
    const pa = g0.attributes.position;
    for (let i = 0; i < pa.count; i++) P.push([pa.getX(i), pa.getY(i)]);
    let I = Array.prototype.slice.call(g0.index.array);
    for (let lv = 0; lv < subdiv; lv++) {
      const mid = new Map();
      const out = [];
      const edgeMid = function (a, b) {
        const k = a < b ? a * 1e7 + b : b * 1e7 + a;
        let m = mid.get(k);
        if (m === undefined) {
          P.push([(P[a][0] + P[b][0]) / 2, (P[a][1] + P[b][1]) / 2]);
          m = P.length - 1;
          mid.set(k, m);
        }
        return m;
      };
      for (let t = 0; t < I.length; t += 3) {
        const a = I[t], b = I[t + 1], c = I[t + 2];
        const ab = edgeMid(a, b), bc = edgeMid(b, c), ca = edgeMid(c, a);
        out.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
      }
      I = out;
    }
    const pos = new Float32Array(P.length * 3);
    const uv = new Float32Array(P.length * 2);
    const su = opts.uvScale ? opts.uvScale[0] : 0.004;
    const sv = opts.uvScale ? opts.uvScale[1] : 0.004;
    for (let i = 0; i < P.length; i++) {
      const x = P[i][0], z = P[i][1];
      const y = height(x, z) * (flip ? -1 : 1);
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      uv[i * 2] = x * su; uv[i * 2 + 1] = z * sv;
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    g.setAttribute('uv', new T.BufferAttribute(uv, 2));
    g.setIndex(I);
    g.computeVertexNormals();
    g0.dispose();
    return g;
  };

  /**
   * 一圈带子：外环与内环之间连成四边形（侧板 / 镶线 / 板边都能用）。
   * yOuter / yInner 可以是数字，也可以是 (x,z)=>y。
   */
  MX.ribbonBetween = function (outer, inner, yOuter, yInner, flipWinding) {
    const n = Math.min(outer.length, inner.length);
    const yo = typeof yOuter === 'function' ? yOuter : function () { return yOuter; };
    const yi = typeof yInner === 'function' ? yInner : function () { return yInner; };
    const rings = [[], []];
    for (let i = 0; i < n; i++) {
      const a = outer[i], b = inner[i];
      rings[0].push([a[0], yo(a[0], a[1]), a[1]]);
      rings[1].push([b[0], yi(b[0], b[1]), b[1]]);
    }
    if (flipWinding) rings.reverse();
    return MX.meshFromRings(rings, { closedRing: true });
  };

  /** 竖直边墙：把轮廓从 y0 拉到 y1（板边厚度、f 孔内壁） */
  MX.wallBetween = function (pts, yFn0, yFn1, closed, flipWinding) {
    const n = pts.length;
    const y0 = typeof yFn0 === 'function' ? yFn0 : function () { return yFn0; };
    const y1 = typeof yFn1 === 'function' ? yFn1 : function () { return yFn1; };
    const rings = [[], []];
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      rings[0].push([p[0], y0(p[0], p[1]), p[1]]);
      rings[1].push([p[0], y1(p[0], p[1]), p[1]]);
    }
    if (flipWinding) rings.reverse();
    return MX.meshFromRings(rings, { closedRing: closed !== false });
  };

  /** 椭圆轮廓 */
  MX.ellipsePts = function (cx, cz, rx, rz, n, phase) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + (phase || 0);
      out.push([cx + Math.cos(a) * rx, cz + Math.sin(a) * rz]);
    }
    return out;
  };

  /** 材质缓存：同名材质只建一次，减少着色器编译与显存开销 */
  MX.matCache = {};
  MX.mat = function (key, make) {
    if (!MX.matCache[key]) MX.matCache[key] = make();
    return MX.matCache[key];
  };

  global.MX = MX;
  if (typeof module !== 'undefined' && module.exports) module.exports = MX;
})(typeof window !== 'undefined' ? window : globalThis);
