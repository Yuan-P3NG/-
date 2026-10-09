/* =========================================================================
 * score.js —— 简谱解析 + 弦/指法分配 + 曲集
 *
 * 面向零基础学生：只认简谱。
 *   1 2 3 4 5 6 7      do re mi fa sol la si（1 = C）
 *   #4 / b7            升、降半音（写在数字前或后都行）
 *   1'                 高八度（可叠加），1, 低八度
 *   -                  把前一个音延长一拍
 *   _                  半拍，. 附点（1.5 倍），0 休止
 *   空格 / | / , / 、   都当分隔符
 * ========================================================================= */
(function (global) {
  'use strict';

  const S = {};
  const DEGREE = [0, 2, 4, 5, 7, 9, 11];
  const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  S.midiToFreq = function (m) { return 440 * Math.pow(2, (m - 69) / 12); };
  S.midiToName = function (m) {
    return SHARP[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  };
  /** 音名 → MIDI */
  S.nameToMidi = function (tok) {
    const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(tok);
    if (!m) return null;
    let v = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()];
    if (m[2] === '#') v += 1; else if (m[2] === 'b') v -= 1;
    return (parseInt(m[3], 10) + 1) * 12 + v;
  };

  /**
   * 解析乐谱
   * @param text 简谱或音名
   * @param base 简谱 1 对应的 MIDI
   */
  S.parse = function (text, base) {
    base = base === undefined ? 60 : base;
    const errors = [];
    const notes = [];
    const raw = String(text || '').replace(/[\u3000]/g, ' ');
    const tokens = raw.split(/[\s|｜、，,]+/).filter(function (t) { return t.length; });
    if (!tokens.length) return { notes: [], errors: ['还没有音符'], mode: 'jianpu' };
    let mode = 'jianpu';
    for (let i = 0; i < tokens.length; i++) {
      if (/^[A-Ga-g][#b]?-?\d$/.test(tokens[i])) { mode = 'abc'; break; }
    }
    let last = null;
    tokens.forEach(function (t) {
      if (/^[-–—]+$/.test(t)) {                    // 延长
        if (last) last.beats += t.length;
        return;
      }
      if (t === '_' || t === '.') {
        if (last) last.beats *= (t === '_' ? 0.5 : 1.5);
        return;
      }
      if (mode === 'abc') {
        if (/^[Rr0]$/.test(t)) { last = null; notes.push({ midi: null, beats: 1, rest: true, token: t }); return; }
        const midi = S.nameToMidi(t.replace(/[._]/g, ''));
        if (midi === null) { errors.push('看不懂的音符：' + t); return; }
        last = { midi: midi, beats: t.indexOf('_') >= 0 ? 0.5 : 1, rest: false, token: t };
        notes.push(last);
        return;
      }
      const tok = t.replace(/^([0-7])([#b])/, '$2$1');
      const m = /^([#b]?)([0-7])([',]*)(_?)(\.?)$/.exec(tok);
      if (!m) { errors.push('看不懂的音符：' + t); return; }
      const digit = parseInt(m[2], 10);
      const oct = m[3].split('').reduce(function (a, ch) { return a + (ch === "'" ? 1 : -1); }, 0);
      let beats = m[4] === '_' ? 0.5 : 1;
      if (m[5] === '.') beats *= 1.5;
      if (digit === 0) { last = null; notes.push({ midi: null, beats: beats, rest: true, token: t }); return; }
      let midi = base + DEGREE[digit - 1] + 12 * oct;
      if (m[1] === '#') midi += 1; else if (m[1] === 'b') midi -= 1;
      last = { midi: midi, beats: beats, rest: false, token: t };
      notes.push(last);
    });
    return { notes: notes, errors: errors, mode: mode };
  };

  /**
   * 给每个音分配：拉哪根弦、按在第几指、按弦位置比例
   * ratio = 1 − 2^(−n/12)，n = 比空弦高几个半音 —— 这正是"有效弦长"的比例。
   */
  S.assign = function (notes, openMidi) {
    let prev = -1;
    const out = notes.map(function (n) {
      if (n.rest || n.midi === null) {
        return { midi: null, beats: n.beats, rest: true, string: -1, pos: 0, ratio: 0, finger: -1 };
      }
      let best = -1, bestPos = 0, bestCost = Infinity;
      for (let i = 0; i < openMidi.length; i++) {
        const pos = n.midi - openMidi[i];
        if (pos < 0 || pos > 12) continue;
        let cost = pos;
        if (prev >= 0 && i !== prev) cost += 3;         // 尽量少换弦
        if (cost < bestCost) { bestCost = cost; best = i; bestPos = pos; }
      }
      if (best < 0) {                                   // 超出常用音域：用最接近的高弦
        best = 0; bestPos = 0;
        for (let i = 0; i < openMidi.length; i++) {
          const pos = n.midi - openMidi[i];
          if (pos >= 0) { best = i; bestPos = pos; }
        }
      }
      prev = best;
      let finger;
      if (bestPos === 0) finger = 0;
      else if (bestPos <= 2) finger = 1;
      else if (bestPos <= 4) finger = 2;
      else if (bestPos <= 5) finger = 3;
      else if (bestPos <= 7) finger = 4;
      else finger = 5;
      return {
        midi: n.midi, beats: n.beats, rest: false,
        string: best, pos: bestPos,
        ratio: 1 - Math.pow(2, -bestPos / 12),
        open: openMidi[best], finger: finger
      };
    });
    return out;
  };

  /** 整体移调八度，塞进乐器的音域 */
  S.fitRange = function (notes, low, high) {
    const real = notes.filter(function (n) { return !n.rest && n.midi !== null; });
    if (!real.length) return 0;
    let lo = Math.min.apply(null, real.map(function (n) { return n.midi; }));
    let hi = Math.max.apply(null, real.map(function (n) { return n.midi; }));
    let shift = 0;
    while (hi + shift > high && shift > -36) shift -= 12;
    while (lo + shift < low && shift < 36) shift += 12;
    if (shift) notes.forEach(function (n) { if (!n.rest && n.midi !== null) n.midi += shift; });
    return shift;
  };

  /** 演奏键：1..= 对应 12 个半音 */
  S.KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];

  /** 曲集：五首耳熟能详的旋律（简谱，落在一个八度里，正好对应 12 个演奏键） */
  S.PRESETS = [
    { name: '小星星', text: '1 1 5 5 6 6 5 - 4 4 3 3 2 2 1 -' },
    { name: '两只老虎', text: '1 2 3 1 1 2 3 1 3 4 5 - 3 4 5 -' },
    { name: '欢乐颂', text: '3 3 4 5 5 4 3 2 1 1 2 3 3 - 2 -' },
    { name: '生日快乐', text: "5_ 5_ 6 5 1' 7 5_ 5_ 6 5 2' 1'" },
    { name: '玛丽有只小羊羔', text: '3 2 1 2 3 3 3 - 2 2 2 - 3 5 5 -' }
  ];

  global.SCORE = S;
  if (typeof module !== 'undefined' && module.exports) module.exports = S;
})(typeof window !== 'undefined' ? window : globalThis);
