/* =========================================================================
 * room.js —— 琴房：房间、大木桌、桌垫、备弦盒、乐谱纸、海报、谱架
 * 单位统一用 mm（和小提琴的尺寸同一个尺度），离线程序化贴图。
 * ========================================================================= */
(function (global) {
  'use strict';

  const T = global.THREE;
  const MX = global.MX;
  const ROOM = {};

  const TABLE_TOP_Y = 760;

  function mat(color, opts) {
    opts = opts || {};
    return new T.MeshPhongMaterial({
      color: color,
      shininess: opts.shininess === undefined ? 26 : opts.shininess,
      specular: opts.specular === undefined ? 0x2f2a24 : opts.specular,
      side: opts.side || T.FrontSide,
      map: opts.map || null
    });
  }

  ROOM.TABLE_TOP_Y = TABLE_TOP_Y;

  ROOM.build = function (ctx) {
    ctx = ctx || {};
    const TXm = global.TX || {};
    const group = new T.Group();
    group.name = 'room';

    /* ------------------------------------------------------------ 房间 */
    const floorTex = TXm.wood ? TXm.wood({
      base: '#9a7048', light: '#c49a6a', dark: '#5c3d22', fig: 0,
      seed: 41, size: 512, planks: 6, contrast: 1.3, repX: 6, repY: 6
    }) : null;
    const floor = new T.Mesh(new T.PlaneGeometry(7000, 7000),
      mat(0xb08a5c, { map: floorTex, shininess: 10 }));
    floor.rotation.x = -Math.PI / 2;
    floor.name = 'floor';
    group.add(floor);

    const wallTex = TXm.wall ? TXm.wall({ color: '#e3d2b4', seed: 3, repX: 5, repY: 3 }) : null;
    const wallMat = mat(0xe6d6ba, { map: wallTex, shininess: 6, specular: 0x1c1a16 });
    const wallDefs = [
      { pos: [0, 1400, -3500], rot: [0, 0, 0] },
      { pos: [0, 1400, 3500], rot: [0, Math.PI, 0] },
      { pos: [-3500, 1400, 0], rot: [0, Math.PI / 2, 0] },
      { pos: [3500, 1400, 0], rot: [0, -Math.PI / 2, 0] }
    ];
    wallDefs.forEach(function (d) {
      const w = new T.Mesh(new T.PlaneGeometry(7000, 2800), wallMat);
      w.position.set(d.pos[0], d.pos[1], d.pos[2]);
      w.rotation.set(d.rot[0], d.rot[1], d.rot[2]);
      group.add(w);
    });
    const ceiling = new T.Mesh(new T.PlaneGeometry(7000, 7000), mat(0xf0e6d2, { shininess: 4 }));
    ceiling.position.y = 2800;
    ceiling.rotation.x = Math.PI / 2;
    group.add(ceiling);

    /* ----------------------------------------------------------- 窗 */
    const winFrame = new T.Mesh(new T.BoxGeometry(1900, 1400, 90), mat(0x6b4a2a, { shininess: 40 }));
    winFrame.position.set(-3500 + 40, 1650, -900);
    winFrame.rotation.y = Math.PI / 2;
    group.add(winFrame);
    const winGlass = new T.Mesh(new T.PlaneGeometry(1750, 1250), new T.MeshBasicMaterial({
      color: 0xf7f0dc
    }));
    winGlass.position.set(-3500 + 95, 1650, -900);
    winGlass.rotation.y = Math.PI / 2;
    winGlass.name = 'window-glow';
    group.add(winGlass);
    const mullion = new T.Mesh(new T.BoxGeometry(60, 1250, 60), mat(0x6b4a2a, { shininess: 40 }));
    mullion.position.set(-3500 + 92, 1650, -900);
    mullion.rotation.y = Math.PI / 2;
    group.add(mullion);

    /* --------------------------------------------------------- 海报 */
    const posA = TXm.posterA ? TXm.posterA() : null;
    const posB = TXm.posterB ? TXm.posterB() : null;
    const pA = new T.Mesh(new T.PlaneGeometry(560, 760),
      new T.MeshPhongMaterial({ map: posA, color: 0xffffff, shininess: 8, side: T.DoubleSide }));
    pA.position.set(-1250, 1750, -3490);
    pA.name = 'poster-a';
    group.add(pA);
    const pB = new T.Mesh(new T.PlaneGeometry(900, 660),
      new T.MeshPhongMaterial({ map: posB, color: 0xffffff, shininess: 8, side: T.DoubleSide }));
    pB.position.set(1350, 1820, -3490);
    pB.name = 'poster-b';
    group.add(pB);

    /* ---------------------------------------------------------- 大木桌 */
    const tableTex = TXm.wood ? TXm.wood({
      base: '#c99a63', light: '#e8c99b', dark: '#8a5c33', fig: 0,
      seed: 61, size: 512, grain: 30, contrast: 1.15, repX: 1, repY: 1
    }) : null;
    // 桌面提亮：真机截图里桌面太暗，黑弦钮压在深色木头上根本看不清
    const tableMat = mat(0xd9b083, { map: tableTex, shininess: 30, specular: 0x5a4a36 });
    const tableTop = new T.Mesh(new T.BoxGeometry(1900, 70, 1050), tableMat);
    tableTop.position.set(0, TABLE_TOP_Y - 35, 250);
    tableTop.name = 'table-top';
    group.add(tableTop);
    const legMat = mat(0xa87c4e, { map: tableTex, shininess: 18 });
    [[-820, -300], [820, -300], [-820, 800], [820, 800]].forEach(function (p) {
      const leg = new T.Mesh(new T.BoxGeometry(90, TABLE_TOP_Y - 70, 90), legMat);
      leg.position.set(p[0], (TABLE_TOP_Y - 70) / 2, p[1] + 250);
      group.add(leg);
    });
    // 桌裙
    const apron = new T.Mesh(new T.BoxGeometry(1820, 90, 970), legMat);
    apron.position.set(0, TABLE_TOP_Y - 110, 250);
    group.add(apron);

    // 桌垫从"近黑"改成中灰绿：弦、弦钮这些深色细节才压得住
    const padTex = TXm.pad ? TXm.pad({ color: '#57614f', seed: 11 }) : null;
    const pad = new T.Mesh(new T.BoxGeometry(1500, 10, 840),
      mat(0x6d7a66, { map: padTex, shininess: 8, specular: 0x2a3028 }));
    pad.position.set(0, TABLE_TOP_Y + 5, 250);
    pad.name = 'desk-pad';
    group.add(pad);

    /* ------------------------------------------------------- 备弦盒 */
    const trayGroup = new T.Group();
    trayGroup.name = 'tray';
    trayGroup.position.set(720, TABLE_TOP_Y + 10, -20);
    const velTex = TXm.velvet ? TXm.velvet({ color: '#3a2a44', seed: 5 }) : null;
    const trayBody = new T.Mesh(new T.BoxGeometry(330, 46, 190),
      mat(0x5a3a22, { map: tableTex, shininess: 26 }));
    trayBody.position.y = 23;
    trayGroup.add(trayBody);
    const trayVoid = new T.Mesh(new T.BoxGeometry(290, 40, 150),
      mat(0x2e2338, { map: velTex, shininess: 4 }));
    trayVoid.position.y = 30;
    trayGroup.add(trayVoid);
    // 四卷弦：立着插在绒布槽里
    const coils = [];
    for (let i = 0; i < 4; i++) {
      const r = 0.5 * (ctx.stringDia ? ctx.stringDia[i] : 2.4) + 1.0;
      const coil = new T.Mesh(new T.TorusGeometry(26, Math.max(1.6, r), 8, 22),
        new T.MeshPhongMaterial({ color: ctx.stringColors ? ctx.stringColors[i] : 0xc8b280, shininess: 90, specular: 0x8f8a7c }));
      coil.position.set(-108 + i * 72, 70, 0);
      coil.rotation.set(-0.26, 0, 0);          // 立着插在绒布槽里
      coil.name = 'coil-' + i;
      coil.userData.coilIndex = i;
      trayGroup.add(coil);
      // 同样给一个看不见的大一圈的碰撞球：弦卷本身只有几十毫米粗
      const hit = new T.Mesh(new T.SphereGeometry(34, 10, 8),
        new T.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
      hit.position.copy(coil.position);
      hit.name = 'coil-hit';
      hit.userData.coilIndex = i;
      hit.userData.aimRadius = 34;
      trayGroup.add(hit);
      coil.userData.hitProxy = hit;
      coils.push(coil);
    }
    const trayLabel = new T.Mesh(new T.PlaneGeometry(150, 56),
      new T.MeshPhongMaterial({ map: TXm.label ? TXm.label('备 弦') : null, color: TXm.label ? 0xffffff : 0xd8c8a8, shininess: 6, side: T.DoubleSide }));
    trayLabel.position.set(0, 22, -95.4);
    trayLabel.rotation.set(0, Math.PI, 0);
    trayGroup.add(trayLabel);
    group.add(trayGroup);

    /* -------------------------------------------------------- 乐谱纸 */
    const sheetTex = TXm.sheet ? TXm.sheet('曲 集') : null;
    const sheet = new T.Mesh(new T.PlaneGeometry(320, 430),
      new T.MeshPhongMaterial({ map: sheetTex, color: sheetTex ? 0xffffff : 0xf6efdd, shininess: 6, side: T.DoubleSide }));
    sheet.rotation.x = -Math.PI / 2;
    sheet.position.set(-720, TABLE_TOP_Y + 12, 60);
    sheet.name = 'sheet';
    group.add(sheet);

    /* --------------------------------------------------------- 谱架 */
    const standGroup = new T.Group();
    standGroup.name = 'stand';
    standGroup.position.set(-1850, 0, -1500);
    const legMat2 = mat(0x2a2a2e, { shininess: 60, specular: 0x545454 });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * MX.TAU;
      const leg = new T.Mesh(new T.CylinderGeometry(14, 14, 950, 8), legMat2);
      leg.position.set(Math.cos(a) * 120, 470, Math.sin(a) * 120);
      leg.rotation.z = Math.cos(a) * 0.16;
      leg.rotation.x = -Math.sin(a) * 0.16;
      standGroup.add(leg);
    }
    const column = new T.Mesh(new T.CylinderGeometry(18, 18, 1150, 10), legMat2);
    column.position.y = 1000;
    standGroup.add(column);
    const board = new T.Mesh(new T.BoxGeometry(560, 400, 20), mat(0x22222a, { shininess: 30 }));
    board.position.set(0, 1520, -30);
    board.rotation.x = -0.42;
    board.name = 'stand-board';
    standGroup.add(board);
    // 谱架上的谱纸
    const boardSheet = new T.Mesh(new T.PlaneGeometry(420, 300),
      new T.MeshPhongMaterial({ map: sheetTex, color: sheetTex ? 0xffffff : 0xf6efdd, shininess: 6, side: T.DoubleSide }));
    boardSheet.position.set(0, 1522, -16);
    boardSheet.rotation.x = -Math.PI / 2 - 0.42;
    boardSheet.rotateOnWorldAxis(new T.Vector3(0, 1, 0), 0);
    standGroup.add(boardSheet);
    group.add(standGroup);

    /* --------------------------------------------------------- 椅子 */
    const chair = new T.Group();
    chair.name = 'chair';
    chair.position.set(2300, 0, -900);
    chair.rotation.y = -0.5;
    const woodMat = mat(0x7a4c26, { map: tableTex, shininess: 24 });
    const seat = new T.Mesh(new T.BoxGeometry(430, 46, 430), woodMat);
    seat.position.y = 460;
    chair.add(seat);
    const back = new T.Mesh(new T.BoxGeometry(430, 90, 40), woodMat);
    back.position.set(0, 900, -195);
    chair.add(back);
    [[-180, -180], [180, -180], [-180, 180], [180, 180]].forEach(function (p) {
      const l = new T.Mesh(new T.BoxGeometry(46, 460, 46), woodMat);
      l.position.set(p[0], 230, p[1]);
      chair.add(l);
    });
    group.add(chair);

    /* ----------------------------------------------------------- 灯 */
    // 真机截图里发现：只靠"窗光 + 冷补光"时，桌子/地板那一半画面偏暗，
    // 手持乐器时琴身也发闷。这里把主光、补光和半球光都提一点，
    // 并给相机方向补一盏很弱的灯，保证"低头看琴"时乐器是亮的。
    const key = new T.DirectionalLight(0xfff0d6, 1.18);
    key.position.set(-3200, 2600, -2400);
    key.name = 'key-light';
    group.add(key);
    const fill = new T.DirectionalLight(0xbcd6ff, 0.52);
    fill.position.set(2600, 1500, 1800);
    group.add(fill);
    const hemi = new T.HemisphereLight(0xfff2df, 0x6b5540, 0.72);
    group.add(hemi);
    const cam = new T.DirectionalLight(0xfff4e2, 0.34);      // 跟着相机走的补光
    cam.name = 'camera-fill';
    group.add(cam);
    group.userData.cameraFill = cam;

    return {
      group: group,
      tableTopY: TABLE_TOP_Y,
      tray: trayGroup,
      coils: coils,
      sheet: sheet,
      cameraFill: cam,
      tableSize: [1900, 1050],
      tableCenter: [0, 250]
    };
  };

  global.ROOM = ROOM;
  if (typeof module !== 'undefined' && module.exports) module.exports = ROOM;
})(typeof window !== 'undefined' ? window : globalThis);
