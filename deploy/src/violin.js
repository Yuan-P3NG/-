/* =========================================================================
 * violin.js —— 提琴（小提琴 / 中提琴 / 大提琴）
 *
 * 建模按 Stradivari 琴型走实琴比例：
 *   小提琴 上弯 167 / 腰 108 / 下弯 208 / 全长 356 / 琴颈 130 / 指板 270 / 弦长 328
 *   中提琴、大提琴同源，腰宽比、侧板高度、弦粗各按自己的实琴改。
 *
 * 三个"必须做对"的点（旧版就烂在这里）：
 *   1) 轮廓：30+ 控制点 + PCHIP 单调三次插值密采样。不用余弦 / 分段 smoothstep，
 *      那些插值在控制点处导数归零，一环一环复制出去就是板面的"波浪"。
 *   2) 拱面：一条解析曲线（主拱 + 边缘凹槽），处处光滑；板上所有配件的高度
 *      全部走同一个函数 plateY(x,z)，所以不悬空、不冒黑边、不穿模。
 *   3) 弦全链路：系弦板 → 琴马 → 弦枕 → 弦轴箱 → 在对应弦钮杆上缠两圈，
 *      一段不断；琴马到弦枕收拢（11mm → 5.5mm）。
 *
 * 坐标约定（乐器局部坐标，单位 mm）：
 *   x = 横向，y = 面板法线（上），z = 长度方向（-L/2 琴尾 → +L/2 琴颈端）
 *   原点 = 琴身中心，y = 0 = 面板边缘平面。
 * ========================================================================= */
