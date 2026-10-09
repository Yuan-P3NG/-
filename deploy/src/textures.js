/* =========================================================================
 * textures.js —— 程序化贴图（Canvas 生成，零图片文件）
 *
 * 全部在本地画出来：木纹（琴身/桌面/地板）、桌垫、墙面、海报、乐谱纸、
 * 备弦盒绒布。没有合适的贴图也无所谓 —— 材质都是"贴图 + 底色"，
 * 贴图缺失时游戏照常跑（无头测试环境就是这条路径）。
 * ========================================================================= */
(function (global) {
  'use strict';

  const T = global.THREE;
  const MX = global.MX;
  const TX = {};

  const canCanvas = typeof document !== 'undefined' && !!document.createElement;

  function makeCanvas(w, h) {
    if (!canCanvas) return null;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  function toTex(canvas, repX, repY, opts) {
    if (!canvas) return null;
    const tex = new T.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = T.RepeatWrapping;
    tex.repeat.set(repX || 1, repY || 1);
    tex.anisotropy = 4;
    if (opts && opts.srgb !== false) tex.colorSpace = T.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }
  TX.available = canCanvas;

  /* ------------------------------------------------------------ 木纹 */
  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  function css(rgb) {
    return 'rgb(' + (rgb[0] | 0) + ',' + (rgb[1] | 0) + ',' + (rgb[2] | 0) + ')';
  }

  /**
   * 通用木纹。
   * @param o.base 底色, o.light/o.dark 纹理深浅, o.grain 纹路密度,
   *          o.fig 1=顺直纹(云杉) 2=虎皮纹(枫木) 0=无,
   *          o.planks 地板用的板条数（0 = 不画板条）
   */
  TX.wood = function (o) {
    o = o || {};
    const W = o.size || 512, H = Math.round(W * (o.aspect || 1));
    const c = makeCanvas(W, H);
    if (!c) return null;
    const g = c.getContext('2d');
    const base = hexToRgb(o.base || '#7a4a22');
    const light = hexToRgb(o.light || '#c89a5e');
    const dark = hexToRgb(o.dark || '#3a2010');
    const noise = MX.fbm1(o.seed || 7, 4);
    const noise2 = MX.fbm1((o.seed || 7) + 991, 3);

    g.fillStyle = css(base);
    g.fillRect(0, 0, W, H);
    const img = g.getImageData(0, 0, W, H);
    const d = img.data;
    const grain = o.grain === undefined ? 26 : o.grain;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = x / W, v = y / H;
        // 主纹路：沿 x 方向拉伸的同心年轮 + 细噪声
        const warp = noise(u * 3.1) * 0.5 + noise2(u * 9.7 + v * 0.6) * 0.16;
        const ring = Math.sin((v * grain + warp * 6) * Math.PI) * 0.5 + 0.5;
        let t = Math.pow(ring, o.contrast === undefined ? 1.6 : o.contrast);
        const fib = noise2(v * 190 + u * 26) * 0.10 - 0.05;
        t = MX.clamp(t + fib, 0, 1);
        let col = mix(base, t > 0.5 ? mix(base, light, (t - 0.5) * 2) : mix(base, dark, (0.5 - t) * 2), 0.85);
        if (o.fig === 1) {                       // 云杉：顺直细纹
          const straight = Math.abs(Math.sin(u * 240 * Math.PI / W * 6 + warp * 2));
          col = mix(col, light, straight * 0.08);
        } else if (o.fig === 2) {                // 枫木虎皮纹
          const flame = Math.abs(Math.sin(u * 26 + noise(u * 2.2) * 2.0));
          col = mix(col, light, Math.pow(flame, 3) * 0.42);
          const flame2 = Math.abs(Math.sin(v * 7.5 + 1.2));
          col = mix(col, dark, flame2 * 0.05);
        }
        const i = (y * W + x) * 4;
        d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);

    if (o.planks) {                              // 地板板条
      const n = o.planks;
      const step = H / n;
      for (let i = 0; i <= n; i++) {
        g.fillStyle = 'rgba(20,10,4,0.45)';
        g.fillRect(0, i * step - 1, W, 2);
      }
      for (let i = 0; i < n; i++) {
        const off = (i % 2 ? 0.5 : 0) * W;
        g.fillStyle = 'rgba(20,10,4,0.35)';
        g.fillRect((off + 0.31 * W) % W, i * step, 2, step);
      }
    }
    if (o.gloss) {                               // 漆面高光条（隐约的反射感）
      const grd = g.createLinearGradient(0, 0, 0, H);
      grd.addColorStop(0, 'rgba(255,235,200,0.06)');
      grd.addColorStop(0.5, 'rgba(255,255,255,0.02)');
      grd.addColorStop(1, 'rgba(0,0,0,0.05)');
      g.fillStyle = grd;
      g.fillRect(0, 0, W, H);
    }
    return toTex(c, o.repX || 1, o.repY || 1);
  };

  /* ----------------------------------------------------------- 墙面 */
  TX.wall = function (o) {
    o = o || {};
    const W = 256, H = 256;
    const c = makeCanvas(W, H);
    if (!c) return null;
    const g = c.getContext('2d');
    g.fillStyle = o.color || '#e4d3b6';
    g.fillRect(0, 0, W, H);
    const img = g.getImageData(0, 0, W, H);
    const d = img.data;
    const n = MX.fbm1(o.seed || 3, 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = (n(x / 9 + y / 7) - 0.5) * 22;
        const i = (y * W + x) * 4;
        d[i] = MX.clamp(d[i] + v, 0, 255);
        d[i + 1] = MX.clamp(d[i + 1] + v * 0.95, 0, 255);
        d[i + 2] = MX.clamp(d[i + 2] + v * 0.85, 0, 255);
      }
    }
    g.putImageData(img, 0, 0);
    return toTex(c, o.repX || 6, o.repY || 4);
  };

  /* --------------------------------------------------------- 桌垫 */
  TX.pad = function (o) {
    o = o || {};
    const W = 256, H = 256;
    const c = makeCanvas(W, H);
    if (!c) return null;
    const g = c.getContext('2d');
    g.fillStyle = o.color || '#232a26';
    g.fillRect(0, 0, W, H);
    const img = g.getImageData(0, 0, W, H);
    const d = img.data;
    const n = MX.fbm1(o.seed || 11, 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const weave = ((x >> 1) + (y >> 1)) % 2 ? 6 : -6;
        const v = weave + (n(x / 3.3 + y / 2.7) - 0.5) * 14;
        const i = (y * W + x) * 4;
        d[i] = MX.clamp(d[i] + v, 0, 255);
        d[i + 1] = MX.clamp(d[i + 1] + v, 0, 255);
        d[i + 2] = MX.clamp(d[i + 2] + v, 0, 255);
      }
    }
    g.putImageData(img, 0, 0);
    return toTex(c, o.repX || 1, o.repY || 1);
  };

  /* --------------------------------------------------------- 绒布 */
  TX.velvet = function (o) {
    o = o || {};
    const W = 128, H = 128;
    const c = makeCanvas(W, H);
    if (!c) return null;
    const g = c.getContext('2d');
    g.fillStyle = o.color || '#3a2a44';
    g.fillRect(0, 0, W, H);
    const n = MX.fbm1(o.seed || 5, 3);
    const img = g.getImageData(0, 0, W, H), d = img.data;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = (n(x / 2.1 + y / 1.7) - 0.5) * 30;
      const i = (y * W + x) * 4;
      d[i] = MX.clamp(d[i] + v, 0, 255);
      d[i + 1] = MX.clamp(d[i + 1] + v, 0, 255);
      d[i + 2] = MX.clamp(d[i + 2] + v, 0, 255);
    }
    g.putImageData(img, 0, 0);
    return toTex(c, o.repX || 2, o.repY || 2);
  };

  /* --------------------------------------------------------- 海报 */
  function posterBase(W, H, bg1, bg2) {
    const c = makeCanvas(W, H);
    if (!c) return null;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, W * 0.4, H);
    grd.addColorStop(0, bg1);
    grd.addColorStop(1, bg2);
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);
    return { c: c, g: g };
  }

  /** 一号海报：五线谱 + 大大的 ♪ */
  TX.posterA = function () {
    const W = 384, H = 512;
    const b = posterBase(W, H, '#f6efe1', '#e2d2b4');
    if (!b) return null;
    const g = b.g;
    g.fillStyle = '#2b2b34';
    g.font = 'bold 54px sans-serif';
    g.fillText('弦乐', 34, 84);
    g.font = 'bold 38px sans-serif';
    g.fillText('四根弦的物理', 34, 132);
    // 五线谱
    g.strokeStyle = 'rgba(40,40,50,0.55)';
    g.lineWidth = 2;
    for (let i = 0; i < 5; i++) {
      const y = 210 + i * 16;
      g.beginPath(); g.moveTo(32, y); g.lineTo(W - 32, y); g.stroke();
    }
    g.fillStyle = '#1d1d24';
    const notes = [[0, 300], [1, 320], [2, 300], [2, 330], [3, 290], [4, 310], [5, 280], [6, 300]];
    notes.forEach(function (n, i) {
      const x = 60 + i * 34;
      const y = 250 - n[1] * 0.28;
      g.beginPath(); g.ellipse(x, y, 7, 5, -0.4, 0, Math.PI * 2); g.fill();
      g.fillRect(x + 6, y - 34, 2, 34);
    });
    g.fillStyle = '#8c2f39';
    g.font = 'bold 76px serif';
    g.fillText('♪', 34, 470);
    g.fillStyle = 'rgba(30,30,40,0.75)';
    g.font = '22px sans-serif';
    g.fillText('粗细 · 长短 · 松紧', 150, 452);
    return toTex(c_finish(b.c), 1, 1);
  };

  /** 二号海报：音域对照 */
  TX.posterB = function () {
    const W = 512, H = 384;
    const b = posterBase(W, H, '#20242e', '#0e1018');
    if (!b) return null;
    const g = b.g;
    g.fillStyle = '#efe6d2';
    g.font = 'bold 40px sans-serif';
    g.fillText('越大 · 越低', 32, 70);
    const rows = [
      ['小提琴', 'G3 D4 A4 E5', '#e8c07a'],
      ['中提琴', 'C3 G3 D4 A4', '#e39a6a'],
      ['大提琴', 'C2 G2 D3 A3', '#d97a6a']
    ];
    rows.forEach(function (r, i) {
      const y = 150 + i * 78;
      g.fillStyle = r[2];
      g.fillRect(32, y - 26, 14, 34);
      g.fillStyle = '#f4ecdc';
      g.font = 'bold 30px sans-serif';
      g.fillText(r[0], 62, y);
      g.fillStyle = 'rgba(240,236,220,0.8)';
      g.font = '26px monospace';
      g.fillText(r[1], 200, y);
    });
    g.strokeStyle = 'rgba(240,236,220,0.25)';
    g.lineWidth = 2;
    g.strokeRect(16, 16, W - 32, H - 32);
    return toTex(b.c, 1, 1);
  };

  function c_finish(c) { return c; }

  /* ------------------------------------------------------- 乐谱纸 */
  TX.sheet = function (title) {
    const W = 512, H = 680;
    const c = makeCanvas(W, H);
    if (!c) return null;
    const g = c.getContext('2d');
    g.fillStyle = '#fbf6e9';
    g.fillRect(0, 0, W, H);
    const img = g.getImageData(0, 0, W, H), d = img.data;
    const n = MX.fbm1(21, 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = (n(x / 5.5 + y / 4.5) - 0.5) * 12;
      const i = (y * W + x) * 4;
      d[i] = MX.clamp(d[i] + v, 0, 255);
      d[i + 1] = MX.clamp(d[i + 1] + v, 0, 255);
      d[i + 2] = MX.clamp(d[i + 2] + v, 0, 255);
    }
    g.putImageData(img, 0, 0);
    g.fillStyle = 'rgba(60,50,40,0.85)';
    g.font = 'bold 40px serif';
    g.fillText(title || '曲 集', 44, 76);
    g.strokeStyle = 'rgba(60,50,40,0.35)';
    g.lineWidth = 3;
    g.beginPath(); g.moveTo(44, 96); g.lineTo(W - 44, 96); g.stroke();
    // 五线谱（六行）
    g.strokeStyle = 'rgba(70,60,50,0.55)';
    g.lineWidth = 1.6;
    for (let s = 0; s < 6; s++) {
      const top = 140 + s * 82;
      for (let i = 0; i < 5; i++) {
        const y = top + i * 11;
        g.beginPath(); g.moveTo(48, y); g.lineTo(W - 48, y); g.stroke();
      }
      if (s % 2 === 0) {                          // 高音谱号位置画个小圈
        g.fillStyle = 'rgba(70,60,50,0.7)';
        g.font = '34px serif';
        g.fillText('𝄞', 50, top + 30);
      }
      // 音符
      g.fillStyle = 'rgba(70,60,50,0.75)';
      for (let i = 0; i < 9; i++) {
        const x = 120 + i * 40;
        const y = top + 10 + ((i * 3 + s) % 5) * 11;
        g.beginPath(); g.ellipse(x, y, 5.5, 4, -0.35, 0, Math.PI * 2); g.fill();
        g.fillRect(x + 4.5, y - 26, 1.8, 26);
      }
    }
    return toTex(c, 1, 1);
  };

  /** 桌面上的贴纸标签（"备弦盒"之类） */
  TX.label = function (text, color) {
    const W = 256, H = 96;
    const c = makeCanvas(W, H);
    if (!c) return null;
    const g = c.getContext('2d');
    g.fillStyle = '#f6efdd';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = color || '#8a6a3a';
    g.lineWidth = 5;
    g.strokeRect(6, 6, W - 12, H - 12);
    g.fillStyle = color || '#6a4a26';
    g.font = 'bold 44px sans-serif';
    g.textAlign = 'center';
    g.fillText(text, W / 2, H / 2 + 16);
    return toTex(c, 1, 1);
  };

  global.TX = TX;
  if (typeof module !== 'undefined' && module.exports) module.exports = TX;
})(typeof window !== 'undefined' ? window : globalThis);
