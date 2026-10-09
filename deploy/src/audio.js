/* =========================================================================
 * audio.js —— 弦振动的实时合成（全部 WebAudio，没有任何音频文件）
 *
 * 拨弦 / 起音 = Karplus-Strong 数字波导：
 *   延迟线长度 = 采样率 / 频率（分数延迟，所以调弦是连续滑音，不跳格），
 *   环路里一个单零点低通负责阻尼，环路增益按该频率处的滤波器响应补偿回去，
 *   于是"音色变、音高不跑"。
 *
 * 拉弦 = 同一条波导改用"持续的锯齿 + 少量噪声"激励，环路增益做到几乎为 1：
 *   · 只要按键按住，声音就平稳持续、无限延长、不衰减、不忽大忽小；
 *   · 松键（离弓）才把增益降下来快速收弓。
 *   为了长按 10 秒不出任何断音/咔哒/起伏，做了三件事：
 *   1) 合成跑在 AudioWorklet（独立音频线程），主线程渲染卡一下也不影响声音；
 *      没有 Worklet 就退回 ScriptProcessorNode，缓冲区 4096 帧，留足余量。
 *   2) 频率、激励增益、阻尼、触弦点全部一阶平滑跟随，永不跳变。
 *   3) 激励用"与延迟线同周期"的锯齿（相位锁在环路里），噪声只占很小比例，
 *      所以稳态波形是严格周期的，不会有周期性音量起伏。
 *
 * 触弦点音色是真做出来的，不是加 EQ：
 *   激励点沿延迟线移动 —— 激励 = saw(t) − saw(t − β·D)，
 *   在第 n 次谐波处产生 |sin(nπβ)| 的梳状零点。
 *   靠指板 β ≈ 1/3 → 挖掉 3/6/9… 次谐波（闷、圆）；
 *   靠琴桥 β ≈ 1/10 → 只挖高次，音色亮而紧。
 *   同时环路阻尼随位置变（靠指板高频衰减快），增益再按滤波器响应补偿，
 *   所以三个位置的音色能听出区别，而音高一点都不跑。
 *
 * 琴体 = 一串共振峰滤波器（285/460/720/1180/2900Hz，随乐器尺寸缩放），
 * 空间 = 程序生成的短混响脉冲响应。
 * ========================================================================= */
