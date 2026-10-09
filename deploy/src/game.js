/* =========================================================================
 * game.js —— 流程状态机 + 第一人称控制 + 交互
 *
 * 四个教学阶段严格按顺序：
 *   0 选乐器（这一次点击同时解锁浏览器音频）
 *   1 装弦（四卷弦，顺序不限，弦从系弦板拉到弦钮并绕两圈）
 *   2 调音（按住左键左右移动鼠标转弦轴 = 连续滑音；空格听标准音；±10 音分锁定）
 *   3 上弓（拿起琴弓，选一个触弦点，三个位置音色真的不一样）
 *   4 演奏（F 拿起琴，1..= 十二个半音；准星沿弦前后滑 = 换触弦点；点乐谱跟弹）
 * ========================================================================= */
(function () {
  'use strict';

  const T = window.THREE;
  const MX = window.MX;
  const VIO = window.VIO;
  const BOW = window.BOW;
  const ROOM = window.ROOM;
  const SCORE = window.SCORE;
  const AUDIO = window.AUDIO;

  const PHASE = { SELECT: 0, STRING: 1, TUNE: 2, BOW: 3, PLAY: 4 };
  const ORDER = ['violin', 'viola', 'cello'];
  const HOLD_POSE = {
    violin: {
      pos: [-62, -145, -435],
      neck: [-0.54, 0.20, -0.81],
      normal: [0.12, 0.90, 0.42],
      pitch: -0.30
    },
    viola: {
      pos: [-66, -160, -460],
      neck: [-0.52, 0.20, -0.82],
      normal: [0.12, 0.90, 0.42],
      pitch: -0.30
    },
    cello: {
      // 大提琴的第一人称：从上往下俯视，琴颈朝左下（近）、琴马在右上（远），
      // 面板整块对着视线，弓横着走 —— 和实拍的第一视角一致。
      // 琴颈再凑近镜头：位置整体拉近一点，同时让琴颈更朝观众（+z）一点
      pos: [20, -135, -860],
      neck: [-0.51, -0.29, 0.81],
      normal: [0.08, 0.80, 0.58],
      pitch: -0.62
    }
  };

  const G = {
    phase: PHASE.SELECT,
    instId: 'violin',
    inst: null, bow: null, room: null,
    renderer: null, scene: null, camera: null,
    tablePose: null, holdQuat: null,
    hold: 0, holdTarget: 0,
    yaw: Math.PI, pitch: -0.20,          // 站着面向桌子（+z 方向）
    yawT: Math.PI, pitchT: -0.20,        // 目标角度：鼠标只改目标，实际角度平滑贴过去
    pitchAuto: 0,
    lockIgnoreUntil: 0,
    pos: new T.Vector3(0, 1520, -1150),  // 站得离桌子近一点（小零件才点得准）
    move: { f: 0, b: 0, l: 0, r: 0 },
    locked: false, invert: false,
    time: 0, lastT: 0, fpsAcc: 0, fpsN: 0,
    tuning: { freq: [], cents: [], locked: [], active: -1, dragging: false, lastX: 0 },
    bowHeld: false, contact: 0.5, contactTried: [false, false, false],
    hotspots: [], contactSpheres: [],
    score: null, scoreNotes: null, scoreStep: 0, autoPlay: null,
    playedCount: 0, resultShown: false,
    bowAnim: 0, bowNote: -1, bowing: -1,
    toastT: 0, hint: '', dirtyHud: true
  };
  window.GAME = G;

  /* ------------------------------------------------------------ 小工具 */
  const $ = function (id) { return document.getElementById(id); };
  function toast(text, ms) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(G.toastT);
    G.toastT = setTimeout(function () { el.classList.remove('on'); }, ms || 1800);
  }
  function centsOf(freq, target) { return 1200 * Math.log2(freq / target); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function quatFromDirs(neckDir, normalDir) {
    const z = new T.Vector3(neckDir[0], neckDir[1], neckDir[2]).normalize();
    const y = new T.Vector3(normalDir[0], normalDir[1], normalDir[2]);
    y.addScaledVector(z, -y.dot(z)).normalize();
    const x = new T.Vector3().crossVectors(y, z).normalize();
    const m = new T.Matrix4().makeBasis(x, y, z);
    return new T.Quaternion().setFromRotationMatrix(m);
  }

  /* ------------------------------------------------------------ 初始化 */
  function init() {
    const renderer = new T.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.14;
    $('app').appendChild(renderer.domElement);
    G.renderer = renderer;

    const scene = new T.Scene();
    scene.background = new T.Color(0x1a1512);
    scene.fog = new T.Fog(0x2a2119, 3200, 8600);
    G.scene = scene;

    const camera = new T.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 8, 20000);
    G.camera = camera;
    scene.add(camera);

    // 显卡上下文丢了（切显卡、驱动重置、显存不足）会整片黑屏：
    // 与其让玩家以为"游戏坏了"，不如明确告诉他按 R 重来 / 刷新。
    renderer.domElement.addEventListener('webglcontextlost', function (ev) {
      ev.preventDefault();
      G.contextLost = true;
      toast('显卡上下文丢失了：按 R 重来，或刷新页面（Ctrl+F5）', 6000);
      $('hint').innerHTML = '<b>显卡上下文丢失</b> —— 按 <span class="k">R</span> 重来，或刷新页面';
    });
    renderer.domElement.addEventListener('webglcontextrestored', function () {
      G.contextLost = false;
      toast('显卡上下文已恢复', 2500);
    });

    G.room = ROOM.build({});
    scene.add(G.room.group);

    bindUI();
    window.addEventListener('resize', onResize);
    document.addEventListener('pointerlockchange', onLockChange);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    renderer.domElement.addEventListener('click', function () {
      if (!G.locked && G.phase !== PHASE.SELECT) requestLock();
    });
    $('loading').classList.add('hide');
    requestAnimationFrame(frame);
  }

  function onResize() {
    G.camera.aspect = window.innerWidth / window.innerHeight;
    G.camera.updateProjectionMatrix();
    G.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  /* =====================================================================
   * 建 / 换乐器
   * =================================================================== */
  function loadInstrument(id, opts) {
    opts = opts || {};
    stopNote();                     // 换乐器前先把正在响的音收掉，别让上一把琴继续响
    G.bowing = -1;
    if (G.inst) {
      G.scene.remove(G.inst.group);
    }
    if (G.bow) {
      if (G.bow.group.parent) G.bow.group.parent.remove(G.bow.group);
    }
    G.instId = id;
    const inst = VIO.build(id);
    G.inst = inst;
    G.scene.add(inst.group);
    G.bow = BOW.build(inst);                       // 弓也跟着换尺寸
    G.scene.add(G.bow.group);
    // 备弦盒里的弦卷也跟着换粗细（粗细 ↔ 音高 这件事在盒子里就该看得出来）
    if (G.room && G.room.coils) {
      G.room.coils.forEach(function (coil, k) {
        const dia = inst.spec.strings[k].dia;
        coil.geometry.dispose();
        coil.geometry = new T.TorusGeometry(26 * (inst.spec.L / 356), Math.max(1.6, dia * 0.5 + 1.0), 8, 22);
        coil.material.color.setHex(inst.spec.strings[k].color);
      });
    }
    G.bowHeld = (G.phase >= PHASE.BOW) ? G.bowHeld : false;

    // 桌上摆放：琴尾朝向玩家、琴颈斜向左前方，弓摆在旁边
    const tY = G.room.tableTopY;
    inst.group.position.set(-40, tY - inst.lowestY, 30);
    inst.group.rotation.set(0, MX.deg(-64), 0);
    inst.group.updateMatrixWorld(true);
    // 弓先躺在桌上（等学生阶段 3 把它拿起来）
    if (G.bowHeld) {
      attachBow(true);
      setBowToContact(G.contact);
    } else {
      G.bow.group.position.set(430 * (id === 'cello' ? 1.6 : 1), tY + 13, -260);
      G.bow.group.rotation.set(0, MX.deg(34), 0);
      G.bow.group.scale.set(1, 1, 1);
    }
    G.tablePose = {
      pos: inst.group.position.clone(),
      quat: inst.group.quaternion.clone()
    };
    const pose = HOLD_POSE[id] || HOLD_POSE.violin;
    G.holdLocalPos = new T.Vector3(pose.pos[0], pose.pos[1], pose.pos[2]);
    G.holdQuat = quatFromDirs(pose.neck, pose.normal);
    G.holdPitch = pose.pitch === undefined ? -0.30 : pose.pitch;

    // 弦：一开始是"装好、调准"的状态；教学流程里再退回未装/偏低
    const spec = inst.spec;
    G.tuning.freq = spec.openMidi.map(function (m) { return SCORE.midiToFreq(m); });
    G.tuning.cents = [0, 0, 0, 0];
    G.tuning.centsT = [0, 0, 0, 0];
    G.tuning.locked = [false, false, false, false];
    G.tuning.active = -1;
    AUDIO.setStrings(G.tuning.freq);
    AUDIO.setContact(G.contact);
    renderer_applyScale(id);

    if (opts.fresh !== false) {
      inst.setAllStringsInstalled(0);
      for (let i = 0; i < 4; i++) {
        G.tuning.cents[i] = -500;                       // 都偏低约五个半音
        G.tuning.centsT[i] = -500;
        G.tuning.freq[i] = SCORE.midiToFreq(spec.openMidi[i]) * Math.pow(2, -500 / 1200);
        AUDIO.setFreq(i, G.tuning.freq[i]);
      }
    } else {
      inst.setAllStringsInstalled(1);
      inst.refreshStrings();
    }
    inst.update(0.016);
    updateInstLabel();
  }

  function renderer_applyScale(id) {
    AUDIO.setScale(id === 'cello' ? 0.42 : (id === 'viola' ? 0.78 : 1));
  }

  function updateInstLabel() {
    const spec = VIO.SPECS[G.instId];
    const names = spec.openMidi.map(function (m) { return SCORE.midiToName(m); });
    $('inst').innerHTML = spec.name + '<small>' + names.join(' · ') + ' · 琴身 ' +
      Math.round(spec.L) + 'mm · 简谱 1 = ' + SCORE.midiToName(spec.jianpuBase) + '</small>';
  }

  /* =====================================================================
   * 阶段推进
   * =================================================================== */
  function setPhase(p) {
    if (G.phase === p) return;
    G.phase = p;
    G.dirtyHud = true;
    if (p === PHASE.STRING) {
      toast('先装弦：准星对准弦卷，点左键', 3200);
    } else if (p === PHASE.TUNE) {
      toast('四根弦都偏低，转弦轴把它们调准', 3200);
    } else if (p === PHASE.BOW) {
      buildContactSpheres();
    } else if (p === PHASE.PLAY) {
      G.contactSpheres.forEach(function (s) { s.visible = false; });
      $('btn-switch').classList.remove('hide');
      $('btn-restart').classList.remove('hide');
      setHint();
      // 不再一进演奏阶段就把曲集卡片弹出来盖住画面正中（playtest 清单：
      // 首个可玩画面要以玩为主）。想跟弹自己点桌上的乐谱。
      if (!G.score) toast('想跟谱弹就点桌上的乐谱纸', 3000);
    }
  }

  function allStringsInstalled() {
    return G.inst.strings.every(function (s) { return s.installed > 0.99; });
  }
  function allTuned() {
    return G.tuning.locked[0] && G.tuning.locked[1] && G.tuning.locked[2] && G.tuning.locked[3];
  }

  /* =====================================================================
   * 触弦点热点（阶段 3）
   * =================================================================== */
  function buildContactSpheres() {
    if (G.contactSpheres.length) {
      G.contactSpheres.forEach(function (s) { s.visible = true; });
      return;
    }
    const inst = G.inst;
    // 只写"触弦点"这一个量，弦上位置由 contactToS 换算 —— 黄圈和弓保证落在同一处
    const defs = [
      { name: '靠指板', contact: 0.12 },
      { name: '中间', contact: 0.53 },
      { name: '靠琴桥', contact: 0.88 }
    ];
    defs.forEach(function (d, i) {
      const mat = new T.MeshBasicMaterial({ color: 0xffd777, transparent: true, opacity: 0.42 });
      const mesh = new T.Mesh(new T.SphereGeometry(inst.spec.L * 0.036, 14, 10), mat);
      const pt = inst.stringPointAt(2, contactToS(d.contact));
      mesh.position.copy(pt);
      mesh.renderOrder = 5;
      mesh.userData.contactSpot = i;
      inst.group.add(mesh);
      const ring = new T.Mesh(new T.RingGeometry(inst.spec.L * 0.040, inst.spec.L * 0.050, 22),
        new T.MeshBasicMaterial({ color: 0xffe6a8, transparent: true, opacity: 0.5, side: T.DoubleSide }));
      ring.userData.contactSpot = i;
      ring.position.z = 0.001;
      mesh.add(ring);
      G.contactSpheres.push(mesh);
    });
  }

  /* =====================================================================
   * 交互
   * =================================================================== */
  const ray = new T.Raycaster();
  const center = new T.Vector2(0, 0);
  const tmpDir = new T.Vector3();

  /* =====================================================================
   * 触弦点 ↔ 弦上位置 的唯一映射
   *
   *   contact 0 = 靠指板 → 弦上 0.33（弦长的 1/3 处，β≈1/3，挖掉 3/6/9 次谐波）
   *   contact 1 = 靠琴桥 → 弦上 0.10
   *
   * 弦上位置 s：0 = 琴马，1 = 弦枕。
   * 必须和音频 DSP 里的 β 用同一个映射 —— 之前黄圈用一套数、弓用另一套数，
   * 于是点"靠指板"时弓被送到弦上 0.85（跑到琴颈上去了）。
   * =================================================================== */
  function contactToS(c) { return 0.33 - 0.23 * clamp(c, 0, 1); }
  function sToContact(s) { return clamp((0.33 - s) / 0.23, 0, 1); }
  function contactZoneName(c) {
    if (c < 0.33) return '靠指板（闷而柔）';
    if (c < 0.72) return '中间（均衡）';
    return '靠琴桥（亮而紧）';
  }
  /**
   * 把事件归一化成"物理键位"名字：
   *   Digit1 / Shift+Digit1(="!") → '1'，Minus/'_' → '-'，Equal/'+' → '='，KeyZ → 'z'
   * 这样按不按 Shift 都能正确识别演奏键，也不会出现"按着 Shift 松开却收不了弓"。
   */
  function baseKey(e) {
    const c = e.code || '';
    if (/^Digit[0-9]$/.test(c)) return c.slice(5);
    if (/^Numpad[0-9]$/.test(c)) return c.slice(6);
    if (c === 'Minus' || c === 'NumpadSubtract') return '-';
    if (c === 'Equal' || c === 'NumpadAdd') return '=';
    if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
    if (c === 'Space') return ' ';
    return e.key || '';
  }

  /**
   * 当前阶段可以交互的东西。
   * 返回 { list, aims }：list 给精确射线用；aims 是"宽松瞄准"用的球心 + 半径，
   * 因为弦卷、弦钮杆这些东西在屏幕上只有几十像素，光靠精确射线太考验人了。
   */
  function collectTargets() {
    const list = [], aims = [];
    if (G.phase === PHASE.STRING) {
      G.room.coils.forEach(function (c, i) {
        if (!c.visible) return;
        list.push(c);
        const px = c.userData.hitProxy;
        if (px) { list.push(px); aims.push({ obj: px, kind: 'coil', index: i, radius: 34 }); }
      });
    } else if (G.phase === PHASE.TUNE) {
      G.inst.pegs.forEach(function (p) {
        list.push(p.group);
        if (p.hit) aims.push({ obj: p.hit, kind: 'peg', index: p.index, radius: p.hit.userData.aimRadius || 26 });
      });
    } else if (G.phase === PHASE.BOW) {
      if (!G.bowHeld) {
        list.push(G.bow.group);
        let hit = null;
        G.bow.group.traverse(function (o) { if (o.userData && o.userData.bowHit) hit = o; });
        if (hit) aims.push({ obj: hit, kind: 'bow', index: 0, radius: 150 });
      } else {
        G.contactSpheres.forEach(function (s, i) {
          list.push(s);
          aims.push({
            obj: s, kind: 'spot', index: i,
            radius: G.inst.spec.L * 0.11
          });
        });
      }
    } else if (G.phase === PHASE.PLAY) {
      list.push(G.room.sheet);
      aims.push({ obj: G.room.sheet, kind: 'sheet', index: 0, radius: 220 });
    }
    return { list: list, aims: aims };
  }

  function pick() {
    const targets = collectTargets();
    if (!targets.list.length) return null;
    ray.setFromCamera(center, G.camera);
    const hits = ray.intersectObjects(targets.list, true);
    if (hits.length) {
      const info = describeHit(hits[0].object, hits[0].point);
      if (info) { info.distance = hits[0].distance; return info; }
    }
    // 宽松瞄准：射线离"球心"够近就算瞄准（半径还放宽 1.9 倍）
    const tmp = new T.Vector3();
    let best = null;
    targets.aims.forEach(function (a) {
      a.obj.getWorldPosition(tmp);
      const d = ray.ray.distanceToPoint(tmp);
      if (d > a.radius * 1.9) return;
      const along = tmp.clone().sub(ray.ray.origin).dot(ray.ray.direction);
      if (!best || along < best.along) best = { along: along, aim: a, point: tmp.clone() };
    });
    if (best) {
      const info = describeHit(best.aim.obj, best.point);
      if (info) { info.distance = best.along; info.loose = true; return info; }
    }
    return null;
  }

  /** 从命中的网格往上找它属于哪一类可交互物 */
  function describeHit(obj, point) {
    let o = obj;
    const info = { obj: obj, point: point };
    while (o) {
      if (o.userData) {
        if (o.userData.coilIndex !== undefined) { info.coil = o.userData.coilIndex; return info; }
        if (o.userData.pegIndex !== undefined) { info.peg = o.userData.pegIndex; return info; }
        if (o.userData.contactSpot !== undefined) { info.spot = o.userData.contactSpot; return info; }
        if (o.userData.bowHit) { info.bow = true; return info; }
      }
      if (o.name === 'bow') { info.bow = true; return info; }
      if (o.name === 'sheet') { info.sheet = true; return info; }
      o = o.parent;
    }
    return null;
  }

  /** 准星沿弦滑动 → 触弦点（演奏阶段） */
  function contactFromCrosshair() {
    const inst = G.inst;
    if (!inst) return G.contact;
    ray.setFromCamera(center, G.camera);
    let best = null, bestD = Infinity;
    for (let i = 0; i < 4; i++) {
      const a = inst.stringPointAt(i, 0.02), b = inst.stringPointAt(i, 0.62);
      a.applyMatrix4(inst.group.matrixWorld);
      b.applyMatrix4(inst.group.matrixWorld);
      const seg = new T.Line3(a, b);
      const p = new T.Vector3();
      seg.closestPointToPoint(ray.ray.origin, true, p);
      const d = ray.ray.distanceSqToPoint(p);
      if (d < bestD) { bestD = d; best = { p: p, seg: seg, i: i }; }
    }
    // 准星没落在弦附近就不动（否则人一转视角触弦点就乱跳）。
    // 阈值放宽到 100mm：持琴时弦在屏幕下方，准星能够到的机会本来就少。
    if (!best || bestD > 70 * 70) return G.contact;
    // 参数换算成"离琴马多远"的相对位置
    const local = best.p.clone().applyMatrix4(new T.Matrix4().copy(inst.group.matrixWorld).invert());
    const s = clamp(MX.invLerp(inst.zBridge, inst.zBridge + 0.5 * (inst.zNut - inst.zBridge), local.z), 0, 1);
    return clamp(sToContact(s), 0.03, 1);
  }

  /* =====================================================================
   * 装弦（阶段 1）
   * =================================================================== */
  const installing = [];
  function installString(i) {
    const st = G.inst.strings[i];
    if (st.installed > 0.99) return;
    installing.push({ i: i, t: 0 });
    G.room.coils[i].visible = false;
    toast('装上第 ' + (i + 1) + ' 根弦：' + G.inst.spec.strings[i].name.split('')[0] +
      '（' + (i === 0 ? '最粗，音最低' : i === 3 ? '最细，音最高' : '') + '）', 2200);
    AUDIO.setFreq(i, G.tuning.freq[i]);
    AUDIO.pluck(i, 0.7);
  }

  function updateInstalling(dt) {
    for (let k = installing.length - 1; k >= 0; k--) {
      const it = installing[k];
      it.t += dt / 1.1;
      G.inst.setStringInstalled(it.i, Math.min(1, it.t));
      if (it.t >= 1) {
        installing.splice(k, 1);
        G.inst.setStringInstalled(it.i, 1);
        if (allStringsInstalled() && G.phase === PHASE.STRING) {
          setTimeout(function () {
            if (G.phase === PHASE.STRING) {
              toast('四根弦都装好了 —— 最粗的那根音最低', 2600);
              setPhase(PHASE.TUNE);
            }
          }, 600);
        }
      }
    }
  }

  /* =====================================================================
   * 调音（阶段 2）
   * =================================================================== */
  function tuningStart(i) {
    const st = G.inst.strings[i];
    if (!st || st.installed < 0.99 || G.tuning.locked[i]) return;
    G.tuning.active = i;
    G.tuning.dragging = true;
    G.tuning.lastX = null;
    G.tuning.startCents = G.tuning.cents[i];
    AUDIO.setContact(0.45);
    AUDIO.bowStart(i, G.tuning.freq[i], 0.85);
  }
  function tuningAdjust(dx) {
    const i = G.tuning.active;
    if (i < 0) return;
    // 注意：这里收的是"鼠标移动量"（event.movementX），不是鼠标在屏幕上的坐标。
    // 指针被锁住（pointer lock）之后 clientX 是**不动的**，用坐标差永远算出 0，
    // 于是转弦轴看起来完全没反应 —— 这就是之前调音"左右滑动没反应"的原因。
    // 另外单个事件的位移要限幅：指针锁偶尔会补发一个很大的 movement，
    // 全吃下去音分就会从 -200 直接闪到 +200（用户报的"闪烁"）。
    const d = clamp(dx, -45, 45) * 0.55;
    const T = G.tuning;
    if (!T.centsT) T.centsT = T.cents.slice();
    const cur = T.centsT[i] === undefined ? T.cents[i] : T.centsT[i];
    T.centsT[i] = clamp(cur + d, -700, 700);
  }
  function applyTuning(i) {
    const target = SCORE.midiToFreq(G.inst.spec.openMidi[i]);
    const f = target * Math.pow(2, G.tuning.cents[i] / 1200);
    G.tuning.freq[i] = f;
    AUDIO.setFreq(i, f);
    G.inst.setPegAngle(i, G.tuning.cents[i] * 0.004);
  }
  function tuningEnd() {
    const i = G.tuning.active;
    G.tuning.dragging = false;
    if (i < 0) return;
    AUDIO.bowStop(i);
    const c = G.tuning.cents[i];
    if (Math.abs(c) <= 10 && G.inst.strings[i].installed > 0.99) {
      G.tuning.locked[i] = true;
      if (G.tuning.centsT) G.tuning.centsT[i] = G.tuning.cents[i];   // 锁定的就是当前这个音高
      applyTuning(i);
      AUDIO.reference(SCORE.midiToFreq(G.inst.spec.openMidi[i]), 0.5);
      toast(VIO.SPECS[G.instId].strings[i].name + ' 调准了（' + c.toFixed(0) + ' 音分）', 1800);
      if (allTuned()) {
        setTimeout(function () {
          if (G.phase === PHASE.TUNE) {
            toast('四根弦都调准了，五度定弦就是 G–D–A–E', 3000);
            setPhase(PHASE.BOW);
          }
        }, 900);
      }
    } else {
      toast('还差 ' + Math.abs(c).toFixed(0) + ' 音分，再试试（按住左键左右移动）', 2200);
    }
    G.tuning.active = -1;
  }
  function tuningFine(dir) {
    const i = G.tuning.active >= 0 ? G.tuning.active : nearestTunedPeg();
    if (i < 0 || G.tuning.locked[i]) return;
    G.tuning.cents[i] = clamp(G.tuning.cents[i] + dir * 4, -700, 700);
    G.tuning.centsT[i] = G.tuning.cents[i];
    applyTuning(i);
  }

  /** 音分平滑贴向目标（目标由鼠标位移累加，实际值每帧追上去） */
  function updateTuningSmooth(dt) {
    const T = G.tuning;
    if (!T.centsT) T.centsT = T.cents.slice();
    for (let i = 0; i < 4; i++) {
      if (T.centsT[i] === undefined) T.centsT[i] = T.cents[i];
      // 锁定过的弦不许再动：把目标也拉回当前值，否则平滑会把它慢慢拖回拖动前的旧值
      if (T.locked[i]) { T.centsT[i] = T.cents[i]; continue; }
      const next = MX.damp(T.cents[i], T.centsT[i], 20, dt);
      if (Math.abs(next - T.cents[i]) > 0.01) {
        T.cents[i] = next;
        applyTuning(i);
      }
    }
  }
  function nearestTunedPeg() {
    const info = pick();
    if (info && info.peg !== undefined) return info.peg;
    return -1;
  }

  /* =====================================================================
   * 上弓 / 演奏
   * =================================================================== */
  function pickUpBow() {
    G.bowHeld = true;
    attachBow(true);
    setBowToContact(G.contact);
    toast('拿好弓了：点一个触弦点试试音色', 2400);
  }
  function attachBow(toInstrument) {
    if (!G.bow) return;
    if (toInstrument) {
      if (G.bow.group.parent !== G.inst.group) G.inst.group.add(G.bow.group);
    } else {
      if (G.bow.group.parent !== G.scene) G.scene.add(G.bow.group);
    }
  }
  function setBowToContact(contact) {
    G.contact = clamp(contact, 0, 1);
    AUDIO.setContact(G.contact);
    const inst = G.inst;
    const s = contactToS(G.contact);                     // 和音频里的 β 同一套映射
    const p = inst.stringPointAt(2, s);
    // 弓尖朝演奏者的左手边（和实拍第一视角一致）：看琴的 x 轴在相机里指向哪边
    const xAxis = new T.Vector3(1, 0, 0)
      .applyQuaternion(inst.group.quaternion)
      .applyQuaternion(G.camera.quaternion.clone().invert());
    G.bowFlip = xAxis.x > 0;
    G.bowYaw = 0.52;               // 弓不完全垂直于弦：画面里更好看，也更像真的运弓角度
    G.bow.placeAt(p, { stroke: 0, flip: G.bowFlip, yaw: G.bowYaw });
  }
  function playContactSpot(idx) {
    const spots = [
      { contact: 0.12, name: '靠指板（闷而柔）' },
      { contact: 0.53, name: '中间（均衡）' },
      { contact: 0.88, name: '靠琴桥（亮而紧）' }
    ];
    const d = spots[idx];
    setBowToContact(d.contact);
    if (!G.contactTried[idx]) {
      G.contactTried[idx] = true;
      toast('触弦点：' + d.name, 2200);
    }
    AUDIO.setContact(d.contact);
    AUDIO.bowStart(2, G.tuning.freq[2], 0.85);
    setTimeout(function () { AUDIO.bowStop(2); }, 2200);
    if (G.contactTried.every(function (x) { return x; }) && G.phase === PHASE.BOW) {
      toast('三个位置都听过了 —— 按 F 把琴拿起来演奏', 3200);
    }
  }

  /** 一个音：找弦 + 按弦位置 + 起弓/连弓 */
  function playNote(midi, gain, attack) {
    const inst = G.inst;
    const spec = inst.spec;
    const open = spec.openMidi;
    const asg = SCORE.assign([{ midi: midi, beats: 1, rest: false }], open)[0];
    const i = asg.string;
    const base = G.tuning.freq[i];
    const freq = base * Math.pow(2, asg.pos / 12);
    inst.clearFingers();
    if (asg.pos > 0) inst.setFinger(i, asg.ratio);
    inst.setVibrato(i, 1.0);
    if (G.bowing === i && !attack) {
      AUDIO.bowFreq(i, freq);                        // 同一根弦 + 不要音头 = 连弓，只换按弦位置
    } else {
      if (G.bowing >= 0) AUDIO.bowStop(G.bowing);
      AUDIO.bowStart(i, freq, gain === undefined ? 0.9 : gain, G.contact, attack ? 1 : 0);
      G.bowing = i;
    }
    G.inst.strings[i].freq = freq;
    G.bowNote = i;
    G.playedCount++;
    if (G.playedCount === 6 && !G.resultShown) {
      toast('按 F 可以放下琴；点桌上的乐谱选一首跟弹', 3000);
    }
    if (G.playedCount >= 24 && !G.resultShown) showResult();
    return { string: i, pos: asg.pos, freq: freq, ratio: asg.ratio };
  }
  function stopNote() {
    if (G.bowing >= 0) AUDIO.bowStop(G.bowing);
    G.bowing = -1;
    if (!G.inst) return;                 // 还没建琴的时候（第一次载入）啥都不用收
    G.inst.setAllVibrato(0);
    G.inst.clearFingers();
    G.inst.refreshStrings();
  }

  /* =====================================================================
   * 曲集
   * =================================================================== */
  function buildSongList() {
    const list = $('song-list');
    list.innerHTML = '';
    SCORE.PRESETS.forEach(function (p, i) {
      const b = document.createElement('button');
      b.className = 'btn song-btn';
      b.textContent = p.name;
      b.addEventListener('click', function () { selectScore(i); });
      list.appendChild(b);
    });
  }
  function selectScore(idx) {
    const spec = VIO.SPECS[G.instId];
    const preset = SCORE.PRESETS[idx];
    const parsed = SCORE.parse(preset.text, spec.jianpuBase);
    SCORE.fitRange(parsed.notes, spec.openMidi[0], spec.openMidi[3] + 12);
    G.score = preset.name;
    G.scoreNotes = SCORE.assign(parsed.notes, spec.openMidi);
    G.scoreStep = 0;
    $('card-sheet').classList.remove('on');
    $('scorebar').classList.add('on');
    $('score-name').textContent = preset.name;
    renderKeys();
    setHint();
  }
  function renderKeys() {
    const box = $('keys');
    box.innerHTML = '';
    if (!G.scoreNotes) return;
    G.scoreNotes.forEach(function (n, i) {
      const s = document.createElement('span');
      if (n.rest) { s.textContent = '休'; s.className = i < G.scoreStep ? 'done' : ''; }
      else {
        const keyIdx = ((n.midi - VIO.SPECS[G.instId].jianpuBase) % 12 + 12) % 12;
        const oct = Math.floor((n.midi - VIO.SPECS[G.instId].jianpuBase) / 12);
        s.textContent = (oct > 0 ? '⇧' : (oct < 0 ? '⇩' : '')) + SCORE.KEYS[keyIdx];
      }
      if (i < G.scoreStep) s.className = 'done';
      else if (i === G.scoreStep) s.className = 'next';
      box.appendChild(s);
    });
    const total = G.scoreNotes.length;
    $('score-info').textContent = '第 ' + Math.min(G.scoreStep + 1, total) + ' / ' + total + ' 个音';
  }
  function scoreKey(midi) {
    if (!G.scoreNotes || G.scoreStep >= G.scoreNotes.length) return false;
    let i = G.scoreStep;
    while (i < G.scoreNotes.length && G.scoreNotes[i].rest) i++;   // 休止自动跳过
    G.scoreStep = i;
    if (i >= G.scoreNotes.length) return false;
    const want = G.scoreNotes[i];
    if (want.midi === midi) {
      G.scoreStep = i + 1;
      renderKeys();
      if (G.scoreStep >= G.scoreNotes.length) {
        toast('拉完啦：' + G.score, 2600);
        if (!G.resultShown) setTimeout(showResult, 900);
      }
      return true;
    }
    return false;
  }
  /** 让琴自己拉一遍（换乐器后对比音区用） */
  function autoPlayScore(scoreName) {
    let idx = 0;
    if (scoreName) {
      const k = SCORE.PRESETS.findIndex(function (p) { return p.name === scoreName; });
      if (k >= 0) idx = k;
    }
    selectScore(idx);
    const notes = G.scoreNotes;
    let t = 0, i = 0;
    G.autoPlay = [];
    const step = function () {
      if (i >= notes.length) {
        stopNote();
        toast('同一段旋律，换了乐器音区就变了', 3000);
        return;
      }
      const n = notes[i];
      if (n.rest) {
        stopNote();
      } else {
        const midi = n.midi;
        playNote(midi, 0.85);
        G.scoreStep = i + 1;
        renderKeys();
      }
      const dur = Math.max(0.28, n.beats * 0.42);
      i++;
      G.autoPlay.push(setTimeout(step, dur * 1000));
    };
    step();
  }
  function stopAutoPlay() {
    (G.autoPlay || []).forEach(clearTimeout);
    G.autoPlay = null;
    stopNote();
  }

  /* =====================================================================
   * HUD
   * =================================================================== */
  function setHint() {
    const h = $('hint');
    let text = '';
    if (G.phase === PHASE.STRING) {
      text = '把四卷弦装到琴上：准星对准弦卷，<b>点左键</b>。顺序不限 —— 先装最粗的那根，听听是不是最低';
    } else if (G.phase === PHASE.TUNE) {
      const tuned = G.tuning.locked.filter(Boolean).length;
      text = '准星对准<b>弦轴</b>，<b>按住左键左右移动鼠标</b>转弦轴（音高连续滑动）· <span class="k">空格</span>听标准音 · ' +
        '<span class="k">←</span><span class="k">→</span>微调 · 也可以对着弦轴<b>滚轮</b> · ' +
        '调到 ±10 音分以内松开左键锁定（已调准 ' + tuned + '/4）';
    } else if (G.phase === PHASE.BOW) {
      text = G.bowHeld
        ? '点一个<b>触弦点</b>：靠指板闷而柔、中间均衡、靠琴桥亮而紧 —— 三个都试试，然后按 <span class="k">F</span> 拿起琴'
        : '准星对准桌上的<b>琴弓</b>，点左键拿起来';
    } else if (G.phase === PHASE.PLAY) {
      if (G.holdTarget > 0.5) {
        text = '<span class="k">1</span>…<span class="k">=</span> 十二个半音 · 升八度 <span class="k">Shift</span> 或按住 <span class="k">Z</span> · ' +
          '<span class="k">Ctrl</span>降八度 · ' +
          '按住 <span class="k">C</span> 每个音都带音头（不按就统一软起音）· ' +
          '<b>滚轮</b>换触弦点（准星对着弦也能换）· ' +
          '点乐谱跟弹 · <span class="k">F</span>放下琴 · ' +
          '<span class="k">Esc</span>放开鼠标可点右上角按钮（<span class="k">I</span>反向 <span class="k">R</span>重来 <span class="k">T</span>换乐器）';
      } else {
        text = '按 <span class="k">F</span> 把琴拿起来（没拿琴按演奏键不会出声）· 点桌上的<b>乐谱</b>选曲子 · ' +
          '演奏时按住 <span class="k">C</span> 可让每个音都带音头';
      }
    }
    h.innerHTML = text;
  }

  function drawTuner(cents) {
    const c = $('tuner-canvas');
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    const cx = c.width / 2, cy = c.height - 18, R = 92;
    // 绿区
    g.strokeStyle = 'rgba(127,209,138,.55)';
    g.lineWidth = 12;
    g.beginPath();
    g.arc(cx, cy, R, -Math.PI / 2 - MX.deg(10) * 2, -Math.PI / 2 + MX.deg(10) * 2);
    g.stroke();
    // 刻度
    g.strokeStyle = 'rgba(246,236,220,.45)';
    g.lineWidth = 2;
    for (let v = -50; v <= 50; v += 10) {
      const a = -Math.PI / 2 + MX.deg(v);
      const r0 = R + 8, r1 = v % 50 === 0 ? R + 22 : R + 16;
      g.beginPath();
      g.moveTo(cx + Math.sin(a) * r0, cy - Math.cos(a) * r0);
      g.lineTo(cx + Math.sin(a) * r1, cy - Math.cos(a) * r1);
      g.stroke();
    }
    // 指针
    const a = -Math.PI / 2 + MX.deg(clamp(cents, -50, 50));
    g.strokeStyle = Math.abs(cents) <= 10 ? '#7fd18a' : '#e8b96a';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.sin(a) * (R - 6), cy - Math.cos(a) * (R - 6));
    g.stroke();
    g.fillStyle = Math.abs(cents) <= 10 ? '#7fd18a' : '#e8b96a';
    g.beginPath();
    g.arc(cx, cy, 6, 0, MX.TAU);
    g.fill();
    const read = $('tuner-read');
    const sign = cents > 0 ? '+' : '';
    read.innerHTML = '<b class="' + (Math.abs(cents) <= 10 ? 'ok' : '') + '">' +
      sign + cents.toFixed(0) + '</b> 音分' + (Math.abs(cents) <= 10 ? ' · 准了' : '');
  }

  function showSheet(open) {
    $('card-sheet').classList.toggle('on', open);
    if (open) {
      buildSongList();
      G.modal = true;
      releasePointer();                 // 卡片要用鼠标点，先把指针放开
    } else {
      G.modal = false;
      grabPointer();
    }
  }
  function showResult() {
    G.resultShown = true;
    const spec = VIO.SPECS[G.instId];
    const err = G.tuning.cents.reduce(function (a, b) { return a + Math.abs(b); }, 0) / 4;
    $('result-extra').textContent = '你这次的平均调音误差约 ' + err.toFixed(1) +
      ' 音分（' + spec.name + ' · 空弦 ' + spec.openMidi.map(function (m) { return SCORE.midiToName(m); }).join(' ') + '）。' +
      '演奏时用的音高就是你自己调出来的那个音高 —— 弦没调准，拉出来就真的跑调。';
    $('card-result').classList.add('on');
    G.modal = true;
    releasePointer();
    $('btn-switch').classList.remove('hide');
  }

  /** 卡片（曲集 / 结果页 / 开场）开着的时候，指针要放开，不然玩家点不到按钮 */
  function anyCardOpen() {
    return ['card-start', 'card-sheet', 'card-result'].some(function (id) {
      return $(id).classList.contains('on');
    });
  }
  function releasePointer() {
    if (document.pointerLockElement) { try { document.exitPointerLock(); } catch (e) {} }
  }
  function grabPointer() {
    if (anyCardOpen()) return;
    if (document.pointerLockElement !== G.renderer.domElement) requestLock();
  }

  function bindUI() {
    document.querySelectorAll('#card-start [data-inst]').forEach(function (b) {
      b.addEventListener('click', function () { startGame(b.getAttribute('data-inst')); });
    });
    $('btn-invert').addEventListener('click', function () {
      G.invert = !G.invert;
      $('btn-invert').textContent = G.invert ? '↕ 上下反向（开）' : '↕ 上下反向';
    });
    $('btn-restart').addEventListener('click', function () {
      stopAutoPlay();
      $('card-result').classList.remove('on');
      $('scorebar').classList.remove('on');
      G.score = null; G.scoreNotes = null; G.playedCount = 0; G.resultShown = false;
      G.contactTried = [false, false, false];
      G.bowHeld = false; G.holdTarget = 0; G.hold = 0;
      G.room.coils.forEach(function (c) { c.visible = true; });
      attachBow(false);
      G.phase = PHASE.SELECT;                    // 强制走一遍阶段切换，提示/热点都刷新
      loadInstrument(G.instId, { fresh: true });
      setPhase(PHASE.STRING);
    });
    $('btn-switch').addEventListener('click', function () { showResult(); });
    $('result-close').addEventListener('click', function () { $('card-result').classList.remove('on'); });
    $('result-close').addEventListener('click', function () {
      $('card-result').classList.remove('on');
      G.modal = false;
      grabPointer();
    });
    $('sheet-close').addEventListener('click', function () { showSheet(false); });
    $('sheet-auto').addEventListener('click', function () {
      stopAutoPlay();
      showSheet(false);
      autoPlayScore(G.score);
    });
    document.querySelectorAll('#card-result [data-inst]').forEach(function (b) {
      b.addEventListener('click', function () {
        const id = b.getAttribute('data-inst');
        if (G.instId !== id && G.phase >= PHASE.PLAY) {
          G.resultShown = true;
          $('card-result').classList.remove('on');
          G.modal = false;
          loadInstrument(id, { fresh: false });
          setPhase(PHASE.PLAY);
          G.holdTarget = 1;
          setHint();
          // 按需求：换乐器后**不自动拉一遍**（想听对比可以自己按「让它自己拉一遍」）
          toast('换成' + VIO.SPECS[id].name + '：弦已装好调准，直接按数字键拉', 2600);
        }
      });
    });
  }

  function startGame(id) {
    $('card-start').classList.remove('on');
    // 注意：指针锁必须在"用户手势"里**同步**申请。放到 AUDIO.init() 的 then 里
    // 就晚了 —— 那时手势已经失效，浏览器会拒绝，玩家就会遇到"选了乐器但鼠标转不动头"。
    requestLock();          // 必须在用户手势里同步申请
    AUDIO.init().then(function () {
      AUDIO.setMaster(0.9);
      loadInstrument(id, { fresh: true });
      setPhase(PHASE.STRING);
      // 万一上面那次没成功（比如浏览器把 promise 化的锁请求当作非手势），再补一次；
      // 玩家点画面上的任何地方也都会重新申请（见 init 里的 click 监听）。
      if (document.pointerLockElement !== G.renderer.domElement) {
        requestLock();
      }
    });
  }

  /* =====================================================================
   * 输入
   * =================================================================== */
  function onLockChange() {
    G.locked = document.pointerLockElement === G.renderer.domElement;
    if (G.locked) {
      G.lockIgnoreUntil = performance.now() + 200;   // 锁上后先跳过一段，别吃补发的大位移
      G.lockFails = 0;
    }
    $('lock').classList.toggle('hide', G.locked || G.phase === PHASE.SELECT);
  }
  function onMouseMove(e) {
    if (G.tuning.dragging && G.tuning.active >= 0) {
      const mx = e.movementX || 0;
      if (mx) tuningAdjust(mx);
      return;
    }
    if (anyCardOpen()) return;                 // 卡片开着时不转视角
    const mx = e.movementX || 0, my = e.movementY || 0;
    if (!G.locked) {
      // 没锁指针时的兜底：按住左键拖动才转视角
      if (!G.lookDrag || !G.lookDrag.active || G.lookDrag.tuning) return;
      G.lookDrag.moved += Math.abs(mx) + Math.abs(my);
    }
    // 刚拿到指针锁的那一瞬间，浏览器有时会补发一个很大的 movement（光标位置重置），
    // 直接吃下去视角就会"闪到别处"。所以锁上后的 200ms 内先不理会移动。
    if (performance.now() < G.lockIgnoreUntil) return;
    const s = 0.0022;
    // 单个事件的位移做上限：正常的快速甩鼠标也就一两百像素，
    // 超过这个量级的基本都是"补发/重置"事件，吃掉它比甩飞视角好。
    const mxC = clamp(mx, -140, 140), myC = clamp(my, -140, 140);
    G.yawT -= mxC * s;
    G.pitchT = clamp(G.pitchT + (G.invert ? myC : -myC) * s, MX.deg(-80), MX.deg(80));
    G.pitchAuto = 0;                     // 玩家自己转头了，就不再自动低头
  }
  function onMouseDown(e) {
    if (e.button !== 0 || G.phase === PHASE.SELECT) return;
    // 点在 HUD 的卡片/按钮上：交给 DOM 的按钮处理，不当作"对着琴操作"
    if (e.target && e.target.closest && e.target.closest('#hud')) return;
    if (anyCardOpen()) return;                 // 卡片开着时先让玩家点按钮
    if (G.locked) { doInteract(); return; }
    // 没锁上指针时（浏览器拒绝 / 玩家按过 Esc）也要能玩：
    // 按住左键拖动 = 转视角；几乎没动的松开 = 一次点击交互（鼠标拖一下能分清）
    G.lookDrag = { active: true, moved: 0 };
    requestLock();
    if (G.phase === PHASE.TUNE) {
      const info = pick();
      if (info && info.peg !== undefined) { tuningStart(info.peg); G.lookDrag.tuning = true; }
    }
  }

  /** 申请指针锁：失败的 promise 要接住，否则控制台会刷一屏未捕获异常 */
  function requestLock() {
    // 注意：不能把"这次失败"记成永久拒绝。
    // Esc 退出指针锁之后，浏览器会有一段冷却（约 1 秒多）里拒绝新的请求，
    // 原来的写法一旦失败就再也不申请了 —— 表现就是"按 Esc 之后再点画面锁不上"。
    if (performance.now() < (G.lockRetryAfter || 0)) return;
    try {
      const p = G.renderer.domElement.requestPointerLock();
      if (p && p.catch) {
        p.catch(function () {
          G.lockFails = (G.lockFails || 0) + 1;
          G.lockRetryAfter = performance.now() + 1200;      // 冷却后再试
          if (G.lockFails === 3) toast('浏览器暂时不给锁鼠标：也可以按住左键拖动转视角', 4200);
        });
      }
    } catch (err) {
      G.lockRetryAfter = performance.now() + 1200;
    }
  }

  /** 一次"点击交互"：按当前阶段决定干什么 */
  function doInteract() {
    const info = pick();
    if (G.phase === PHASE.STRING) {
      if (!info || info.coil === undefined) {
        toast('把准星对准左边备弦盒里的弦卷，再点左键装上', 2200);
        return;
      }
      if (installing.length) return;
      installString(info.coil);
    } else if (G.phase === PHASE.TUNE) {
      if (!info || info.peg === undefined) {
        toast('把准星对准琴头的弦轴（那四个捏柄），按住左键左右移动鼠标转它', 2400);
        return;
      }
      tuningStart(info.peg);
    } else if (G.phase === PHASE.BOW) {
      if (!G.bowHeld) {
        if (info) pickUpBow();
        else toast('准星对准桌上的琴弓，点左键拿起来', 2200);
        return;
      }
      if (info && info.spot !== undefined) playContactSpot(info.spot);
      else toast('点一个黄圈（触弦点）：靠指板 / 中间 / 靠琴桥', 2200);
    } else if (G.phase === PHASE.PLAY) {
      if (info && info.sheet) showSheet(true);
      else toast('准星对准桌上的乐谱纸，点左键打开曲集', 2000);
    }
  }

  function onMouseUp(e) {
    if (e.button !== 0) return;
    if (G.phase === PHASE.TUNE && G.tuning.dragging) {
      tuningEnd();
      G.lookDrag = null;
      return;
    }
    if (G.lookDrag && G.lookDrag.active) {
      const dragged = G.lookDrag.moved > 10;
      G.lookDrag = null;
      if (!dragged) doInteract();              // 没拖动 = 当成一次点击
    }
  }
  function onWheel(e) {
    if (G.phase === PHASE.SELECT) return;
    e.preventDefault();
    // 拿着琴的时候：滚轮 = 弓在弦上前后移（换触弦点）。
    // 为什么不能只靠准星：持琴时琴挂在相机坐标系里，弦在屏幕上位置固定，
    // 而准星永远在屏幕正中 —— 所以要给一个不依赖准星的稳定控制。
    if (G.phase >= PHASE.BOW && G.holdTarget > 0.5 && G.bowHeld) {
      const zone0 = contactZoneName(G.contact);
      setBowToContact(clamp(G.contact + Math.sign(e.deltaY) * 0.045, 0.03, 1));
      G.contactManualUntil = performance.now() + 2500;   // 主动设过之后，先别让准星把它抢回去
      const zone1 = contactZoneName(G.contact);
      if (zone1 !== zone0) toast('触弦点：' + zone1, 1200);
      return;
    }
    // 调音时：准星对着弦轴直接滚轮也能转（比"按住左键甩鼠标"更好上手）
    if (G.phase === PHASE.TUNE) {
      let i = G.tuning.active;
      if (i < 0) {
        const info = pick();
        if (info && info.peg !== undefined) i = info.peg;
      }
      if (i >= 0 && !G.tuning.locked[i]) {
        if (G.tuning.active < 0) tuningStart(i);
        tuningAdjust(-Math.sign(e.deltaY) * 25);
        clearTimeout(G.wheelTuneTimer);
        G.wheelTuneTimer = setTimeout(function () {
          if (G.tuning.active >= 0 && !G.tuning.dragging) tuningEnd();
        }, 550);
        return;
      }
    }
    const d = Math.sign(e.deltaY);
    const fwd = new T.Vector3();
    G.camera.getWorldDirection(fwd);
    fwd.y *= 0.6;
    G.pos.addScaledVector(fwd, -d * 90);
    clampPos();
  }
  function clampPos() {
    G.pos.x = clamp(G.pos.x, -2100, 2100);
    G.pos.z = clamp(G.pos.z, -2500, 1600);
    G.pos.y = 1520;
  }
  function onKeyDown(e) {
    // 按键要看**物理键位**（e.code），不能看 e.key：
    // 按住 Shift 时 Shift+1 的 e.key 是 "!"、"Shift+-" 是 "_"，
    // 照 e.key 去查演奏键表就永远匹配不上 —— 这就是"Shift 升八度没反应"的真原因，
    // 而且松键时也会因为 e.key 变了而对不上、把音卡住。
    const k = baseKey(e);
    if (e.key === 'Escape') { document.exitPointerLock(); return; }
    if (k === 'w' || k === 'W') G.move.f = 1;
    if (k === 's' || k === 'S') G.move.b = 1;
    if (k === 'a' || k === 'A') G.move.l = 1;
    if (k === 'd' || k === 'D') G.move.r = 1;
    // C = 音头开关（按住才起音头），要先记下来，演奏键里会读它
    if (k === 'c') {
      G.keyDown = G.keyDown || {};
      G.keyDown['c'] = true;
      return;
    }
    if (k === ' ' && G.phase === PHASE.TUNE) {
      e.preventDefault();
      const i = G.tuning.active >= 0 ? G.tuning.active : nearestTunedPeg();
      if (i >= 0) AUDIO.reference(SCORE.midiToFreq(G.inst.spec.openMidi[i]), 0.6);
      else toast('准星先对准一根弦轴，再按空格听标准音', 1800);
      return;
    }
    if (G.phase === PHASE.TUNE && (k === 'ArrowLeft' || k === 'ArrowRight')) {
      tuningFine(k === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (k === 'f') {
      if (G.phase === PHASE.BOW || G.phase === PHASE.PLAY) {
        if (G.phase === PHASE.BOW) {
          if (!G.bowHeld) { toast('先把琴弓拿起来', 2000); return; }
          setPhase(PHASE.PLAY);
        }
        G.holdTarget = G.holdTarget > 0.5 ? 0 : 1;
        if (G.holdTarget > 0.5) {
          G.pitchAuto = 1.4;               // 拿起来自动低头看琴
          toast('琴拿起来了：按数字键拉琴', 2200);
        }
        else { stopNote(); toast('琴放回桌上', 1600); }
        setHint();
      }
      return;
    }
    // 指针被锁住时鼠标点不到右上角的按钮，所以给它们配上键盘
    if (k === 'i') { $('btn-invert').click(); return; }
    if (k === 'r') { $('btn-restart').click(); return; }
    if (k === 't') { $('btn-switch').click(); return; }
    if (G.phase === PHASE.PLAY) {
      pressNoteKey(k, e.shiftKey, e.ctrlKey);
    }
  }
  function onKeyUp(e) {
    const k = baseKey(e);
    if (k === 'w' || k === 'W') G.move.f = 0;
    if (k === 's' || k === 'S') G.move.b = 0;
    if (k === 'a' || k === 'A') G.move.l = 0;
    if (k === 'd' || k === 'D') G.move.r = 0;
    if (G.keyDown) G.keyDown[k] = false;
    if (SCORE.KEYS.indexOf(k) >= 0) {
      const still = Object.keys(G.keyDown || {}).some(function (kk) {
        return G.keyDown[kk] && SCORE.KEYS.indexOf(kk) >= 0;
      });
      if (!still) stopNote();
    }
  }

  /** 按下一个演奏键：12 个半音，Shift 升八度 / Ctrl 降八度；曲集模式下判定对错 */
  function pressNoteKey(k, shift, ctrl) {
    const idx = SCORE.KEYS.indexOf(k);
    if (idx < 0) return null;
    if (G.holdTarget < 0.5) { toast('先按 F 把琴拿起来，再拉弦', 2000); return null; }
    G.keyDown = G.keyDown || {};
    // 升八度：Shift 或 按住 Z（Z 是给"浏览器/输入法里 Shift 不好按"的情况准备的备选）
    const oct = (shift || G.keyDown['z']) ? 12 : (ctrl ? -12 : 0);
    const midi = G.inst.spec.jianpuBase + idx + oct;
    G.keyDown = G.keyDown || {};
    if (G.keyDown[k]) return null;
    G.keyDown[k] = true;
    // 音头统一由 C 键控制：不按 C 每个音都是软起音（连弓手感），按住 C 每个音都有音头
    const wantAttack = !!G.keyDown['c'];
    const r = playNote(midi, 0.9, wantAttack);
    G.lastMidi = midi;                 // 给自动测试/排查用
    if (G.scoreNotes) {
      if (!scoreKey(midi)) {
        const want = G.scoreNotes[G.scoreStep];
        if (want && want.midi !== null) {
          const wi = ((want.midi - G.inst.spec.jianpuBase) % 12 + 12) % 12;
          toast('该按 ' + (want.midi - G.inst.spec.jianpuBase >= 12 ? 'Shift（或 Z）+ ' : '') +
            SCORE.KEYS[wi] + '（键盘版简谱）', 1400);
        }
      }
    }
    return midi;
  }

  /* =====================================================================
   * 主循环
   * =================================================================== */
  function frame(now) {
    requestAnimationFrame(frame);
    const t = now / 1000;
    const dt = Math.min(0.05, G.lastT ? t - G.lastT : 0.016);
    G.lastT = t;
    G.time += dt;

    updateMove(dt);
    updateHold(dt);
    updatePlaying(dt);
    updateInstalling(dt);
    updateTuningSmooth(dt);
    if (G.inst) G.inst.update(dt);
    updateHudFrame(dt);
    G.renderer.render(G.scene, G.camera);
  }

  function updateMove(dt) {
    const speed = 900 * (G.move.f || G.move.b || G.move.l || G.move.r ? 1 : 1);
    const fwd = new T.Vector3(-Math.sin(G.yaw), 0, -Math.cos(G.yaw));
    const right = new T.Vector3(Math.cos(G.yaw), 0, -Math.sin(G.yaw));
    const dir = new T.Vector3();
    if (G.move.f) dir.add(fwd);
    if (G.move.b) dir.sub(fwd);
    if (G.move.r) dir.add(right);
    if (G.move.l) dir.sub(right);
    if (dir.lengthSq() > 0) {
      dir.normalize().multiplyScalar(speed * dt);
      G.pos.add(dir);
      clampPos();
    }
    // 拿起琴的那一刻自动低头看一眼（和实拍第一视角一样是从上往下看琴身）
    if (G.pitchAuto > 0) {
      G.pitchAuto -= dt;
      G.pitchT += (G.holdPitch - G.pitchT) * Math.min(1, 3.2 * dt);
    }
    // 实际角度平滑贴向目标：既能吃掉个别超大位移，转起来也更顺
    // 水平角必须按"最短路径"插值：跨过 ±π 时两边的数值差接近 2π，
    // 直接 damp 会让相机在一帧里倒转一整圈 —— 表现就是"视角抽搐"。
    let dyaw = G.yawT - G.yaw;
    dyaw = ((dyaw + Math.PI) % MX.TAU + MX.TAU) % MX.TAU - Math.PI;
    const k = 1 - Math.exp(-26 * dt);
    G.yaw += dyaw * k;
    G.pitch = MX.damp(G.pitch, G.pitchT, 26, dt);
    // 目标角本身不折返（浮点数撑得住），只有相机姿态用它 —— 少一次折返就少一处抽风
    G.camera.rotation.set(G.pitch, G.yaw, 0, 'YXZ');
    G.camera.updateMatrixWorld();
    G.camera.position.copy(G.pos);
    // 相机补光：始终从玩家背后照向视线方向，低头看琴时琴身不会发闷
    if (G.room && G.room.cameraFill) {
      G.camera.getWorldDirection(tmpDir);
      G.room.cameraFill.position.copy(G.pos).addScaledVector(tmpDir, 4000);
      G.room.cameraFill.target.position.copy(G.pos);
      G.room.cameraFill.target.updateMatrixWorld();
    }
  }

  function updateHold(dt) {
    if (!G.inst) return;
    const speed = 2.6;
    G.hold += (G.holdTarget - G.hold) * Math.min(1, speed * dt);
    if (Math.abs(G.hold - G.holdTarget) < 0.001) G.hold = G.holdTarget;
    const inst = G.inst;
    if (G.hold <= 0.0001) {
      inst.group.position.copy(G.tablePose.pos);
      inst.group.quaternion.copy(G.tablePose.quat);
    } else {
      // 桌上 ⇄ 手上：位置线性插值 + 旋转四元数 slerp（绝不用欧拉角插值）
      const m = new T.Matrix4().copy(G.camera.matrixWorld);
      const worldQuat = new T.Quaternion().setFromRotationMatrix(m).multiply(G.holdQuat);
      const worldPos = G.holdLocalPos.clone().applyMatrix4(m);
      worldPos.y = Math.max(worldPos.y, G.room.tableTopY + 120);      // 低头也不穿桌面
      const k = MX.easeInOut(G.hold);
      inst.group.position.lerpVectors(G.tablePose.pos, worldPos, k);
      inst.group.quaternion.copy(G.tablePose.quat).slerp(worldQuat, k);
    }
    inst.group.updateMatrixWorld(true);
  }

  function updatePlaying(dt) {
    // 演奏中：准星沿弦滑动 → 换触弦点；弓跟着走 + 运弓往复
    if (G.phase < PHASE.BOW || !G.bowHeld) return;
    if (G.holdTarget > 0.5) {
      // 拿着琴的时候，弓只在真正拉的时候出现在弦上（不然 745mm 的弓会横满视野）
      G.bow.group.visible = G.bowing >= 0;
      // 准星对着弦也能换触弦点，但玩家刚用滚轮设过就先听玩家的（否则会被抢回去）
      if (performance.now() > (G.contactManualUntil || 0)) {
        const c = contactFromCrosshair();
        if (Math.abs(c - G.contact) > 0.01) setBowToContact(c);
      }
    } else {
      G.bow.group.visible = true;
    }
    if (G.bowing >= 0) {
      G.bowAnim += dt * 3.4;
      const inst = G.inst;
      const s = contactToS(G.contact);
      const p = inst.stringPointAt(G.bowing, s);
      G.bow.placeAt(p, {
        stroke: Math.sin(G.bowAnim * MX.TAU * 0.5) * inst.spec.L * 0.085,
        flip: G.bowFlip,
        yaw: G.bowYaw
      });
    }
  }

  function updateHudFrame(dt) {
    // FPS
    G.fpsAcc += dt; G.fpsN++;
    if (G.fpsAcc > 0.5) {
      $('fps').textContent = Math.round(G.fpsN / G.fpsAcc) + ' fps · ' +
        (AUDIO.mode() === 'worklet' ? 'AudioWorklet'
          : 'ScriptProcessor' + (AUDIO.workletError && AUDIO.workletError() ? '（' + AUDIO.workletError().slice(0, 40) + '）' : ''));
      G.fpsAcc = 0; G.fpsN = 0;
    }
    // 没锁指针时给出"点一下画面"的提示（有的浏览器在 file:// 下不给自动锁）
    $('lock').classList.toggle('hide', G.locked || G.phase === PHASE.SELECT);
    // 准星 / 提示
    const info = pick();
    const canPick = !!(info && (info.coil !== undefined || info.peg !== undefined ||
      info.spot !== undefined || info.bow || info.sheet));
    $('cross').classList.toggle('on', canPick);
    const spot = $('spot');
    if (canPick) {
      let label = '';
      if (info.coil !== undefined) {
        const s = G.inst.spec.strings[info.coil];
        label = '弦卷 <b>' + s.name.split('')[0] + '</b>（粗细 ' + s.dia.toFixed(1) + 'mm）· 点左键装上';
      } else if (info.peg !== undefined) {
        const s = G.inst.spec.strings[info.peg];
        label = s.name + ' 弦轴 · 按住左键左右移动鼠标转它' +
          (G.tuning.locked[info.peg] ? '（已调准）' : '');
      } else if (info.spot !== undefined) {
        label = ['靠指板（闷而柔）', '中间（均衡）', '靠琴桥（亮而紧）'][info.spot] + ' · 点左键放弓';
      } else if (info.bow) label = '琴弓 · 点左键拿起来';
      else if (info.sheet) label = '乐谱 · 点左键打开曲集';
      spot.innerHTML = label;
      spot.classList.add('on');
    } else spot.classList.remove('on');

    // 音分表
    const showTuner = G.phase === PHASE.TUNE;
    $('tuner').classList.toggle('on', showTuner);
    if (showTuner) {
      let i = G.tuning.active;
      if (i < 0 && info && info.peg !== undefined) i = info.peg;
      if (i < 0) i = G.tuning.locked.indexOf(false);
      if (i >= 0) drawTuner(G.tuning.cents[i]);
    }
    if (G.dirtyHud || G.phase !== G.lastPhase) {
      G.lastPhase = G.phase;
      G.dirtyHud = false;
      setHint();
      if (G.phase === PHASE.TUNE) renderKeys();
    }
    // 拿起/放下琴时底部提示也要跟着换（不然会一直显示"按 F 把琴拿起来"）
    const holding = G.holdTarget > 0.5;
    if (holding !== G.lastHolding) {
      G.lastHolding = holding;
      if (G.phase >= PHASE.BOW) setHint();
    }
  }

  /* ---------------------------------------------------------- 启动 */
  // 开发工具（tools/smoketest.js、tools/preview.js）用它驱动整个流程，不参与画面逻辑
  G.api = {
    PHASE: PHASE,
    startGame: startGame, loadInstrument: loadInstrument, setPhase: setPhase,
    installString: installString, update: function (dt) {
      updateInstalling(dt); updateHold(dt); updatePlaying(dt); updateTuningSmooth(dt);
      if (G.inst) G.inst.update(dt);
    },
    tuningStart: tuningStart, tuningAdjust: tuningAdjust, tuningEnd: tuningEnd,
    tuningFine: tuningFine, applyTuning: applyTuning,
    setView: function (yaw, pitch) {
      G.yaw = G.yawT = yaw;
      G.pitch = G.pitchT = clamp(pitch, MX.deg(-80), MX.deg(80));
      G.camera.rotation.set(G.pitch, G.yaw, 0, 'YXZ');
      G.camera.updateMatrixWorld(true);
    },
    pickUpBow: pickUpBow, playContactSpot: playContactSpot,
    playNote: playNote, stopNote: stopNote, setBowToContact: setBowToContact,
    pressNoteKey: pressNoteKey, setHold: function (v) { G.holdTarget = v; },
    selectScore: selectScore, autoPlayScore: autoPlayScore,
    showSheet: showSheet, showResult: showResult, pick: pick,
    allStringsInstalled: allStringsInstalled, allTuned: allTuned
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else init();
})();
