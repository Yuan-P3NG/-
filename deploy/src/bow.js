/* =========================================================================
 * bow.js —— 琴弓
 *
 * 弓杆（带反曲的锥形杆）、弓尖（琴头）、马尾库（frog）、螺丝、马尾（扁带）。
 * 弓挂在琴的局部坐标里：弓的世界矩阵 = 琴的世界矩阵 × 弓的局部位姿，
 * 所以运弓、把琴拿起来、换乐器这些事全都自动跟上。
 * ========================================================================= */
(function (global) {
  'use strict';

  const T = global.THREE;
  const MX = global.MX;
  const BOW = {};

  BOW.build = function (inst) {
    const spec = inst.spec;
    const S = spec.L / 356;
    const LEN = (spec.id === 'cello' ? 720 : 745) * (spec.id === 'viola' ? 0.995 : 1);
    const hairW = (spec.id === 'cello' ? 13 : spec.id === 'viola' ? 9.5 : 8.4) * 1.0;
    // 弓"长"是跟着乐器走的（大提琴弓也是 72cm），但弓杆的粗细几乎不跟着变：
    // 大提琴和小提琴的弓杆直径只差一两毫米，所以截面用 TH（缓和的缩放），
    // 只有长度用 S。之前整把按 S 放大，大提琴的弓粗得像根棍子。
    const TH = 1 + (S - 1) * 0.25;
    const hairDrop = 11.0 * TH;              // 马尾到弓杆轴线的距离
    const grp = new T.Group();
    grp.name = 'bow';

    const matStick = new T.MeshPhongMaterial({
      color: 0x8a4a24, shininess: 70, specular: 0x6b4a2a, side: T.DoubleSide
    });
    const matHair = new T.MeshPhongMaterial({
      color: 0xf2ead6, shininess: 12, specular: 0x8a8272, side: T.DoubleSide
    });
    const matFrog = new T.MeshPhongMaterial({
      color: 0x1a1512, shininess: 40, specular: 0x35291f, side: T.DoubleSide
    });
    const matMetal = new T.MeshPhongMaterial({
      color: 0xcfc6b0, shininess: 150, specular: 0xb8b2a4, side: T.DoubleSide
    });

    /* ------------------------------------------------------- 弓杆 */
    // 沿 x 从 -LEN/2（马尾库）到 +LEN/2（弓尖），杆身向上微拱（camber）
    const stickRings = [];
    const nStick = 26;
    for (let i = 0; i < nStick; i++) {
      const t = i / (nStick - 1);
      const x = MX.lerp(-LEN * 0.5, LEN * 0.5, t);
      // 马尾库侧粗、弓尖侧细
      const r = MX.lerp(5.2, 2.9, Math.pow(t, 0.85)) * TH;
      const camber = Math.sin(Math.PI * t) * 7 * TH;
      const ring = [];
      const nS = 8;
      for (let j = 0; j < nS; j++) {
        const a = (j / nS) * MX.TAU;
        ring.push([x, camber + Math.sin(a) * r, Math.cos(a) * r]);
      }
      stickRings.push(ring);
    }
    const stick = new T.Mesh(MX.meshFromRings(stickRings, { closedRing: true }), matStick);
    stick.name = 'bow-stick';
    grp.add(stick);

    /* ------------------------------------------------------- 弓尖 */
    const head = new T.Mesh(new T.BoxGeometry(LEN * 0.075, 17 * TH, 9 * TH), matStick);
    head.position.set(LEN * 0.5 - LEN * 0.030, 7 * TH - 4 * TH, 0);
    head.name = 'bow-head';
    grp.add(head);
    const headNose = new T.Mesh(new T.BoxGeometry(LEN * 0.055, 9 * TH, 9 * TH), matStick);
    headNose.position.set(LEN * 0.5 - LEN * 0.012, 4 * TH, 0);
    grp.add(headNose);

    /* --------------------------------------------- 马尾库（frog）+ 螺丝 */
    const frog = new T.Mesh(new T.BoxGeometry(LEN * 0.075, 24 * TH, 11 * TH), matFrog);
    frog.position.set(-LEN * 0.5 + LEN * 0.030, -4 * TH, 0);
    frog.name = 'bow-frog';
    grp.add(frog);
    const heel = new T.Mesh(new T.BoxGeometry(LEN * 0.045, 30 * TH, 11 * TH), matFrog);
    heel.position.set(-LEN * 0.5 + LEN * 0.016, -8 * TH, 0);
    grp.add(heel);
    const ferrule = new T.Mesh(new T.BoxGeometry(5 * TH, 12 * TH, 12.5 * TH), matMetal);
    ferrule.position.set(-LEN * 0.5 + LEN * 0.062, -9 * TH, 0);
    grp.add(ferrule);
    const button = new T.Mesh(new T.CylinderGeometry(5.0 * TH, 4.6 * TH, 16 * TH, 12), matMetal);
    button.rotation.z = Math.PI / 2;
    button.position.set(-LEN * 0.5 - 6 * TH, 3 * TH, 0);
    button.name = 'bow-button';
    grp.add(button);

    /* ------------------------------------------------------- 马尾 */
    const hair = (function () {
      const x0 = -LEN * 0.5 + LEN * 0.066, x1 = LEN * 0.5 - LEN * 0.032;
      const y0 = -hairDrop - 3 * TH, y1 = -hairDrop + 6 * TH;
      const rings = [];
      const n = 16;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const x = MX.lerp(x0, x1, t);
        const y = MX.lerp(y0, y1, t);
        const ring = [];
        const nS = 8;
        for (let j = 0; j < nS; j++) {
          const a = (j / nS) * MX.TAU;
          // 扁带：横向宽、上下薄
          ring.push([x, y + Math.sin(a) * 0.9 * TH, Math.cos(a) * hairW * 0.5]);
        }
        rings.push(ring);
      }
      const m = new T.Mesh(MX.meshFromRings(rings, { closedRing: true }), matHair);
      m.name = 'bow-hair';
      return m;
    })();
    grp.add(hair);

    // 弓的碰撞范围（马尾很细，瞄准它太费劲）：弓杆中段一个看不见的盒子
    const hit = new T.Mesh(
      new T.BoxGeometry(LEN * 0.72, 26 * TH, 26 * TH),
      new T.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    hit.position.set(0, -4 * TH, 0);
    hit.name = 'bow-hit';
    hit.userData.bowHit = true;
    hit.userData.aimRadius = 40 * TH;
    grp.add(hit);

    // 握弓的手也不建模：第一人称里只留琴和弓（按需求）

    /* ------------------------------------------------- 接口：贴弦 */
    const api = {
      group: grp, length: LEN, hairWidth: hairW,
      hairDrop: hairDrop,
      /** 把弓摆成"贴在某个点上"的姿势（点在琴的局部坐标里，弓横过弦） */
      placeAt: function (point, opts) {
        opts = opts || {};
        const stroke = opts.stroke || 0;            // 运弓行程（沿弓杆方向，mm）
        // 弓杆本地方向就是 x（长度）；马尾在 -y 侧，所以要把弓杆抬起来，
        // 让马尾正好落在弦上。弓横过琴弦 = 弓杆沿琴的 x 方向，不需要额外旋转。
        // flip = 让"弓根（握弓的手）"落在演奏者的右手边，和实拍第一视角一致。
        const flip = opts.flip !== false;
        grp.position.set(point.x + stroke, point.y + hairDrop, point.z);
        grp.rotation.set(
          opts.roll === undefined ? 0.13 : opts.roll,      // 弓杆绕自身转一点（马尾不是完全垂直压弦）
          (opts.yaw === undefined ? 0.52 : opts.yaw) + (flip ? Math.PI : 0),
          opts.tilt === undefined ? -0.12 : opts.tilt      // 一端略高
        );
      }
    };
    return api;
  };

  global.BOW = BOW;
  if (typeof module !== 'undefined' && module.exports) module.exports = BOW;
})(typeof window !== 'undefined' ? window : globalThis);