(function (global) {
  'use strict';

  const AUDIO = {};
  const NSTR = 4;

  /* =====================================================================
   * DSP 核心：写成"自包含函数"，既不引用外部变量，也不引用 THREE。
   * AudioWorklet 的源码就是把这个函数 toString() 拼进 processor 里，
   * ScriptProcessor 退化路径直接调用同一个函数 —— 两条路径算法完全一致。
   * =================================================================== */
  function StringBank(sampleRate) {
    const NV = 5;                                          // 0..3 = 四根弦，4 = 参考音
    const MAXDELAY = Math.ceil(sampleRate / 16) + 8;       // 支持到 16Hz
    const MAXF = Math.min(24000, sampleRate * 0.48);
    const v = [];
    for (let i = 0; i < NV; i++) {
      v.push({
        buf: new Float32Array(MAXDELAY),
        sawHist: new Float32Array(512),
        idx: 0,
        freq: 220, targetFreq: 220,
        delay: sampleRate / 220,
        g: 0,                 // 环路增益（每往返一次）
        dampScale: 1,          // 乐器音区越低，环路阻尼截止频率越低
        contact: 0.5, contactTarget: 0.5,
        exc: 0, excTarget: 0,
        speed: 0.0007,        // 参数平滑系数（约 20ms 时间常数）
        sawPhase: 0,
        nz: 0, nz2: 0, nzLast: 0,
        lp: 0,                 // 环路低通状态
        energy: 0,
        agc: 1,
        agcBlocks: 0,
        mode: 'idle',        // bow / pizz / release / idle
        pizzTimer: 0,
        env: 1,              // 起弓的 5ms 淡入，避免"咔"
        idle: true,
        out: 0
      });
    }
    let master = 0.9, masterTarget = 0.9;

    function setStrings(list) {
      for (let i = 0; i < 4 && i < list.length; i++) {
        v[i].freq = list[i];
        v[i].targetFreq = list[i];
        v[i].delay = sampleRate / list[i];
      }
    }

    return {
      setStrings: setStrings,
      state: function (i) { return v[i]; },
      /** 乐器越大音区越低：环路阻尼截止频率整体按比例挪 */
      setScale: function (s) {
        for (let i = 0; i < NV; i++) v[i].dampScale = s;
      },
      setMaster: function (m) { masterTarget = m; },
      /** 连续改频率（调弦）：延迟线长度跟着平滑滑过去 —— 连续滑音 */
      setFreq: function (i, hz) {
        if (i < 0 || i >= NV) return;
        v[i].targetFreq = Math.max(16, Math.min(MAXF, hz));
      },
      /** 拨弦 / 起音的噪声爆发 */
      pluck: function (i, amp) {
        const o = v[i];
        const D = Math.max(8, Math.round(o.delay));
        const n = Math.min(D, MAXDELAY - 2);
        // 带限噪声填一个周期：先低通两道，避免刺耳的金属声
        let a = 0, b = 0;
        for (let k = 0; k < n; k++) {
          const w = Math.random() * 2 - 1;
          a += (w - a) * 0.55;
          b += (a - b) * 0.55;
          o.buf[k] = b * (amp === undefined ? 0.6 : amp) * 0.55;
        }
        o.idx = n % MAXDELAY;
        o.g = 0.99;
        o.energy = 0.5;
        o.agc = 1;
        o.agcBlocks = 0;
        o.mode = 'pizz';
        o.pizzTimer = sampleRate * 4.0;         // 拨弦后的自然余韵
        o.idle = false;
      },
      /** 起弓 / 持续：exc 是激励增益（0 = 离弓） */
      setBow: function (i, exc, gain) {
        if (i < 0 || i >= NV) return;
        v[i].excTarget = Math.max(0, exc);
        if (exc > 0) {
          v[i].idle = false;
          v[i].mode = 'bow';
          v[i].env = 0;                      // 5ms 淡入
        } else {
          v[i].mode = 'release';
        }
      },
      /**
       * 起弓"预填"：把延迟线按当前触弦点的梳状锯齿填满一个周期。
       *
       * 为什么不直接灌一段随机噪声：靠指板时 β≈1/3，第 3/6/9 次谐波被激励零点
       * 完全挖掉，而噪声会把它们"点亮"，它们又几乎不衰减（环路增益≈1），
       * 于是会跟被驱动的谐波打拍子 —— 听起来就是音量慢慢起伏。
       * 用与激励同源的梳状锯齿预填，被挖掉的谐波压根不会被激励，攻击又快又干净。
       */
      prefill: function (i, amp) {
        const o = v[i];
        const D = Math.max(8, Math.round(o.delay));
        const n = Math.min(D, MAXDELAY - 2);
        const beta = 0.33 - o.contact * 0.23;
        const back = Math.max(1, Math.round(beta * n));
        const a = amp === undefined ? 0.30 : amp;
        for (let k = 0; k < n; k++) {
          const s1 = 2 * (((k / n) % 1) + 1) % 2 - 1;
          const kd = ((k - back) % n + n) % n;
          const s2 = 2 * (((kd / n) % 1) + 1) % 2 - 1;
          o.buf[k] = (s1 - s2) * 0.5 * a;
        }
        o.idx = n % MAXDELAY;
        o.g = 0.995;
        o.energy = 0.3;
        o.agc = 1;
        o.agcBlocks = 0;
        o.mode = 'bow';
        o.env = 0;
        o.idle = false;
      },
      setContact: function (c) {
        for (let i = 0; i < NV; i++) v[i].contactTarget = Math.max(0, Math.min(1, c));
      },
      process: function (outL, outR, n) {
        for (let i = 0; i < NV; i++) {
          const o = v[i];
          if (o.idle) continue;
          const sp = o.speed * 1.6;
          let energyAcc = 0;
          for (let k = 0; k < n; k++) {
            // ---- 参数平滑（一阶低通，永不跳变）----
            o.freq += (o.targetFreq - o.freq) * sp;
            o.contact += (o.contactTarget - o.contact) * sp;
            o.exc += (o.excTarget - o.exc) * sp * 2.2;
            o.env += (1 - o.env) * 0.004;         // 起弓淡入（约 5ms）
            const D = Math.max(2.2, sampleRate / o.freq);

            // ---- 环路低通 = 阻尼：一阶低通，截止频率随触弦点移动 ----
            // 靠指板 ≈ 1.4kHz（高频衰减快 → 闷、柔）；靠琴桥 ≈ 13kHz（亮、紧）
            const cut = (1300 + 12000 * o.contact) * o.dampScale;
            const b = 1 - Math.exp(-6.283185307 * Math.min(0.45, cut / sampleRate));
            const w = 6.283185307 * Math.min(0.49, o.freq / sampleRate);
            const H = b / Math.sqrt(1 - 2 * (1 - b) * Math.cos(w) + (1 - b) * (1 - b));
            // 环路增益：目标增益除以该频率处的滤波器响应 —— 音色换了音高不跑、音量不飘。
            // 拉弦时几乎为 1（持续不衰减），离弓后降到 0.985（自然收弓）
            // 环路增益（每往返一次）：拉弦时几乎为 1（长按不衰减）；
            // 拨弦后慢慢余韵；离弓则快速收弓
            let want;
            if (o.mode === 'bow') want = 0.9965;
            else if (o.mode === 'pizz') {
              want = 0.9976;
              o.pizzTimer -= 1;
              if (o.pizzTimer <= 0) o.mode = 'release';
            } else want = 0.985;
            o.g += (Math.min(1.0, want / Math.max(0.12, H)) - o.g) * 0.02;

            // 环路低通的相位延迟要减掉，否则整条延迟线偏长、音准偏低
            const pd = -Math.atan2(-(1 - b) * Math.sin(w), 1 - (1 - b) * Math.cos(w)) / Math.max(1e-4, w);
            const Dl = Math.max(2.2, sampleRate / o.freq - pd);

            // ---- 读延迟线（分数延迟线性插值 = 连续滑音）----
            const dInt = Math.floor(Dl);
            const frac = Dl - dInt;
            let i0 = o.idx - dInt; while (i0 < 0) i0 += MAXDELAY;
            let i1 = i0 - 1; if (i1 < 0) i1 += MAXDELAY;
            const s1 = o.buf[i0], s2 = o.buf[i1];
            const sDelayed = s1 + (s2 - s1) * frac;
            // 阻尼：一阶低通（状态在环路里持续）
            o.lp = (1 - b) * o.lp + b * s1;
            const lp = o.lp;

            // ---- 激励：锯齿 + 少量噪声，再做激励点梳状滤波 ----
            let exc = 0;
            if (o.exc > 0.0002) {
              o.sawPhase += o.freq / sampleRate;
              if (o.sawPhase >= 1) o.sawPhase -= 1;
              const saw = 2 * o.sawPhase - 1;
              o.nz += (Math.random() * 2 - 1 - o.nz) * 0.25;
              o.nz2 += (o.nz - o.nz2) * 0.25;
              const noise = o.nz2 * 0.16;
              // 激励点 β：0 = 琴马，1 = 指板端；靠指板挖掉 3/6/9…
              // β 是"从琴马量起的相对位置"：靠指板 β≈1/3（挖掉 3/6/9 次谐波），靠琴桥 β≈1/10
              const beta = 0.33 - o.contact * 0.23;
              const hist = o.sawHist;
              const hlen = hist.length;
              const back = beta * D;
              const hInt = Math.floor(back);
              const hFrac = back - hInt;
              const hp = o.idx - hInt; const h0 = ((hp % hlen) + hlen) % hlen;
              const h1 = ((hp - 1) % hlen + hlen) % hlen;
              const combed = saw - (hist[h0] + (hist[h1] - hist[h0]) * hFrac);
              const noiseHist = o.nzLast === undefined ? 0 : o.nzLast;
              o.nzLast = noise;
              const nCombed = noise - noiseHist;
              hist[o.idx % hlen] = saw;
              // 幅度留给电平伺服（见下），这里只保证在"线性区"驱动：
              // 一旦激励大到让环路进入软饱和，响度就由非线性决定、伺服失去控制力，
              // 三个触弦点的响度就会差好几倍 —— 所以宁可给得小一点，让伺服补上来。
              exc = (combed * 0.9 + nCombed * 0.9) * o.exc * 0.0015 * o.agc;
            }

            // ---- 波导环路（软饱和做上限，防爆音）----
            let nv = lp * o.g + exc;
            if (nv > 1.6) nv = 1.6 + Math.tanh(nv - 1.6) * 0.5;
            else if (nv < -1.6) nv = -1.6 + Math.tanh(nv + 1.6) * 0.5;
            o.buf[o.idx] = nv;
            o.idx = (o.idx + 1) % MAXDELAY;

            // ---- 输出：取环路输出再过一道柔化，提升整体音量 ----
            o.out = (sDelayed * 0.65 + nv * 0.35) * o.env;
            const g = master * 0.9;
            outL[k] += o.out * g;
            outR[k] += o.out * g;
            energyAcc += o.out < 0 ? -o.out : o.out;
          }
          // 静音检测：彻底安静了就把这一路挂起（省 CPU，也不会有残余噪声）
          o.energy = o.energy * 0.96 + (energyAcc / n) * 0.04;
          energyAcc = 0;
          // 电平伺服：靠指板 / 中间 / 靠琴桥三个位置响度差太多（激励梳在两端差 2~3 倍，
          // 环路阻尼又各不同），这里用很慢的自动增益把响度拉平 —— 只管响度，
          // 不动频率、不动谐波结构，所以音色差异还在、音高一点不跑。
          if (o.exc > 0.0006) {
            const wantAgc = Math.max(0.04, Math.min(10.0, 0.10 / Math.max(0.002, o.energy)));
            // 前 0.4 秒快一点（起弓要马上到正常响度），之后慢下来（长按不飘）
            const rate = o.agcBlocks < 600 ? 0.12 : 0.008;
            o.agc += (wantAgc - o.agc) * rate;
            o.agcBlocks++;
          }
          if (o.exc < 0.0008 && o.excTarget <= 0 && o.energy < 0.0006) {
            o.idle = true;
            o.exc = 0;
            o.buf.fill(0);
          }
        }
        master += (masterTarget - master) * 0.02;
      }
    };
  }

  AUDIO.StringBank = StringBank;

  /* ------------------------------------------------------------ 状态 */
  const S = {
    ctx: null, node: null, worklet: null, fallback: null,
    ready: false, mode: 'none', freqs: [196, 293.66, 440, 659.26],
    bodyNodes: null, master: null, wet: null, dry: null,
    contact: 0.5, bowing: -1, bowedGain: 0.8
  };
  AUDIO.state = S;

  function workletSource() {
    return [
      'const Bank = (' + StringBank.toString() + ');',
      'class StringProcessor extends AudioWorkletProcessor {',
      '  constructor() {',
      '    super();',
      '    this.bank = Bank(sampleRate);',
      '    this.port.onmessage = (e) => {',
      '      const d = e.data;',
      '      if (d.type === "strings") this.bank.setStrings(d.value);',
      '      else if (d.type === "freq") this.bank.setFreq(d.i, d.value);',
      '      else if (d.type === "pluck") this.bank.pluck(d.i, d.value);',
      '      else if (d.type === "prefill") this.bank.prefill(d.i, d.value);',
      '      else if (d.type === "bow") this.bank.setBow(d.i, d.value, d.gain);',
      '      else if (d.type === "contact") this.bank.setContact(d.value);',
      '      else if (d.type === "master") this.bank.setMaster(d.value);',
      '      else if (d.type === "scale") this.bank.setScale(d.value);',
      '    };',
      '  }',
      '  process(inputs, outputs) {',
      '    const out = outputs[0];',
      '    const l = out[0], r = out[1] || out[0];',
      '    l.fill(0); if (r !== l) r.fill(0);',
      '    this.bank.process(l, r, l.length);',
      '    return true;',
      '  }',
      '}',
      'registerProcessor("string-bank", StringProcessor);'
    ].join('\n');
  }

  /** 程序生成的短混响脉冲响应 */
  function makeIR(ctx, seconds, size) {
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * seconds);
    const buf = ctx.createBuffer(2, len, sr);
    const rnd = [];
    let s = 22222;
    for (let i = 0; i < 4096; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      rnd.push((s / 0x7fffffff) * 2 - 1);
    }
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const env = Math.pow(1 - t, 2.4);
        const n = rnd[(i * 7 + ch * 131) % 4096];
        lp += (n - lp) * (0.28 / (1 + size * 0.7));
        d[i] = lp * env * (0.42 / Math.sqrt(1 + size));
      }
    }
    return buf;
  }

  /**
   * 初始化（必须在用户手势里调用 —— 浏览器要用户点一下才能出声）
   */
  AUDIO.init = function (opts) {
    opts = opts || {};
    if (S.ctx) {
      if (S.ctx.state === 'suspended') S.ctx.resume();
      return Promise.resolve(true);
    }
    const Ctx = global.AudioContext || global.webkitAudioContext;
    if (!Ctx) return Promise.resolve(false);
    const ctx = new Ctx({ latencyHint: 'interactive' });
    S.ctx = ctx;

    // 输出链：合成 → 琴体共振 → 干/湿 → 主音量 → 限幅 → 扬声器
    const master = ctx.createGain();
    master.gain.value = 0.85;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -8;
    comp.knee.value = 12;
    comp.ratio.value = 6;
    comp.attack.value = 0.006;
    comp.release.value = 0.18;
    master.connect(comp);
    comp.connect(ctx.destination);
    S.master = master;

    const dry = ctx.createGain();
    dry.gain.value = 0.86;
    dry.connect(master);
    const wet = ctx.createGain();
    wet.gain.value = 0.22;
    wet.connect(master);
    const conv = ctx.createConvolver();
    conv.buffer = makeIR(ctx, 1.15, 1);
    wet.connect(conv);
    conv.connect(master);
    S.dry = dry; S.wet = wet;

    // 琴体共振峰：一串 peaking 滤波器
    const peaks = [285, 460, 720, 1180, 2900];
    const peakQ = [1.6, 1.5, 1.4, 1.2, 0.9];
    const peakG = [3.0, 2.4, 3.0, 2.4, 3.5];
    let tail = ctx.createGain();
    tail.gain.value = 1;
    tail.connect(dry);
    tail.connect(wet);
    S.bodyNodes = [];
    for (let i = peaks.length - 1; i >= 0; i--) {
      const f = ctx.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = peaks[i];
      f.Q.value = peakQ[i];
      f.gain.value = peakG[i];
      f.userData = { base: peaks[i] };
      f.connect(tail);
      tail = f;
      S.bodyNodes.push(f);
    }
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 80;
    hp.connect(tail);
    S.tailIn = hp;

    const finish = function (ok) {
      S.ready = true;
      S.mode = ok ? 'worklet' : 'scriptprocessor';
      if (S.node && S.node.port) {
        S.node.port.postMessage({ type: 'strings', value: S.freqs });
        S.node.port.postMessage({ type: 'contact', value: S.contact });
      }
    };

    const useWorklet = (opts.worklet !== false) && ctx.audioWorklet && global.Blob && global.URL && URL.createObjectURL;
    if (useWorklet) {
      let url = null;
      try {
        url = URL.createObjectURL(new Blob([workletSource()], { type: 'application/javascript' }));
      } catch (e) { url = null; }
      if (url) {
        let mod = null;
        try {
          mod = ctx.audioWorklet.addModule(url);
        } catch (e) {
          mod = null;
        }
        if (!mod) return setupFallback(ctx, hp, finish);
        return mod.then(function () {
          const node = new AudioWorkletNode(ctx, 'string-bank', {
            numberOfInputs: 0, numberOfOutputs: 1,
            outputChannelCount: [2]
          });
          node.connect(hp);
          S.node = node;
          finish(true);
          S.ready = true;
          return true;
        }).catch(function () {
          S.workletError = arguments[0] && (arguments[0].message || String(arguments[0]));
          if (global.console && console.warn) {
            console.warn('[提琴工坊] AudioWorklet 起不来，退回 ScriptProcessor：' + S.workletError);
          }
          return setupFallback(ctx, hp, finish);
        });
      }
    }
    return setupFallback(ctx, hp, finish);
  };

  /** 退化路径：ScriptProcessorNode，缓冲区 4096 帧（约 93ms），主线程卡顿也不容易欠载 */
  function setupFallback(ctx, dest, finish) {
    if (!ctx.createScriptProcessor) { finish(false); return Promise.resolve(false); }
    const bank = StringBank(ctx.sampleRate);
    const node = ctx.createScriptProcessor(4096, 0, 2);
    node.onaudioprocess = function (e) {
      const l = e.outputBuffer.getChannelData(0);
      const r = e.outputBuffer.getChannelData(1);
      l.fill(0); r.fill(0);
      bank.process(l, r, l.length);
    };
    node.connect(dest);
    S.fallback = bank;
    S.node = null;
    finish(false);
    return Promise.resolve(false);
  }

  function post(msg) {
    if (S.node && S.node.port) S.node.port.postMessage(msg);
  }

  /** 设定四根弦的空弦频率（换乐器时调用） */
  AUDIO.setStrings = function (freqs) {
    S.freqs = freqs.slice();
    if (S.node && S.node.port) post({ type: 'strings', value: S.freqs });
    else if (S.fallback) S.fallback.setStrings(S.freqs);
    // 琴体共振峰随乐器尺寸整体挪一点
    if (S.bodyNodes && S.bodyNodes.length) {
      const shift = (freqs[3] / 659.26);
      S.bodyNodes.forEach(function (f) {
        f.frequency.value = f.userData.base / Math.pow(shift, 0.55);
      });
    }
  };

  AUDIO.setContact = function (c) {
    S.contact = c;
    post({ type: 'contact', value: c });
    if (S.fallback) S.fallback.setContact(c);
  };
  /** 乐器尺寸变了：环路阻尼截止频率跟着音区挪 */
  AUDIO.setScale = function (v) {
    S.scale = v;
    post({ type: 'scale', value: v });
    if (S.fallback) S.fallback.setScale(v);
  };
  AUDIO.setMaster = function (v) {
    post({ type: 'master', value: v });
    if (S.fallback) S.fallback.setMaster(v);
  };
  AUDIO.setFreq = function (i, hz) {
    post({ type: 'freq', i: i, value: hz });
    if (S.fallback) S.fallback.setFreq(i, hz);
  };
  AUDIO.pluck = function (i, amp) {
    post({ type: 'pluck', i: i, value: amp === undefined ? 0.75 : amp });
    if (S.fallback) S.fallback.pluck(i, amp);
  };
  /** 参考音：用专门的第 5 路（不打扰正在调的那根弦） */
  AUDIO.reference = function (freq, amp) {
    post({ type: 'freq', i: 4, value: freq });
    if (S.fallback) S.fallback.setFreq(4, freq);
    post({ type: 'pluck', i: 4, value: amp === undefined ? 0.6 : amp });
    if (S.fallback) S.fallback.pluck(4, amp);
  };
  /** 演奏：起弓 / 连弓改音 / 收弓 */
  /**
   * 起弓。
   * @param attack 1 = 有音头（弓"抓"上去那一下），0 = 软起音（连弓、不重新起弓的手感）
   *   两者的区别只在"预填"的幅度：有音头 = 0.30，软起音 = 0.10。
   *   之所以这么设计：预填是决定"听不听得见音头"的唯一因素，
   *   而它跟"这根弦上次是不是正在响"无关 —— 于是每个音的起音就统一了。
   */
  AUDIO.bowStart = function (i, hz, gain, contact, attack) {
    S.bowing = i;
    if (contact !== undefined) AUDIO.setContact(contact);
    post({ type: 'freq', i: i, value: hz });
    if (S.fallback) S.fallback.setFreq(i, hz);
    post({ type: 'bow', i: i, value: 0.55, gain: gain });
    if (S.fallback) S.fallback.setBow(i, 0.55, gain);
    const amp = attack ? 0.30 : 0.10;
    post({ type: 'prefill', i: i, value: amp });
    if (S.fallback) S.fallback.prefill(i, amp);
  };
  AUDIO.bowFreq = function (i, hz) {
    post({ type: 'freq', i: i, value: hz });
    if (S.fallback) S.fallback.setFreq(i, hz);
  };
  AUDIO.bowStop = function (i) {
    post({ type: 'bow', i: i, value: 0 });
    if (S.fallback) S.fallback.setBow(i, 0);
    if (S.bowing === i) S.bowing = -1;
  };
  AUDIO.stopAll = function () {
    S.bowing = -1;
    for (let i = 0; i < NSTR + 1; i++) {
      post({ type: 'bow', i: i, value: 0 });
      if (S.fallback) S.fallback.setBow(i, 0);
    }
  };
  AUDIO.resume = function () {
    if (S.ctx && S.ctx.state === 'suspended') return S.ctx.resume();
    return Promise.resolve();
  };
  AUDIO.mode = function () { return S.mode; };
  /** 退化到 ScriptProcessor 时的原因（排查用） */
  AUDIO.workletError = function () { return S.workletError || ''; };

  global.AUDIO = AUDIO;
  if (typeof module !== 'undefined' && module.exports) module.exports = AUDIO;
})(typeof window !== 'undefined' ? window : globalThis);