(function (global) {
  'use strict';

  const T = global.THREE;
  const MX = global.MX;
  const VIO = {};

  /* =====================================================================
   * 轮廓控制点：[u（0 = 琴尾 → 1 = 琴颈端）, 参考宽度, 系数]
   * 参考宽度 LB = 下弯 / MB = 腰 / UB = 上弯，系数相对该处半宽。
   * 上下两个 C 形收腰和微探出的琴角就是这样来的：琴角处前后两段的斜率
   * 差得很大，PCHIP 会做出一个紧凑的转折（角），不会把整条边磨成圆槽。
   * =================================================================== */
  const OUTLINE_CTRL = [
    [0.0000, 'LB', 0.000],
    [0.0170, 'LB', 0.269],
    [0.0450, 'LB', 0.529],
    [0.0840, 'LB', 0.750],
    [0.1400, 'LB', 0.895],
    [0.1970, 'LB', 0.971],
    [0.2470, 'LB', 1.000],   // 下弯最宽
    [0.2950, 'LB', 0.981],
    [0.3200, 'LB', 0.948],
    [0.3330, 'LB', 0.926],   // 下琴角
    [0.3400, 'LB', 0.902],   // 角尖（斜率在这里突变）
    [0.3465, 'LB', 0.862],
    [0.3560, 'LB', 0.812],
    [0.3800, 'MB', 1.440],
    [0.4100, 'MB', 1.300],
    [0.4400, 'MB', 1.150],
    [0.4720, 'MB', 1.000],   // 腰最窄
    [0.5000, 'MB', 1.110],
    [0.5300, 'MB', 1.290],
    [0.5600, 'MB', 1.470],
    [0.5800, 'MB', 1.588],
    [0.5890, 'MB', 1.628],   // 上琴角尖
    [0.5960, 'MB', 1.606],
    [0.6060, 'UB', 0.982],
    [0.6460, 'UB', 0.994],
    [0.7020, 'UB', 1.000],   // 上弯最宽
    [0.7720, 'UB', 0.982],
    [0.8290, 'UB', 0.910],
    [0.8990, 'UB', 0.766],
    [0.9410, 'UB', 0.575],
    [0.9650, 'UB', 0.380],
    [0.9800, 'UB', 0.240],
    [0.9900, 'UB', 0.130],
    [1.0000, 'UB', 0.000]
  ];

  /* =====================================================================
   * 乐器参数表（单位 mm）
   * =================================================================== */
  const SPECS = {
    violin: {
      id: 'violin', name: '小提琴', en: 'Violin',
      L: 356, LW: 104, MW: 54, UW: 83.5,
      ribH: 30, archTop: 15.5, archBack: 13.5,
      overhang: 2.5, edgeThick: 3.2,
      neckLen: 130, fbLen: 270, fbNutW: 23.5, fbEndW: 42.5,
      stringLen: 328, clearanceEnd: 4.6, bridgeStringY: 28,
      bridgeW: 41.5, bridgeThick: 4.6,
      nutDepth: 6.5, nutThick: 4.6,
      pegboxLen: 64, cavityHalf: 7.0, wallThick: 5.0, pegboxH: 21,
      scrollR: 17.0, scrollTurns: 1.8, scrollThick: 2.6, scrollWidth: 11.0,
      pegZ: [0.30, 0.64],
      chinrest: true, chinrestSide: -1,
      tailpieceLen: 112, tailWideEnd: 42, tailNarrowEnd: 22, tailThick: 5.5,
      endpin: 0,
      openMidi: [55, 62, 69, 76],
      jianpuBase: 60,
      strings: [
        { name: 'G3', dia: 2.8, color: 0xc4994f },
        { name: 'D4', dia: 2.2, color: 0xcbb388 },
        { name: 'A4', dia: 1.7, color: 0xd6dade },
        { name: 'E5', dia: 1.25, color: 0xdfe5ea }
      ]
    },
    viola: {
      id: 'viola', name: '中提琴', en: 'Viola',
      L: 420, LW: 125, MW: 69, UW: 97.5,
      ribH: 37, archTop: 17.5, archBack: 15.5,
      overhang: 2.8, edgeThick: 3.6,
      neckLen: 150, fbLen: 320, fbNutW: 26, fbEndW: 47,
      stringLen: 370, clearanceEnd: 5.5, bridgeStringY: 32,
      bridgeW: 48, bridgeThick: 5.2,
      nutDepth: 7.2, nutThick: 5.0,
      pegboxLen: 72, cavityHalf: 8.0, wallThick: 5.6, pegboxH: 24,
      scrollR: 19.5, scrollTurns: 1.8, scrollThick: 2.9, scrollWidth: 12.4,
      pegZ: [0.30, 0.64],
      chinrest: true, chinrestSide: -1,
      tailpieceLen: 128, tailWideEnd: 48, tailNarrowEnd: 25, tailThick: 6.2,
      endpin: 0,
      openMidi: [48, 55, 62, 69],
      jianpuBase: 60,
      strings: [
        { name: 'C3', dia: 3.4, color: 0xb5885a },
        { name: 'G3', dia: 2.7, color: 0xc4994f },
        { name: 'D4', dia: 2.1, color: 0xcbb388 },
        { name: 'A4', dia: 1.55, color: 0xd6dade }
      ]
    },
    cello: {
      id: 'cello', name: '大提琴', en: 'Cello',
      L: 760, LW: 220, MW: 125, UW: 170,
      ribH: 118, archTop: 30, archBack: 27,
      overhang: 4.0, edgeThick: 5.0,
      neckLen: 277, fbLen: 576, fbNutW: 33, fbEndW: 62,
      stringLen: 690, clearanceEnd: 9.0, bridgeStringY: 57,
      bridgeW: 88, bridgeThick: 8.5,
      nutDepth: 11, nutThick: 8.5,
      pegboxLen: 116, cavityHalf: 11.0, wallThick: 8.0, pegboxH: 38,
      scrollR: 30, scrollTurns: 1.8, scrollThick: 4.2, scrollWidth: 17.0,
      pegZ: [0.30, 0.64],
      chinrest: false, chinrestSide: -1,
      tailpieceLen: 230, tailWideEnd: 82, tailNarrowEnd: 44, tailThick: 9.5,
      endpin: 1,
      openMidi: [36, 43, 50, 57],
      jianpuBase: 48,
      strings: [
        { name: 'C2', dia: 5.6, color: 0x8f6a46 },
        { name: 'G2', dia: 4.5, color: 0xa07a4e },
        { name: 'D3', dia: 3.5, color: 0xcbb388 },
        { name: 'A3', dia: 2.7, color: 0xd6dade }
      ]
    }
  };
  VIO.SPECS = SPECS;

  /* ------------------------------------------------------------ 轮廓 */
  function outlineOf(spec, samples) {
    const refs = { LB: spec.LW, MB: spec.MW, UB: spec.UW };
    const xs = OUTLINE_CTRL.map(function (c) { return c[0]; });
    const ys = OUTLINE_CTRL.map(function (c) { return c[2] * refs[c[1]]; });
    const dense = MX.pchipSamples(xs, ys, samples || 300);
    const z0 = -spec.L / 2;
    const right = dense.map(function (p) { return [p[1], z0 + p[0] * spec.L]; });
    const pts = right.slice();
    for (let i = right.length - 2; i >= 1; i--) pts.push([-right[i][0], right[i][1]]);
    return MX.polyCCW(pts);
  }
  VIO.outlineOf = outlineOf;

  /**
   * 拱面解析曲线：s = 0 中心 → s = 1 边缘。
   * h(s) = H·(1 − s^p)（主拱：中心平缓，越靠边落得越快）
   *      − D·bump(s)（边缘凹槽 recurve，bump 在 s = 1 处归零 → 边缘高度恒为 0）
   */
  function archH(s, H, opts) {
    opts = opts || {};
    const p = opts.p === undefined ? 2.35 : opts.p;
    const D = (opts.channel === undefined ? 0.10 : opts.channel) * H;
    const uc = opts.uc === undefined ? 0.90 : opts.uc;
    const wc = opts.wc === undefined ? 0.075 : opts.wc;
    const g = Math.exp(-Math.pow((s - uc) / wc, 2)) - Math.exp(-Math.pow((1 - uc) / wc, 2));
    return H * (1 - Math.pow(MX.clamp(s, 0, 1), p)) - D * g;
  }
  VIO.archH = archH;

  function phong(color, opts) {
    opts = opts || {};
    const m = new T.MeshPhongMaterial({
      color: color,
      shininess: opts.shininess === undefined ? 55 : opts.shininess,
      specular: opts.specular === undefined ? 0x5a4a3a : opts.specular,
      side: opts.side || T.DoubleSide,
      map: opts.map || null
    });
    if (opts.polyOffset) {
      m.polygonOffset = true;
      m.polygonOffsetFactor = opts.polyOffset[0];
      m.polygonOffsetUnits = opts.polyOffset[1];
    }
    return m;
  }
  VIO.phong = phong;

  /* =====================================================================
   * 建一把琴
   * =================================================================== */
  VIO.build = function (instId) {
    const spec = SPECS[instId] || SPECS.violin;
    const TXm = global.TX || {};
    const S = spec.L / 356;                       // 相对小提琴的尺寸
    const grp = new T.Group();
    grp.name = 'instrument-' + spec.id;

    const outline = outlineOf(spec, 320);
    const rt = MX.radialTable(outline, 720);
    const ribOutline = MX.polyInset(outline, spec.overhang);
    const rimY = 0;
    const backRim = -spec.ribH;

    const woodTop = TXm.wood ? TXm.wood({
      base: '#d79a52', light: '#e8bd7e', dark: '#a4632a',
      fig: 1, seed: 17, size: 512, repX: 1, repY: 1, gloss: true
    }) : null;
    const woodBack = TXm.wood ? TXm.wood({
      base: '#c07f36', light: '#e0ab5c', dark: '#8a4f1e',
      fig: 2, seed: 29, size: 512, repX: 1, repY: 1, gloss: true
    }) : null;
    const matTop = phong(0xd79a52, { shininess: 70, specular: 0x6b563e, map: woodTop });
    const matBack = phong(0xc07f36, { shininess: 80, specular: 0x6b563e, map: woodBack });
    const matNeck = phong(0xc98a44, { shininess: 65, specular: 0x604c36, map: woodTop });
    // 琴头/指板/腮托的乌木：还是黑，但稍微提亮一点并加高光，
    // 否则压在深色桌垫上整块糊成一片，看不清弦钮在哪
    const matDark = phong(0x2b2320, { shininess: 42, specular: 0x4a3f38 });
    const matBridge = phong(0xdcb877, { shininess: 40, specular: 0x4a3d2c });
    const matPurfling = phong(0x2a1c12, { shininess: 18, specular: 0x241a12, polyOffset: [-3, -3] });
    const matInner = phong(0x4a2a12, { shininess: 8, specular: 0x180f06 });
    const matString = spec.strings.map(function (s) {
      return new T.MeshPhongMaterial({
        color: s.color, shininess: 40 + 110, specular: 0x9aa4ac, side: T.DoubleSide
      });
    });

    /* ---------------------------------------------------- 板面高度函数 */
    const plateYTop = function (x, z) { return archH(rt.s(x, z), spec.archTop); };
    const plateYBack = function (x, z) { return backRim - archH(rt.s(x, z), spec.archBack); };

    /* ------------------------------------------------------------ f 孔 */
    const zBridge = spec.L / 2 + spec.neckLen - spec.stringLen;
    function fHolePoly(side) {
      const lowerZ = zBridge - 44 * S, upperZ = zBridge + 34 * S;
      const xLower = 21.0 * S, xNotch = 19.2 * S, xUpper = 16.8 * S;
      const ctrlZ = [lowerZ, lowerZ + 12 * S, lowerZ + 26 * S, zBridge,
        zBridge + 12 * S, upperZ - 10 * S, upperZ];
      const ctrlX = [xLower, xLower - 0.9 * S, xNotch + 0.2 * S, xNotch,
        xNotch - 0.8 * S, xUpper + 0.9 * S, xUpper];
      const path = MX.pchipSamples(ctrlZ, ctrlX, 96);
      const rLower = 4.0 * S, rUpper = 3.5 * S, wSlit = 1.30 * S;
      const n = path.length;
      const inner = [], outer = [];
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const z = path[i][0], x = path[i][1];
        const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
        const dz = path[i1][0] - path[i0][0];
        const dx = path[i1][1] - path[i0][1];
        const l = Math.hypot(dz, dx) || 1;
        const nx = dz / l, nz = -dx / l;              // 路径法线
        let w = wSlit;
        w += Math.exp(-Math.pow((t - 0.035) / 0.055, 2)) * (rLower - wSlit);
        w += Math.exp(-Math.pow((t - 0.965) / 0.050, 2)) * (rUpper - wSlit);
        if (t < 0.012) w *= 0.15 + (t / 0.012) * 0.85;
        if (t > 0.988) w *= 0.15 + ((1 - t) / 0.012) * 0.85;
        // 中切口外侧的小豁口（f 的那个"缺口"）
        const nick = Math.exp(-Math.pow((t - 0.50) / 0.016, 2)) * 1.1 * S;
        inner.push([x + nx * w * 0.5, z + nz * w * 0.5]);
        outer.push([x - nx * (w * 0.5 + nick), z - nz * (w * 0.5 + nick)]);
      }
      let poly = inner.concat(outer.reverse());
      poly = poly.map(function (p) { return [side * p[0], p[1]]; });
      return MX.polyCCW(poly);
    }
    const fHoles = [fHolePoly(1), fHolePoly(-1)];

    /* ------------------------------------------------------ 面板 / 背板 */
    const topMesh = new T.Mesh(MX.plateMesh(outline, fHoles, plateYTop,
      { subdiv: 2, uvScale: [1 / spec.L, 1 / spec.L] }), matTop);
    topMesh.name = 'top-plate';
    grp.add(topMesh);

    const backMesh = new T.Mesh(MX.plateMesh(outline, null, plateYBack,
      { subdiv: 2, uvScale: [1 / spec.L, 1 / spec.L] }), matBack);
    backMesh.name = 'back-plate';
    grp.add(backMesh);

    // 板边厚度 + 侧板（比面板轮廓小 2.4%，面板探出来一点）
    const edgeTopMesh = new T.Mesh(
      MX.ribbonBetween(outline, ribOutline, rimY, -spec.edgeThick, true), matTop);
    edgeTopMesh.name = 'top-edge';
    grp.add(edgeTopMesh);
    const edgeBackMesh = new T.Mesh(
      MX.ribbonBetween(outline, ribOutline, backRim, backRim + spec.edgeThick), matBack);
    edgeBackMesh.name = 'back-edge';
    grp.add(edgeBackMesh);

    const ribRings = [[], []];
    for (let i = 0; i < ribOutline.length; i++) {
      const p = ribOutline[i];
      const u = (p[1] + spec.L / 2) / spec.L;
      const h = spec.ribH * (1 - 0.07 * u);
      ribRings[0].push([p[0], -spec.edgeThick, p[1]]);
      ribRings[1].push([p[0], -h + spec.edgeThick, p[1]]);
    }
    const ribMesh = new T.Mesh(MX.meshFromRings(ribRings, { closedRing: true }), matBack);
    ribMesh.name = 'ribs';
    grp.add(ribMesh);

    // 从 f 孔看进去是深色内壁，不是天空
    const innerShell = MX.ribbonBetween(MX.polyInset(ribOutline, 1.0), MX.polyInset(ribOutline, 4.0),
      -spec.edgeThick - 0.2, -spec.edgeThick - 1.6, true);
    const innerMesh = new T.Mesh(innerShell, matInner);
    innerMesh.name = 'inner-shell';
    grp.add(innerMesh);

    // f 孔内壁（孔的"厚度"）
    fHoles.forEach(function (hole) {
      const g = MX.meshFromRings([
        hole.map(function (p) { return [p[0], plateYTop(p[0], p[1]) + 0.02, p[1]]; }),
        hole.map(function (p) { return [p[0], plateYTop(p[0], p[1]) - spec.edgeThick * 0.65, p[1]]; })
      ], { closedRing: true });
      const m = new T.Mesh(g, matInner);
      m.name = 'fhole-wall';
      grp.add(m);
    });

    /* ---------------------------------------------------------- 镶线 */
    [[3.4, 4.4], [4.9, 5.9]].forEach(function (d) {
      const a = MX.polyInset(outline, d[0] * S), b = MX.polyInset(outline, d[1] * S);
      const yf = function (x, z) { return plateYTop(x, z) + 0.06; };
      const m = new T.Mesh(MX.ribbonBetween(a, b, yf, yf, true), matPurfling);
      m.name = 'purfling';
      grp.add(m);
    });

    /* ===================================================================
     * 琴颈相关：弦枕 / 指板 / 琴颈 / 弦轴箱 / 涡卷 / 弦钮
     * ================================================================= */
    const zNut = spec.L / 2 + spec.neckLen;
    const zFbEnd = zNut - spec.fbLen;
    const yBridgeString = plateYTop(0, zBridge) + spec.bridgeStringY;
    // 弦比指板高：弦枕处 1.2mm → 指板末端 clearanceEnd，反推出弦的夹角
    const stringDrop = spec.stringLen *
      Math.tan(MX.deg(3.2) + Math.atan((spec.clearanceEnd - 1.2) / spec.fbLen));
    const yNutString = yBridgeString - stringDrop;
    const yFbNut = yNutString - 1.2;
    const yStringAt = function (z) {
      return yBridgeString + (yNutString - yBridgeString) * MX.invLerp(zBridge, zNut, z);
    };
    const yFbEnd = yStringAt(zFbEnd) - spec.clearanceEnd;
    const yFbTopAt = function (z) {
      return yFbNut + (yFbEnd - yFbNut) * MX.invLerp(zNut, zFbEnd, z);
    };
    const fbWidthAt = function (z) {
      return spec.fbNutW + (spec.fbEndW - spec.fbNutW) * MX.invLerp(zNut, zFbEnd, z);
    };
    const fbRadius = 0.118 * spec.L;
    const strRadius = 0.1067 * spec.L;
    const dropFix = function (x) {
      return strRadius - Math.sqrt(Math.max(0, strRadius * strRadius - x * x));
    };

    /* ---------------------------------------------------------- 指板 */
    const fbRings = [];
    const fbN = 26;
    for (let i = 0; i < fbN; i++) {
      const t = i / (fbN - 1);
      const z = MX.lerp(zNut, zFbEnd, t);
      const halfW = fbWidthAt(z) / 2;
      const topY = yFbTopAt(z);
      const thick = MX.lerp(5.6, 5.0, t) * S;
      const ring = [];
      const nA = 13;
      for (let j = 0; j < nA; j++) {                 // 上表面：弧形
        const a = -1 + (2 * j) / (nA - 1);
        const x = a * halfW;
        ring.push([x, topY - (fbRadius - Math.sqrt(Math.max(0, fbRadius * fbRadius - x * x))), z]);
      }
      for (let j = nA - 2; j >= 1; j--) {            // 下表面：楔形（两边厚中间薄）
        const a = -1 + (2 * j) / (nA - 1);
        const x = a * halfW * 0.94;
        ring.push([x, topY - thick + Math.pow(Math.abs(a), 1.7) * thick * 0.42, z]);
      }
      fbRings.push(ring);
    }
    const fbMesh = new T.Mesh(MX.meshFromRings(fbRings, { closedRing: true }), matDark);
    fbMesh.name = 'fingerboard';
    grp.add(fbMesh);

    /* ---------------------------------------------------------- 琴颈 */
    const neckRings = [];
    const neckN = 18;
    for (let i = 0; i < neckN; i++) {
      const t = i / (neckN - 1);
      const z = MX.lerp(spec.L / 2 + 2, zNut, t);
      // 琴颈比指板略窄一点：指板要从头到尾都是黑的，不能从两边露木头
      const w = MX.lerp(31, spec.fbNutW + 0.2, t) * S;
      const depth = MX.lerp(20, 12.5, t) * S;
      // 琴颈顶面正好贴在指板下表面（别留缝，也别顶出去）
      const topY = yFbTopAt(z) - MX.lerp(5.5, 4.9, t) * S;
      const ring = [];
      const nS = 12;
      for (let j = 0; j < nS; j++) {
        const a = (j / nS) * MX.TAU - Math.PI / 2;
        const sx = Math.cos(a), sy = Math.sin(a);
        const px = sx * (w / 2) * (0.90 + 0.10 * Math.abs(sx));
        // 截面高度是 ±depth/2（写 depth 会让琴颈整整高出一倍、从指板上面顶出来，
        // 指板看上去就只剩两边的黑边了）
        const py = sy * (depth / 2) * (0.62 + 0.38 * Math.abs(sy));
        ring.push([px, topY - depth / 2 + py, z]);
      }
      neckRings.push(ring);
    }
    const neckMesh = new T.Mesh(MX.meshFromRings(neckRings, { closedRing: true }), matNeck);
    neckMesh.name = 'neck';
    grp.add(neckMesh);

    // 琴颈根部（跟）：往琴身里嵌一块，侧面看是圆润的一坨
    const heelRings = [];
    for (let i = 0; i < 9; i++) {
      const t = i / 8;
      const z = MX.lerp(spec.L / 2 - 30, spec.L / 2 + 8, t);
      const w = MX.lerp(spec.UW * 0.62, spec.fbNutW * 1.35, Math.pow(t, 0.8)) * S;
      const topY = yFbTopAt(spec.L / 2) - 5.6 * S;
      const botY = -spec.ribH * 0.90 + 6 * S;
      const ring = [];
      const nS = 10;
      for (let j = 0; j < nS; j++) {
        const a = (j / nS) * MX.TAU;
        const sx = Math.cos(a), sy = Math.sin(a);
        ring.push([
          sx * (w / 2) * (0.92 + 0.08 * Math.abs(sy)),
          (topY + botY) / 2 + sy * ((topY - botY) / 2),
          z
        ]);
      }
      heelRings.push(ring);
    }
    const heelMesh = new T.Mesh(MX.meshFromRings(heelRings, { closedRing: true }), matNeck);
    heelMesh.name = 'heel';
    grp.add(heelMesh);

    /* ---------------------------------------------------------- 弦枕 */
    const nutTop = yFbNut + spec.nutThick * 0.45;
    const nutHalf = spec.fbNutW / 2 + 0.7;
    const nutProfile = [
      [-nutHalf, nutTop - spec.nutThick * 0.55],
      [-nutHalf * 0.78, nutTop],
      [nutHalf * 0.78, nutTop],
      [nutHalf, nutTop - spec.nutThick * 0.55]
    ];
    const nutRings = [
      nutProfile.map(function (p) { return [p[0], p[1], zNut - spec.nutDepth / 2]; }),
      nutProfile.map(function (p) { return [p[0], p[1], zNut + spec.nutDepth / 2]; })
    ];
    const nutMesh = new T.Mesh(MX.meshFromRings(nutRings, { closedRing: true }), matDark);
    nutMesh.name = 'nut';
    grp.add(nutMesh);

    /* ------------------------------------------------ 弦轴箱（中空） */
    const pbZ0 = zNut + spec.nutDepth / 2;
    const pbZ1 = pbZ0 + spec.pegboxLen;
    const cavityHalf = spec.cavityHalf * S;
    const wall = spec.wallThick * S;
    const boxH = spec.pegboxH * S;
    const boxTopY = yNutString - 1.5 * S;
    const boxBotY = boxTopY - boxH;
    const pegY = boxBotY + boxH * 0.52;
    function boxMesh(x0, x1, y0, y1, z0, z1, mat, name) {
      const m = new T.Mesh(new T.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), mat);
      m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      m.name = name || 'box';
      return m;
    }
    const pbGroup = new T.Group();
    pbGroup.name = 'pegbox';
    pbGroup.add(boxMesh(cavityHalf, cavityHalf + wall, boxBotY, boxTopY, pbZ0, pbZ1, matNeck, 'pb-wall-r'));
    pbGroup.add(boxMesh(-cavityHalf - wall, -cavityHalf, boxBotY, boxTopY, pbZ0, pbZ1, matNeck, 'pb-wall-l'));
    pbGroup.add(boxMesh(-cavityHalf - wall, cavityHalf + wall, boxBotY, boxBotY + wall * 0.7, pbZ0, pbZ1, matNeck, 'pb-floor'));
    pbGroup.add(boxMesh(-cavityHalf - wall, cavityHalf + wall, boxBotY, boxTopY, pbZ0 - wall * 0.5, pbZ0, matNeck, 'pb-front'));
    grp.add(pbGroup);

    /* ---------------------------------------------------------- 弦钮 */
    const pegs = [];
    // 左壁 = 低音侧（两根低音弦），右壁 = 高音侧；靠近弦枕的那一对是次低音弦
    const pegSide = [-1, -1, 1, 1];
    const pegRow = [1, 0, 0, 1];
    spec.strings.forEach(function (str, i) {
      const side = pegSide[i];
      const zPeg = pbZ0 + wall * 0.7 +
        (pbZ1 - pbZ0 - wall * 1.4) * spec.pegZ[pegRow[i]];
      const grpPeg = new T.Group();
      grpPeg.name = 'peg-' + i;
      grpPeg.userData.pegIndex = i;
      const wallMid = cavityHalf + wall / 2;
      grpPeg.position.set(side * wallMid, pegY, zPeg);
      if (side > 0) grpPeg.rotation.y = Math.PI;
      const r0 = 3.0 * S, r1 = 3.5 * S;
      const shaftPts = [];
      for (let k = 0; k < 10; k++) {
        const t = k / 9;
        shaftPts.push(new T.Vector2(MX.lerp(r0, r1, t), MX.lerp(-wall * 0.45, cavityHalf * 1.02, t)));
      }
      const shaft = new T.Mesh(new T.LatheGeometry(shaftPts, 12), matDark);
      shaft.rotation.z = -Math.PI / 2;               // 轴转到 X 方向（朝箱内）
      shaft.name = 'peg-shaft';
      grpPeg.add(shaft);
      const shoulder = new T.Mesh(new T.CylinderGeometry(5.4 * S, 5.2 * S, 2.4 * S, 14), matDark);
      shoulder.rotation.z = Math.PI / 2;
      shoulder.position.x = -wall * 0.45 - 1.2 * S;
      shoulder.name = 'peg-shoulder';
      grpPeg.add(shoulder);
      const blade = new T.Mesh(MX.meshFromParam(function (u, v) {
        const a = v * MX.TAU;
        const taper = 1 - 0.18 * u;
        return [
          MX.lerp(-wall * 0.45 - 2.4 * S, -wall * 0.45 - 13.0 * S, u),
          Math.sin(a) * 3.1 * S * taper,
          Math.cos(a) * spec.scrollWidth * 0.5 * 0.85 * taper
        ];
      }, 8, 12, { closedRing: true }), matDark);
      blade.name = 'peg-blade';
      grpPeg.add(blade);
      grp.add(grpPeg);
      // 看得见的东西很小（弦钮杆只有几毫米），所以再放一个"看不见的碰撞球"，
      // 准星只要大致对着弦轴就能点中 —— 教学游戏不该让人跟准星较劲。
      // 碰撞球别太大：同一侧两根弦轴只隔 ~19mm，球太大会互相抢选中
      const hit = new T.Mesh(new T.SphereGeometry(13 * S, 10, 8),
        new T.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
      hit.position.set(-wall * 0.45 - 8 * S, 0, 0);
      hit.name = 'peg-hit';
      hit.userData.pegIndex = i;
      hit.userData.aimRadius = 13 * S;
      grpPeg.add(hit);
      pegs.push({
        group: grpPeg, side: side, z: zPeg, r: r1 + 1.0 * S,
        wrapX: side * (wallMid - cavityHalf * 0.72),
        axisY: pegY, angle: 0, index: i, hit: hit
      });
    });

    /* ---------------------------------------------------------- 涡卷 */
    // 对数螺线 + 扁椭圆截面：沿箱宽方向宽、径向薄 —— "卷起来的一片板"，
    // 不是中间空心一圈圈盘的蜗牛壳。
    const scrollCenter = { z: pbZ1 + spec.scrollR * 0.30, y: boxTopY - spec.scrollR * 0.62 };
    const kSpiral = Math.log(1 / 0.19) / (spec.scrollTurns * MX.TAU);
    const scrollGeo = MX.meshFromParam(function (u, v) {
      const theta = u * spec.scrollTurns * MX.TAU;
      const r = spec.scrollR * Math.exp(-kSpiral * theta);
      const a = theta + Math.PI * 0.62;
      const zc = scrollCenter.z + Math.cos(a) * r;
      const yc = scrollCenter.y + Math.sin(a) * r;
      const dr = -kSpiral * r;
      const tz = Math.cos(a) * dr - Math.sin(a) * r;
      const ty = Math.sin(a) * dr + Math.cos(a) * r;
      const tl = Math.hypot(tz, ty) || 1;
      const nz = -ty / tl, ny = tz / tl;
      const ang = v * MX.TAU;
      const thick = spec.scrollThick * S * (0.55 + 0.45 * Math.min(1, r / (spec.scrollR * 0.55)));
      const wide = spec.scrollWidth * S * (0.55 + 0.45 * Math.min(1, r / (spec.scrollR * 0.70)));
      const cz = Math.cos(ang), sy = Math.sin(ang);
      return [cz * wide, yc + sy * thick * ny, zc + sy * thick * nz];
    }, 110, 14, { closedRing: true });
    const scrollMesh = new T.Mesh(scrollGeo, matNeck);
    scrollMesh.name = 'scroll';
    grp.add(scrollMesh);

    /* ---------------------------------------------------------- 琴马 */
    const bridge = (function () {
      const W = spec.bridgeW;
      const baseY = Math.min(plateYTop(-W * 0.34, zBridge), plateYTop(W * 0.34, zBridge)) - 0.25;
      const topAt = function (x) { return yBridgeString - dropFix(x); };
      const half = W / 2;
      const h = topAt(0) - baseY;
      const prof = [
        [-half, 0.0], [-half + W * 0.055, h * 0.10], [-half + W * 0.10, h * 0.21],
        [-half + W * 0.155, h * 0.27], [-half + W * 0.20, h * 0.31],
        [-half + W * 0.30, h * 0.34], [-half + W * 0.345, h * 0.41],
        [-half + W * 0.30, h * 0.53], [-half + W * 0.225, h * 0.61],
        [-half + W * 0.265, h * 0.71], [-half + W * 0.30, h * 0.79]
      ];
      const pts = prof.slice();
      for (let i = 0; i <= 22; i++) {
        const x = -half + (W * i) / 22;
        pts.push([x, topAt(x) - baseY - 0.5]);
      }
      for (let i = prof.length - 1; i >= 0; i--) pts.push([-prof[i][0], prof[i][1]]);
      const shape = new T.Shape();
      shape.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
      shape.closePath();
      const heart = new T.Path();
      const hy = h * 0.42, hr = W * 0.075;
      heart.moveTo(0, hy - hr * 1.25);
      heart.bezierCurveTo(hr * 1.5, hy - hr * 1.2, hr * 1.35, hy + hr, 0, hy + hr * 0.85);
      heart.bezierCurveTo(-hr * 1.35, hy + hr, -hr * 1.5, hy - hr * 1.2, 0, hy - hr * 1.25);
      shape.holes.push(heart);
      [-1, 1].forEach(function (s) {
        const p = new T.Path();
        const cx = s * W * 0.235, cy = h * 0.60, rx = W * 0.085, ry = h * 0.115;
        p.moveTo(cx - rx, cy);
        p.bezierCurveTo(cx - rx, cy + ry * 1.6, cx + rx, cy + ry * 1.6, cx + rx, cy);
        p.bezierCurveTo(cx + rx, cy - ry * 1.5, cx - rx, cy - ry * 1.5, cx - rx, cy);
        shape.holes.push(p);
      });
      const g = new T.ExtrudeGeometry(shape, {
        depth: spec.bridgeThick, bevelEnabled: true, bevelSize: 0.22 * S,
        bevelThickness: 0.22 * S, bevelSegments: 1, curveSegments: 6
      });
      g.translate(0, 0, -spec.bridgeThick / 2);
      const m = new T.Mesh(g, matBridge);
      m.name = 'bridge';
      m.position.set(0, baseY, zBridge);
      return m;
    })();
    grp.add(bridge);

    /* ------------------------------------------------- 系弦板 / 腮托 */
    const zTailEnd = -spec.L / 2 + spec.L * 0.048;
    const zTailBridgeEnd = zBridge - spec.L * 0.155;
    const tailGroup = new T.Group();
    tailGroup.name = 'tailpiece';
    (function () {
      const wTail = spec.tailWideEnd * 0.5, wBridgeEnd = spec.tailNarrowEnd * 0.5;
      const rows = 12, rings = [];
      for (let i = 0; i < rows; i++) {
        const t = i / (rows - 1);
        const z = MX.lerp(zTailEnd, zTailBridgeEnd, t);
        const half = MX.lerp(wTail, wBridgeEnd, Math.pow(t, 0.85));
        const y = plateYTop(0, z) + 1.8 * S;
        const ring = [];
        for (let j = 0; j < 10; j++) {
          const a = (j / 10) * MX.TAU;
          const cz = Math.cos(a), cy = Math.sin(a);
          ring.push([
            cz * half * (0.92 + 0.08 * Math.abs(cy)),
            y + cy * spec.tailThick * 0.5,
            z
          ]);
        }
        rings.push(ring);
      }
      tailGroup.add(new T.Mesh(MX.meshFromRings(rings, { closedRing: true }), matDark));
    })();
    grp.add(tailGroup);

    if (spec.chinrest) {
      const side = spec.chinrestSide;
      const cx = side * spec.LW * 0.56, cz = -spec.L * 0.34;
      const y0 = plateYTop(cx * 0.55, cz * 0.6);
      const rx0 = spec.LW * 0.195, rz0 = spec.L * 0.118;
      // 水滴形：贴轮廓的一侧薄、外侧厚，顶面收成圆角 —— 是"一块板"不是"一个圈"
      const rows = [
        { sc: 0.62, y: 0.8 }, { sc: 0.94, y: 3.4 }, { sc: 1.0, y: 8.0 },
        { sc: 0.99, y: spec.ribH * 0.40 }, { sc: 0.90, y: spec.ribH * 0.47 },
        { sc: 0.62, y: spec.ribH * 0.52 }, { sc: 0.05, y: spec.ribH * 0.535 }
      ];
      const rings = rows.map(function (row) {
        const ring = [];
        for (let j = 0; j < 20; j++) {
          const a = (j / 20) * MX.TAU;
          // 水滴：靠琴身中线一侧收窄，外侧鼓
          const teardrop = 1 - 0.26 * Math.max(0, Math.cos(a) * (-side));
          ring.push([
            cx + Math.cos(a) * rx0 * row.sc * side * teardrop,
            y0 + row.y,
            cz + Math.sin(a) * rz0 * row.sc
          ]);
        }
        return ring;
      });
      const crMesh = new T.Mesh(MX.meshFromRings(rings, { closedRing: true }), matDark);
      crMesh.name = 'chinrest';
      grp.add(crMesh);
    }
    if (spec.endpin) {
      const pin = new T.Mesh(new T.CylinderGeometry(3.4 * S, 2.6 * S, spec.L * 0.10, 10), matDark);
      pin.name = 'endpin';
      pin.position.set(0, -spec.ribH * 0.55, -spec.L / 2 - spec.L * 0.04);
      pin.rotation.x = Math.PI / 2;
      grp.add(pin);
    }

    /* ===================================================================
     * 琴弦：一条完整链路，采样成固定点数的折线（每帧只改写顶点）
     * ================================================================= */
    const NSEG = { tail: 5, sound: 46, nut: 5, wrap: 40, tuck: 3 };
    const NPTS = NSEG.tail + NSEG.sound + NSEG.nut + NSEG.wrap + NSEG.tuck + 2;
    const SP_TAIL = 10.5 * S, SP_BRIDGE = 11.0 * S, SP_NUT = 5.5 * S;
    const yTail = plateYTop(0, zTailBridgeEnd) + spec.tailThick * 0.5 + 1.8 * S;

    const strings = spec.strings.map(function (str, i) {
      const a = i - 1.5;
      const mesh = MX.dynTube(NPTS, 8, matString[i]);
      mesh.name = 'string-' + i;
      mesh.userData.stringIndex = i;
      grp.add(mesh);
      return {
        index: i, spec: str, radius: str.dia / 2,
        xTail: a * SP_TAIL, xBridge: a * SP_BRIDGE, xNut: a * SP_NUT,
        yTail: yTail, peg: pegs[i], mesh: mesh,
        installed: 0, vibrato: 0, vibPhase: 0, freq: 220,
        finger: -1, fingerRatio: 0
      };
    });

    function buildStringPath(st, upto) {
      const pts = [];
      const xT = st.xTail, xB = st.xBridge, xN = st.xNut;
      const yB = yBridgeString - dropFix(xB);
      const yN = yNutString - dropFix(xN);
      const peg = st.peg;
      for (let k = 0; k < NSEG.tail; k++) {                       // 系弦板 → 琴马
        const t = k / (NSEG.tail - 1);
        pts.push([MX.lerp(xT, xB, t), MX.lerp(st.yTail, yB, t), MX.lerp(zTailBridgeEnd, zBridge, t)]);
      }
      const nS = NSEG.sound;
      let fingerT = -1, yFinger = 0, zFinger = 0, xFinger = 0;
      if (st.finger >= 0) {
        zFinger = MX.lerp(zNut, zBridge, st.fingerRatio);
        xFinger = MX.lerp(xN, xB, MX.invLerp(zNut, zBridge, zFinger));
        yFinger = yFbTopAt(zFinger) + st.radius + 0.35 * S;
        fingerT = MX.invLerp(zNut, zBridge, zFinger);              // t: 0 = 琴马 → 1 = 弦枕
      }
      for (let k = 1; k < nS; k++) {                              // 琴马 → 弦枕（发声段）
        const t = k / (nS - 1);
        const x = MX.lerp(xB, xN, t), z = MX.lerp(zBridge, zNut, t);
        let y = yBridgeString + (yNutString - yBridgeString) * t - dropFix(x);
        if (st.finger >= 0 && t > fingerT) {
          // 按弦点往弦枕一侧不振（被手指压住了），但仍然画出来
          const u = MX.clamp((t - fingerT) / Math.max(1e-4, 1 - fingerT), 0, 1);
          y = MX.lerp(yFinger, yN, MX.smoothstep(u));
        } else if (st.vibrato > 0.0001) {
          const u = st.finger >= 0 ? MX.clamp(t / Math.max(1e-4, fingerT), 0, 1) : t;
          const amp = Math.sin(Math.PI * u) * st.vibrato;
          y += amp * (Math.sin(st.vibPhase) * 0.78 + Math.sin(2 * st.vibPhase + 1.1) * 0.22);
        }
        pts.push([x, y, z]);
      }
      const wrapStart = [peg.wrapX, peg.axisY + peg.r, peg.z];
      for (let k = 0; k < NSEG.nut; k++) {                        // 弦枕 → 弦轴箱
        const t = k / (NSEG.nut - 1);
        if (k === 0) { pts.push([xN, yN, zNut + spec.nutDepth * 0.4]); continue; }
        pts.push([
          MX.lerp(xN, wrapStart[0], t),
          MX.lerp(yN, wrapStart[1], MX.smoothstep(t)),
          MX.lerp(zNut + spec.nutDepth * 0.8, wrapStart[2], t)
        ]);
      }
      const turns = 2, pitch = 3.0 * S;
      const dir = st.index % 2 === 0 ? 1 : -1;
      for (let k = 0; k < NSEG.wrap; k++) {                       // 弦钮杆上缠两圈
        const t = k / (NSEG.wrap - 1);
        const ang = -Math.PI / 2 + dir * t * turns * MX.TAU;
        const advance = t * turns * pitch * (peg.side < 0 ? 0.5 : -0.5);
        pts.push([
          peg.wrapX + advance,
          peg.axisY + Math.cos(ang) * peg.r,
          peg.z + Math.sin(ang) * peg.r
        ]);
      }
      const last = pts[pts.length - 1];
      for (let k = 1; k <= NSEG.tuck; k++) {                      // 末端塞进弦钮孔
        const t = k / NSEG.tuck;
        pts.push([last[0] + (peg.side < 0 ? -1 : 1) * t * 1.8 * S, last[1] - t * 0.4 * S, last[2]]);
      }
      const s = MX.clamp(upto === undefined ? 1 : upto, 0, 1);
      if (s >= 1) return pts;
      const keep = Math.max(2, Math.floor(2 + s * (pts.length - 2)));
      return pts.slice(0, keep);
    }

    const upHint = new T.Vector3(0, 1, 0);
    let dirty = true;
    function refreshStrings() {
      strings.forEach(function (st) {
        if (st.installed <= 0.001) { st.mesh.visible = false; return; }
        st.mesh.visible = true;
        st.mesh.setPath(buildStringPath(st, st.installed), st.radius, upHint);
      });
      dirty = false;
    }

    /* ------------------------------------------------------- 按弦手指 */
    // 手上的一切都不建模：按需求，第一人称里只留琴和弓
    // （按弦的物理效果靠 strings[i].finger 表达：被按住的弦"有效弦长"变短、
    //   按弦点到弦枕那一段不振 —— 这些照旧，只是不画手指和手掌。）
    function updateFinger() {}

    /* =============================================================== 接口 */
    const api = {
      spec: spec, group: grp, scale: S,
      outline: outline, ribOutline: ribOutline,
      plateYTop: plateYTop, plateYBack: plateYBack,
      zBridge: zBridge, zNut: zNut, zFbEnd: zFbEnd,
      zTailEnd: zTailEnd, zTailBridgeEnd: zTailBridgeEnd,
      zPegbox: [pbZ0, pbZ1],
      yBridgeString: yBridgeString, yNutString: yNutString,
      yFbTopAt: yFbTopAt, fbWidthAt: fbWidthAt,
      strRadius: strRadius, fbRadius: fbRadius, dropFix: dropFix,
      pegs: pegs, strings: strings,
      scrollCenter: scrollCenter, pegAxisY: pegY,
      lowestY: -(spec.ribH * 1.0) - spec.archBack - (spec.endpin ? spec.L * 0.05 : 0),
      setStringInstalled: function (i, s) {
        strings[i].installed = MX.clamp(s, 0, 1);
        dirty = true;
      },
      setAllStringsInstalled: function (s) {
        strings.forEach(function (st) { st.installed = s; });
        dirty = true;
      },
      setVibrato: function (i, amp) { strings[i].vibrato = amp; dirty = true; },
      setAllVibrato: function (amp) { strings.forEach(function (st) { st.vibrato = amp; }); dirty = true; },
      setFinger: function (i, ratio) {
        strings[i].finger = i; strings[i].fingerRatio = ratio; dirty = true;
      },
      clearFingers: function () { strings.forEach(function (st) { st.finger = -1; }); dirty = true; },
      setPegAngle: function (i, ang) { pegs[i].angle = ang; pegs[i].group.rotation.x = ang; },
      /** 触弦点 t：0 = 靠指板，1 = 靠琴马 */
      setContact: function (t) { strings.forEach(function (st) { st.contact = t; }); },
      contactWorld: function (i) {
        const st = strings[i];
        // 弦上位置（0 = 琴马）。这个映射必须和 game.js 的 contactToS、
        // 以及音频 DSP 里的 β 完全一致，否则弓、黄圈、音色三处对不上。
        const t = MX.clamp(0.33 - 0.23 * st.contact, 0.02, 0.98);
        const z = MX.lerp(zBridge, zNut, t);
        const x = MX.lerp(st.xBridge, st.xNut, t);
        return new T.Vector3(x, yBridgeString + (yNutString - yBridgeString) * t - dropFix(x), z);
      },
      stringPointAt: function (i, t) {
        const st = strings[i];
        const z = MX.lerp(zBridge, zNut, t);
        const x = MX.lerp(st.xBridge, st.xNut, t);
        return new T.Vector3(x, yBridgeString + (yNutString - yBridgeString) * t - dropFix(x), z);
      },
      update: function (dt) {
        let vib = false;
        for (let i = 0; i < strings.length; i++) {
          const st = strings[i];
          if (st.vibrato > 0.0001) {
            st.vibPhase += dt * MX.TAU * Math.max(1.5, st.freq) * 0.06;
            vib = true;
          }
        }
        if (dirty || vib) refreshStrings();
        updateFinger();
      },
      refreshStrings: function () { dirty = true; }
    };
    refreshStrings();
    return api;
  };

  global.VIO = VIO;
  if (typeof module !== 'undefined' && module.exports) module.exports = VIO;
})(typeof window !== 'undefined' ? window : globalThis);
