/* 校园大乱斗 - Survivors-like H5 小游戏
 * 纯原生 JS + Canvas，角色/怪物使用 assets/game-atlas 的 532 帧动画素材。
 */
(function () {
  'use strict';

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const $ = (id) => document.getElementById(id);
  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const dist2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
  const TAU = Math.PI * 2;
  const damp = (a, b, k, dt) => a + (b - a) * Math.min(1, k * dt);
  // 主角基础移速：135。体育委员角色加成/风油精被动在此之上叠乘。
  const PLAYER_BASE_SPEED = 135;
  // 受击后无敌时间（秒）：期间不再受任何伤害，角色闪烁提示。
  const INVULN_TIME = 0.8;
  // 老师粉笔弹道速度：原来的 0.6 倍（250 → 150），飞行更慢、更易看清躲避。
  const ENEMY_CHALK_SPEED = 150;
  // 怪物移动速度总倍率：现有速度的 0.7 倍（含 BOSS；狂暴仍在此基础上叠乘）。
  const ENEMY_SPEED_MUL = 0.7;
  // 角色视觉缩放：让角色可见高度 ≈ 屏幕高度的 1/10（自适应屏幕）。
  // 图集单格高 112px，其中角色可见部分约占 85%，故绘制缩放 = H / (10 × 112 × 0.85) ≈ H/952。
  const CELL_H = 112;
  let VIS = 1;

  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * DPR; canvas.height = H * DPR;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    VIS = clamp(H / (10 * CELL_H * 0.85), 0.25, 2);
  }
  window.addEventListener('resize', resize);
  resize();

  // ---------- 精灵图集 ----------
  const ATL = window.GAME_ATLAS || { cellW: 96, cellH: 112, cols: 8, chars: {} };
  const IMG = {};
  for (const id in ATL.chars) {
    const im = new Image();
    im.src = 'assets/game-atlas/' + ATL.chars[id].file;
    IMG[id] = im;
  }
  function fallbackDir(id, dir) {
    const info = ATL.chars[id];
    if (!info || !info.frames) return dir || 'down';
    if (info.frames['idle_' + dir] !== undefined) return dir;
    if (dir && dir.indexOf('left') >= 0) return 'downleft';
    return 'downright';
  }
  function frameIndex(id, key) {
    const info = ATL.chars[id];
    if (!info || !info.frames) return -1;
    if (info.frames[key] !== undefined) return info.frames[key];
    return info.frames['idle_' + fallbackDir(id, key.split('_').pop())];
  }
  // x,y 为角色脚底位置
  function drawSprite(id, state, dir, x, y, scale, alpha) {
    const img = IMG[id];
    if (!img || !img.complete || !img.naturalWidth) return;
    const key = state + '_' + fallbackDir(id, dir);
    const idx = frameIndex(id, key);
    if (idx === undefined || idx < 0) return;
    const sx = (idx % ATL.cols) * ATL.cellW, sy = Math.floor(idx / ATL.cols) * ATL.cellH;
    const w = ATL.cellW * scale, h = ATL.cellH * scale;
    ctx.save();
    if (alpha !== undefined && alpha < 1) ctx.globalAlpha = alpha;
    ctx.drawImage(img, sx, sy, ATL.cellW, ATL.cellH, x - w / 2, y - h + 3 * scale, w, h);
    ctx.restore();
  }
  function shadow(x, y, rx) {
    ctx.fillStyle = 'rgba(30,55,45,.22)';
    ctx.beginPath(); ctx.ellipse(x, y - 1, rx, rx * .38, 0, 0, TAU); ctx.fill();
  }

  // ---------- 音效 ----------
  const Sound = {
    ac: null, muted: false,
    init() { if (!this.ac) { try { this.ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} } },
    tone(freq, dur, type, vol, slide) {
      if (this.muted || !this.ac) return;
      const t = this.ac.currentTime, o = this.ac.createOscillator(), g = this.ac.createGain();
      o.type = type || 'square'; o.frequency.setValueAtTime(freq, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, slide), t + dur);
      g.gain.setValueAtTime(vol || .05, t);
      g.gain.exponentialRampToValueAtTime(.0001, t + dur);
      o.connect(g); g.connect(this.ac.destination); o.start(t); o.stop(t + dur + .02);
    },
    shoot() { this.tone(760, .07, 'square', .022, 380); },
    hit() { this.tone(200, .06, 'sawtooth', .025, 110); },
    hurt() { this.tone(240, .22, 'sawtooth', .07, 70); },
    pickup() { this.tone(920, .06, 'sine', .03, 1380); },
    level() { this.tone(560, .15, 'sine', .07, 1000); setTimeout(() => this.tone(840, .2, 'sine', .06, 1320), 110); },
    boom() { this.tone(95, .34, 'sawtooth', .085, 35); },
    bell() { this.tone(880, .3, 'sine', .07, 660); },
    click() { this.tone(520, .05, 'square', .025, 720); }
  };

  // ---------- 主角 ----------
  const HEROES = {
    xiaopangdun: { name: '小胖墩', skill: '我是奶龙', desc: '生命+20% · 恢复+30%', color: '#fff2cf', hpMul: 1.2, regen: 1.0, atlas: 'hero_xiaopangdun' },
    xueba:       { name: '学霸',   skill: '叫我爸霸', desc: '技能4选1 · 经验+10%', color: '#e3f2ff', choices: 4, expMul: 1.1, atlas: 'hero_xueba' },
    tiyuweiyan:  { name: '体育委员', skill: '你敢拦我?', desc: '移速+10% · 攻击+10%', color: '#e8f9e6', spdMul: 1.1, powMul: 1.1, atlas: 'hero_tiyuweiyan' },
    jilinggui:   { name: '机灵鬼', skill: '莫挨老子', desc: '攻速+10% · 暴击+10%', color: '#f6e8ff', aspdMul: 1.1, critBonus: .10, atlas: 'hero_jilinggui' },
    banhua:      { name: '班花',   skill: '哥哥你好', desc: '魅惑8秒 · 刷新+1', color: '#ffe9f0', charm: true, reroll: 1, atlas: 'hero_banhua' }
  };

  // ---------- 武器 / 被动 ----------
  const WEAPONS = {
    chalk:      { name: '粉笔头', icon: '📏', color: '#e3f0ff', max: 8, desc: '向最近的敌人投出粉笔头' },
    notebook:   { name: '作业本', icon: '📕', color: '#ffe0e0', max: 8, desc: '作业本环绕身边，碰到就打' },
    pointer:    { name: '教鞭',   icon: '🪄', color: '#fff0c9', max: 8, desc: '周期性横扫身前的敌人' },
    basketball: { name: '篮球',   icon: '🏀', color: '#ffe2c4', max: 8, desc: '弹跳的篮球落地造成范围伤害' },
    compass:    { name: '圆规',   icon: '📐', color: '#e6dcff', max: 8, desc: '追踪敌人并穿刺而过' }
  };
  const PASSIVES = {
    power:      { name: '大力Water', icon: '💪', color: '#ffd9d0', max: 5, desc: '所有伤害 +20%' },
    speed:      { name: '风油精',   icon: '🌬️', color: '#d6f4ff', max: 5, desc: '移动速度 +12%' },
    medkit:     { name: '校医包',   icon: '🩹', color: '#d9ffe2', max: 5, desc: '每秒恢复 +1.2 生命' },
    glasses:    { name: '眼镜',     icon: '👓', color: '#e8e4ff', max: 5, desc: '暴击率 +8%' },
    calculator: { name: '计算器',   icon: '🧮', color: '#fff2cc', max: 5, desc: '获得经验 +18%' },
    pencilcase: { name: '文具盒',   icon: '✏️', color: '#e0f7fa', max: 5, desc: '经验拾取范围 +40%' }
  };

  // ---------- 敌人 ----------
  const ENEMIES = {
    tiaodanxuesheng: { name: '捣蛋学生', hp: 16, speed: 78,  dmg: 8,  r: 15, exp: 1,  behavior: 'melee',   atkRange: 30,  atkCd: 1.0, color: '#e05a5a', atlas: 'mob_tiaodanxuesheng' },
    lurenjia:        { name: '路人甲',   hp: 22, speed: 74,  dmg: 9,  r: 16, exp: 1,  behavior: 'melee',   atkRange: 44,  atkCd: 1.1, color: '#c95555', atlas: 'mob_lurenjia' },
    fantangdama:     { name: '饭堂大妈', hp: 90, speed: 42,  dmg: 0,  r: 21, exp: 4,  behavior: 'healer',  atkCd: 4.0,  color: '#b54848', atlas: 'mob_fantangdama' },
    laoshi:          { name: '老师',     hp: 18, speed: 52,  dmg: 7,  r: 15, exp: 2,  behavior: 'ranged',  atkRange: 240, atkCd: 2.0, color: '#d05555', atlas: 'mob_laoshi' },
    tiyusheng:       { name: '体育生',   hp: 44, speed: 138, dmg: 12, r: 17, exp: 3,  behavior: 'melee',   atkRange: 32,  atkCd: .7,  color: '#c84646', atlas: 'mob_tiyusheng' },
    xiaopihai:       { name: '小屁孩',   hp: 8,  speed: 158, dmg: 5,  r: 12, exp: 1,  behavior: 'rusher',  color: '#e06b6b', atlas: 'mob_xiaopihai' },
    baoan:           { name: '保安',     hp: 95, speed: 72,  dmg: 18, r: 22, exp: 5,  behavior: 'charger', atkRange: 170, atkCd: 3.0, color: '#9e3535', atlas: 'mob_baoan' },
    banzhuren:       { name: '班主任',   hp: 520, speed: 58, dmg: 14, r: 30, exp: 60,  boss: 1, skillCd: 7, color: '#d43434', atlas: 'boss_banzhuren' },
    jiaodaozhuren:   { name: '教导主任', hp: 900, speed: 80, dmg: 18, r: 33, exp: 100, boss: 2, skillCd: 6, color: '#a31616', atlas: 'boss_jiaodaozhuren' }
  };

  const DIRS8 = ['right', 'downright', 'down', 'downleft', 'left', 'upleft', 'up', 'upright'];
  function dirFrom(dx, dy, isHero) {
    let i = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
    if (i < 0) i += 8;
    if (isHero) return DIRS8[i % 8];
    if (i <= 1) return 'downright';
    if (i <= 3) return 'downleft';
    if (i <= 5) return 'upleft';
    return 'upright';
  }

  // ---------- 游戏状态 ----------
  const G = {
    state: 'menu', heroId: 'xiaopangdun', t: 0, time: 0, kills: 0, level: 1,
    player: null, enemies: [], gems: [], bullets: [], hazards: [], particles: [], texts: [],
    cam: { x: 0, y: 0 }, shake: 0,
    spawnT: 0, nextBoss1: 300, nextBoss2: 600, bossAlive: null,
    weapons: {}, passives: {}, acc: 0, expNext: 8, rerollsLeft: 0,
    keys: {}, joy: { active: false, dx: 0, dy: 0, cx: 0, cy: 0, id: null },
    fire: {}, orbitAngle: 0, introStep: 0
  };

  function freshPlayer() {
    const h = HEROES[G.heroId];
    const maxhp = Math.round(100 * (h.hpMul || 1));
    return {
      x: 0, y: 0, r: 13 * VIS, hp: maxhp, maxhp,
      speed: PLAYER_BASE_SPEED * (h.spdMul || 1), power: h.powMul || 1,
      aspd: h.aspdMul || 1, crit: .05 + (h.critBonus || 0), critDmg: 1.5,
      dodge: 0, armor: 1, pickup: 46, expMul: h.expMul || 1,
      regen: h.regen || 0,
      dir: 'down', hurtT: 0, atkT: 0, invuln: 0, charmT: 0, walk: 0, moving: false
    };
  }

  // ---------- 存档 ----------
  const SAVE_KEY = 'campus_brawl_best_v1';
  function loadBest() { try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || { time: 0, kills: 0 }; } catch (e) { return { time: 0, kills: 0 }; } }
  function saveBest(b) { try { localStorage.setItem(SAVE_KEY, JSON.stringify(b)); } catch (e) {} }
  function fmtTime(s) { const m = Math.floor(s / 60), ss = Math.floor(s % 60); return String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0'); }

  // ---------- 流程 ----------
  function show(ids) { ids.forEach(id => $(id).classList.remove('hidden')); }
  function hide(ids) { ids.forEach(id => $(id).classList.add('hidden')); }
  const HUD_IDS = ['hud', 'pause-btn', 'mute-btn', 'joystick'];

  function goMenu() {
    G.state = 'menu';
    hide(HUD_IDS.concat(['gameover', 'paused', 'levelup', 'hero-select', 'intro', 'how', 'boss-wrap']));
    show(['menu']); refreshBest();
  }
  function openHeroSelect() { Sound.click(); G.state = 'hero-select'; hide(['menu']); show(['hero-select']); }
  function pickHero(id) {
    G.heroId = id; Sound.click(); hide(['hero-select']);
    G.introStep = 0; G.state = 'intro';
    $('intro-text').textContent = '昨夜，全校师生被神秘的「纪律因子」洗脑了！';
    show(['intro']);
  }
  function introNext() {
    if (G.state !== 'intro') return;
    Sound.click();
    G.introStep++;
    if (G.introStep === 1) {
      $('intro-text').textContent = '只剩你还清醒——用文具和拳头，打醒他们，活到放学！';
    } else if (G.introStep >= 2) {
      hide(['intro']); startGame();
    }
  }
  function startGame() {
    Sound.init(); Sound.bell();
    G.state = 'playing'; G.time = 0; G.kills = 0; G.level = 1; G.t = 0;
    G.player = freshPlayer();
    G.enemies.length = 0; G.gems.length = 0; G.bullets.length = 0;
    G.hazards.length = 0; G.particles.length = 0; G.texts.length = 0;
    G.weapons = { chalk: 1 }; G.passives = {};
    G.acc = 0; G.expNext = 8; G.rerollsLeft = 0; G.fire = {};
    G.spawnT = 0; G.nextBoss1 = 300; G.nextBoss2 = 600; G.bossAlive = null;
    G.cam.x = 0; G.cam.y = 0; G.shake = 0;
    hide(['menu', 'gameover', 'levelup', 'paused', 'how', 'hero-select', 'intro', 'boss-wrap']);
    show(HUD_IDS);
    updateHUD(); renderSkills();
    last = performance.now();
  }

  // ---------- 输入 ----------
  window.addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    G.keys[k] = true;
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
    if (G.state === 'intro') { introNext(); return; }
    if (k === 'p' || k === 'escape') { if (G.state === 'playing') pause(); else if (G.state === 'paused') resume(); }
  });
  window.addEventListener('keyup', e => { G.keys[e.key.toLowerCase()] = false; });

  const joyBase = $('joy-base'), joyKnob = $('joy-knob'), joyZone = $('joystick');
  function joyStart(e) {
    if (G.state !== 'playing') return;
    const t = e.changedTouches ? e.changedTouches[0] : e;
    G.joy.active = true; G.joy.id = t.identifier != null ? t.identifier : 'mouse';
    G.joy.cx = t.clientX; G.joy.cy = t.clientY;
    joyBase.style.left = (G.joy.cx - 54) + 'px'; joyBase.style.top = (G.joy.cy - 54) + 'px';
    joyKnob.style.left = (G.joy.cx - 23) + 'px'; joyKnob.style.top = (G.joy.cy - 23) + 'px';
    joyBase.style.opacity = .8; joyKnob.style.opacity = .9;
  }
  function joyMove(e) {
    if (!G.joy.active) return;
    let t = null;
    if (e.changedTouches) { for (const c of e.changedTouches) if (c.identifier === G.joy.id) t = c; }
    else t = e;
    if (!t) return;
    let dx = t.clientX - G.joy.cx, dy = t.clientY - G.joy.cy;
    const d = Math.hypot(dx, dy), max = 48;
    if (d > max) { dx = dx / d * max; dy = dy / d * max; }
    G.joy.dx = dx / max; G.joy.dy = dy / max;
    joyKnob.style.left = (G.joy.cx + dx - 23) + 'px'; joyKnob.style.top = (G.joy.cy + dy - 23) + 'px';
  }
  function joyEnd() { G.joy.active = false; G.joy.dx = 0; G.joy.dy = 0; joyBase.style.opacity = 0; joyKnob.style.opacity = 0; }
  joyZone.addEventListener('touchstart', e => { e.preventDefault(); joyStart(e); }, { passive: false });
  joyZone.addEventListener('touchmove', e => { e.preventDefault(); joyMove(e); }, { passive: false });
  joyZone.addEventListener('touchend', e => { e.preventDefault(); joyEnd(); }, { passive: false });
  joyZone.addEventListener('mousedown', joyStart);
  window.addEventListener('mousemove', e => { if (G.joy.active && G.joy.id === 'mouse') joyMove(e); });
  window.addEventListener('mouseup', () => { if (G.joy.id === 'mouse') joyEnd(); });
  $('intro').addEventListener('click', introNext);

  // ---------- 生成实体 ----------
  function spawnEnemy(type, near) {
    const t = ENEMIES[type];
    let x, y;
    if (near) { x = near.x; y = near.y; }
    else {
      const a = rand(0, TAU), d = rand(Math.max(W, H) * .55, Math.max(W, H) * .78);
      x = G.player.x + Math.cos(a) * d; y = G.player.y + Math.sin(a) * d;
    }
    const scale = 1 + G.time / 300;
    const hp = Math.round(t.hp * (t.boss ? 1 : scale));
    G.enemies.push({
      type, x, y, r: t.r * VIS, hp, maxhp: hp, speed: t.speed * ENEMY_SPEED_MUL, dmg: t.dmg, exp: t.exp,
      boss: t.boss || 0, behavior: t.behavior || 'boss', atlas: t.atlas,
      dir: 'down', hurtT: 0, atkT: 0, atkCd: rand(.5, t.atkCd || 2),
      moving: false, phase: rand(0, TAU), flash: 0, hitCd: 0,
      chargeT: 0, chargeVX: 0, chargeVY: 0, vanish: 0,
      skillT: t.skillCd || 8, skillIdx: 0, enraged: false,
      charm: 0, buffT: 0, bagLeft: 0, bagT: 0, dead: false
    });
  }
  function spawnGem(x, y, exp) {
    G.gems.push({ x, y, exp, r: 5, t: rand(0, TAU), vx: rand(-40, 40), vy: rand(-40, 40) });
  }
  function burst(x, y, color, n, spd) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU), s = rand(spd * .3, spd);
      G.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(.3, .7), max: .7, color, r: rand(1.5, 3.5) });
    }
  }
  function dmgText(x, y, val, color, size) {
    G.texts.push({ x, y, val: String(val), color: color || '#fff', size: size || 14, life: .8 });
  }
  function nearestEnemies(n) {
    const pl = G.player;
    return G.enemies.filter(e => !e.dead && !e.charm).sort((a, b) => dist2(a.x, a.y, pl.x, pl.y) - dist2(b.x, b.y, pl.x, pl.y)).slice(0, n);
  }
  function fireBullet(o) { G.bullets.push(Object.assign({ x: 0, y: 0, vx: 0, vy: 0, r: 6, dmg: 10, life: 1.4, hit: [], color: '#fff', kind: 'chalk', friendly: true }, o)); }

  // ---------- 伤害 ----------
  function playerDamage(dmg, fromX, fromY) {
    const pl = G.player;
    if (pl.invuln > 0 || G.state !== 'playing') return;
    if (pl.dodge > 0 && Math.random() < pl.dodge) { dmgText(pl.x, pl.y - 22, '闪避!', '#42a5f5'); return; }
    const v = Math.max(1, Math.round(dmg * pl.armor));
    pl.hp -= v; pl.invuln = INVULN_TIME; pl.hurtT = .6;
    const a = Math.atan2(pl.y - fromY, pl.x - fromX);
    pl.x += Math.cos(a) * 9; pl.y += Math.sin(a) * 9;
    dmgText(pl.x, pl.y - 26, '-' + v, '#d32f2f', 16);
    G.shake = 9; Sound.hurt(); updateHUD();
    if (pl.hp <= 0) { pl.hp = 0; gameOver(false); }
  }
  function damageEnemy(e, dmg, crit) {
    if (e.dead) return;
    const v = Math.max(1, Math.round(dmg));
    e.hp -= v; e.hurtT = .6; e.flash = .12;
    dmgText(e.x + rand(-7, 7), e.y - e.r - 12, v, crit ? '#ffca28' : '#fff', crit ? 18 : 14);
    if (crit) burst(e.x, e.y - 8, '#ffca28', 5, 90);
    if (e.hp <= 0) {
      e.dead = true;
      if (e.charm <= 0) { G.kills++; spawnGem(e.x, e.y, e.exp); }
      burst(e.x, e.y - 8, e.color, e.boss ? 34 : 8, e.boss ? 260 : 130);
      if (e.boss) {
        Sound.boom(); G.shake = 15;
        showToast(e.type === 'banzhuren' ? '班主任恢复神志！' : '教导主任恢复神志！');
        if (G.bossAlive === e) { G.bossAlive = null; hide(['boss-wrap']); }
        if (e.type === 'jiaodaozhuren') { setTimeout(() => { if (G.state === 'playing') gameOver(true); }, 900); }
      } else Sound.hit();
      updateHUD();
    }
  }
  function critRoll() {
    const pl = G.player;
    return Math.random() < pl.crit ? pl.critDmg : 1;
  }

  // ---------- 升级 ----------
  function gainExp(amount) {
    const pl = G.player, gain = amount * pl.expMul;
    G.acc += gain;
    while (G.acc >= G.expNext) {
      G.acc -= G.expNext; G.level++;
      G.expNext = Math.floor(G.expNext * 1.32) + 4;
      openLevelUp();
    }
    updateHUD();
  }
  let currentPool = [];
  function rollPool() {
    const pool = [];
    for (const k in WEAPONS) {
      const lv = G.weapons[k] || 0;
      if (lv < WEAPONS[k].max) pool.push({ kind: 'weapon', key: k, lv, ...WEAPONS[k] });
    }
    for (const k in PASSIVES) {
      const lv = G.passives[k] || 0;
      if (lv < PASSIVES[k].max) pool.push({ kind: 'passive', key: k, lv, ...PASSIVES[k] });
    }
    pool.sort(() => Math.random() - .5);
    return pool;
  }
  function buildCards() {
    const n = HEROES[G.heroId].choices || 3;
    currentPool = rollPool();
    const picks = currentPool.slice(0, n);
    const cards = $('cards'); cards.innerHTML = '';
    picks.forEach(p => {
      const div = document.createElement('div'); div.className = 'card';
      div.innerHTML = '<div class="ic" style="background:' + p.color + '">' + p.icon + '</div>' +
        '<div class="nm">' + p.name + '</div><div class="ds">' + p.desc + '</div>' +
        '<div class="lvtag">' + (p.lv === 0 ? '新获得' : 'Lv.' + p.lv + ' → ' + (p.lv + 1)) + '</div>';
      div.onclick = () => { Sound.click(); applyPick(p); closeLevelUp(); };
      cards.appendChild(div);
    });
    const rr = $('reroll-btn');
    if (G.rerollsLeft > 0 && currentPool.length > n) {
      rr.classList.remove('hidden'); rr.textContent = '🔄 刷新（剩 ' + G.rerollsLeft + ' 次）';
      rr.onclick = () => { Sound.click(); G.rerollsLeft--; buildCards(); };
    } else rr.classList.add('hidden');
  }
  function openLevelUp() {
    G.state = 'levelup'; Sound.level();
    if (HEROES[G.heroId].reroll) G.rerollsLeft = HEROES[G.heroId].reroll;
    buildCards(); show(['levelup']);
  }
  function closeLevelUp() { hide(['levelup']); G.state = 'playing'; last = performance.now(); }
  function applyPick(p) {
    if (p.kind === 'weapon') G.weapons[p.key] = (G.weapons[p.key] || 0) + 1;
    else {
      G.passives[p.key] = (G.passives[p.key] || 0) + 1;
      const pl = G.player, lv = G.passives[p.key];
      switch (p.key) {
        case 'power': pl.power = 1 + lv * .2; break;
        case 'speed': pl.speed = PLAYER_BASE_SPEED * (HEROES[G.heroId].spdMul || 1) * (1 + lv * .12); break;
        case 'medkit': pl.regen += 1.2; break;
        case 'glasses': pl.crit += .08; break;
        case 'calculator': pl.expMul = (HEROES[G.heroId].expMul || 1) * (1 + lv * .18); break;
        case 'pencilcase': pl.pickup = 46 * (1 + lv * .4); break;
      }
    }
    renderSkills(); updateHUD();
  }
  function renderSkills() {
    const box = $('skills'); box.innerHTML = '';
    for (const k in G.weapons) if (G.weapons[k] > 0) addChip(G.weapons[k], WEAPONS[k]);
    for (const k in G.passives) if (G.passives[k] > 0) addChip(G.passives[k], PASSIVES[k]);
    function addChip(lv, s) {
      const d = document.createElement('div'); d.className = 'skill-chip';
      d.innerHTML = '<div class="ic" style="background:' + s.color + '">' + s.icon + '</div><span class="lv">Lv.' + lv + '</span>';
      box.appendChild(d);
    }
  }

  // ---------- 武器更新 ----------
  function updateWeapons(dt) {
    const pl = G.player;
    G.orbitAngle += dt * 1.8;

    if (G.weapons.chalk) {
      const lv = G.weapons.chalk;
      G.fire.chalk = (G.fire.chalk || 0) - dt;
      if (G.fire.chalk <= 0) {
        G.fire.chalk = Math.max(.26, .72 - lv * .055) / pl.aspd;
        const ts = nearestEnemies(1 + Math.floor(lv / 3));
        if (ts.length) {
          const base = Math.atan2(ts[0].y - pl.y, ts[0].x - pl.x);
          const count = 1 + Math.floor((lv - 1) / 2);
          for (let i = 0; i < count; i++) {
            const a = base + (i - (count - 1) / 2) * .17;
            fireBullet({ x: pl.x, y: pl.y, vx: Math.cos(a) * 470, vy: Math.sin(a) * 470,
              r: 6, dmg: 10 * pl.power * critRoll(), color: '#ffffff', kind: 'chalk', rot: a, pierce: 0 });
          }
          pl.atkT = .22; Sound.shoot();
        }
      }
    }
    if (G.weapons.notebook) {
      const lv = G.weapons.notebook, count = 2 + Math.floor(lv / 2), radius = 58 + lv * 4;
      for (let i = 0; i < count; i++) {
        const a = G.orbitAngle * 1.5 + i / count * TAU;
        const bx = pl.x + Math.cos(a) * radius, by = pl.y + Math.sin(a) * radius;
        G.enemies.forEach(e => {
          if (!e.dead && !e.charm && e.hitCd <= 0 && dist2(bx, by, e.x, e.y) < (13 + e.r) * (13 + e.r)) {
            damageEnemy(e, (9 + lv * 4) * pl.power * critRoll()); e.hitCd = .45;
          }
        });
      }
    }
    if (G.weapons.pointer) {
      const lv = G.weapons.pointer;
      G.fire.pointer = (G.fire.pointer || 0) - dt;
      if (G.fire.pointer <= 0) {
        G.fire.pointer = Math.max(.85, 2.0 - lv * .15) / pl.aspd;
        // 优先朝最近的敌人横扫，无敌人时沿面朝方向
        const near = nearestEnemies(1)[0];
        const a = near ? Math.atan2(near.y - pl.y, near.x - pl.x) : DIRS8.indexOf(pl.dir) * Math.PI / 4;
        const R = 72 + lv * 8;
        let hit = false;
        G.enemies.forEach(e => {
          if (e.dead || e.charm) return;
          const d = Math.hypot(e.x - pl.x, e.y - pl.y), ea = Math.atan2(e.y - pl.y, e.x - pl.x);
          let diff = Math.abs(((ea - a + Math.PI * 3) % TAU) - Math.PI);
          if (d < R + e.r && diff < .95) { damageEnemy(e, (12 + lv * 5) * pl.power * critRoll()); hit = true; }
        });
        G.hazards.push({ type: 'slash', x: pl.x, y: pl.y, a, r: R, life: .22, max: .22 });
        if (hit) pl.atkT = .22;
        Sound.tone(420, .09, 'square', .02, 180);
      }
    }
    if (G.weapons.basketball) {
      const lv = G.weapons.basketball;
      G.fire.basketball = (G.fire.basketball || 0) - dt;
      if (G.fire.basketball <= 0) {
        G.fire.basketball = Math.max(1.3, 3.2 - lv * .2) / pl.aspd;
        // 优先落在最近的敌人附近，无敌人时才随机方向
        const near = nearestEnemies(1)[0];
        const a = near ? Math.atan2(near.y - pl.y, near.x - pl.x) : rand(0, TAU);
        G.hazards.push({ type: 'ball', x: pl.x + Math.cos(a) * 90, y: pl.y + Math.sin(a) * 90,
          r: 48 + lv * 6, life: .65, max: .65, dmg: (14 + lv * 6) * pl.power, hits: [] });
        Sound.tone(180, .12, 'sine', .04, 90);
      }
    }
    if (G.weapons.compass) {
      const lv = G.weapons.compass;
      G.fire.compass = (G.fire.compass || 0) - dt;
      if (G.fire.compass <= 0) {
        G.fire.compass = Math.max(.8, 2.0 - lv * .13) / pl.aspd;
        const ts = nearestEnemies(1);
        if (ts.length) {
          const a = Math.atan2(ts[0].y - pl.y, ts[0].x - pl.x);
          fireBullet({ x: pl.x, y: pl.y, vx: Math.cos(a) * 300, vy: Math.sin(a) * 300,
            r: 8, dmg: (16 + lv * 7) * pl.power * critRoll(), color: '#b39ddb', kind: 'compass',
            home: 4.5, pierce: 1 + Math.floor(lv / 2), life: 2.2, rot: a });
          pl.atkT = .22; Sound.shoot();
        }
      }
    }
  }

  // ---------- BOSS 技能 ----------
  function bossSkill(e) {
    const pl = G.player;
    if (e.type === 'banzhuren') {
      switch (e.skillIdx++ % 3) {
        case 0: { // 天女散花
          const base = Math.atan2(pl.y - e.y, pl.x - e.x);
          for (let i = -3; i <= 3; i++) {
            const a = base + i * .17;
            fireBullet({ x: e.x, y: e.y, vx: Math.cos(a) * 240, vy: Math.sin(a) * 240,
              r: 7, dmg: e.dmg, life: 3, color: '#fff', kind: 'enemy', friendly: false, rot: a });
          }
          showToast('📢 天女散花！'); Sound.shoot(); break;
        }
        case 1: { // 夺命三角尺
          const base = Math.atan2(pl.y - e.y, pl.x - e.x);
          for (let i = -1; i <= 1; i++) {
            const a = base + i * .38;
            fireBullet({ x: e.x, y: e.y, vx: Math.cos(a) * 200, vy: Math.sin(a) * 200,
              r: 11, dmg: e.dmg + 3, life: 3.2, color: '#ffca28', kind: 'ruler',
              friendly: false, turn: i * 1.2, rot: a });
          }
          showToast('📐 夺命三角尺！'); break;
        }
        default: { // 飞天黑板擦
          for (let i = 0; i < 4; i++) {
            const a = i / 4 * TAU;
            fireBullet({ x: e.x, y: e.y, vx: Math.cos(a) * 110, vy: Math.sin(a) * 110,
              r: 12, dmg: e.dmg, life: 5, color: '#607d8b', kind: 'eraser',
              friendly: false, home: 1.1, hp: 2 });
          }
          showToast('🧽 飞天黑板擦！'); break;
        }
      }
    } else {
      switch (e.skillIdx++ % 3) {
        case 0: // 神出鬼没
          e.vanish = 1.0; e.blinkPending = true;
          showToast('👻 神出鬼没！'); Sound.tone(300, .3, 'sine', .05, 90); break;
        case 1: // 死亡凝视
          G.hazards.push({ type: 'laser', x: (e.x + pl.x) / 2, y: (e.y + pl.y) / 2,
            r: 62, life: 2.2, max: 2.2, dmg: e.dmg + 8, track: true });
          showToast('👁 死亡凝视！'); Sound.tone(120, .5, 'sawtooth', .05, 400); break;
        default: // 作业礼包
          e.bagLeft = 5; e.bagT = 0;
          showToast('🎒 作业礼包！'); break;
      }
    }
  }

  // ---------- 主更新 ----------
  function update(dt) {
    const pl = G.player;
    G.t += dt; G.time += dt;

    // 移动
    let mx = 0, my = 0;
    if (G.keys['w'] || G.keys['arrowup']) my -= 1;
    if (G.keys['s'] || G.keys['arrowdown']) my += 1;
    if (G.keys['a'] || G.keys['arrowleft']) mx -= 1;
    if (G.keys['d'] || G.keys['arrowright']) mx += 1;
    if (G.joy.active) { mx += G.joy.dx; my += G.joy.dy; }
    const ml = Math.hypot(mx, my);
    pl.moving = ml > .05;
    if (pl.moving) {
      mx /= ml; my /= ml;
      pl.dir = dirFrom(mx, my, true);
      pl.walk += dt * 10;
      pl.x += mx * pl.speed * dt; pl.y += my * pl.speed * dt;
    }
    if (pl.invuln > 0) pl.invuln -= dt;
    if (pl.hurtT > 0) pl.hurtT -= dt;
    if (pl.atkT > 0) pl.atkT -= dt;
    if (pl.charmT > 0) pl.charmT -= dt;
    if (pl.regen > 0 && pl.hp < pl.maxhp) pl.hp = Math.min(pl.maxhp, pl.hp + pl.regen * dt);

    G.cam.x = damp(G.cam.x, pl.x, 6, dt);
    G.cam.y = damp(G.cam.y, pl.y, 6, dt);
    if (G.shake > 0) G.shake = Math.max(0, G.shake - dt * 30);

    // 生成敌人
    G.spawnT -= dt;
    if (G.spawnT <= 0) {
      G.spawnT = Math.max(.16, 1.05 - G.time / 260);
      const roll = Math.random();
      let type = 'tiaodanxuesheng';
      if (G.time > 30 && roll > .62) type = 'lurenjia';
      if (G.time > 65 && roll > .78) type = 'laoshi';
      if (G.time > 100 && roll > .86) type = 'tiyusheng';
      if (G.time > 150 && roll > .92) type = 'fantangdama';
      if (G.time > 200 && roll > .96) type = 'baoan';
      spawnEnemy(type);
      if (G.time > 45 && Math.random() < .4) {
        const n = randInt(3, 6);
        // 整群小屁孩聚在同一处出现：只在主角周围随机选一个方向定一个点，
        // 不再沿圆周环形分布把主角围住。点内加极小抖动，避免完全重叠成一个。
        const a = rand(0, TAU);
        const cx = G.player.x + Math.cos(a) * 210;
        const cy = G.player.y + Math.sin(a) * 210;
        for (let i = 0; i < n; i++) {
          const ja = rand(0, TAU), jr = rand(0, 18);
          spawnEnemy('xiaopihai', { x: cx + Math.cos(ja) * jr, y: cy + Math.sin(ja) * jr });
        }
      }
    }
    if (G.time >= G.nextBoss1 && !G.enemies.some(e => e.type === 'banzhuren' && !e.dead)) {
      spawnEnemy('banzhuren', { x: G.player.x + 260, y: G.player.y - 60 });
      showToast('⚠ 班主任来了！'); G.shake = 12; Sound.boom(); G.nextBoss1 = 1e9;
    }
    if (G.time >= G.nextBoss2 && !G.enemies.some(e => e.type === 'jiaodaozhuren' && !e.dead)) {
      spawnEnemy('jiaodaozhuren', { x: G.player.x - 280, y: G.player.y + 40 });
      showToast('⚠ 教导主任来了！'); G.shake = 14; Sound.boom(); G.nextBoss2 = 1e9;
    }

    // 班花魅惑
    if (HEROES[G.heroId].charm) {
      G.charmT = (G.charmT || 0) - dt;
      if (G.charmT <= 0) {
        G.charmT = 3;
        const target = G.enemies.filter(e => !e.dead && !e.boss && !e.charm)
          .sort((a, b) => dist2(a.x, a.y, pl.x, pl.y) - dist2(b.x, b.y, pl.x, pl.y))[0];
        if (target) {
          target.charm = 8; burst(target.x, target.y, '#f06292', 10, 90);
          dmgText(target.x, target.y - 30, '被迷住了!', '#f06292', 13);
        }
      }
    }

    // 敌人 AI
    for (const e of G.enemies) {
      if (e.dead) continue;
      e.flash = Math.max(0, e.flash - dt);
      e.hitCd = Math.max(0, e.hitCd - dt);
      if (e.atkT > 0) e.atkT -= dt;
      if (e.charm > 0) e.charm -= dt;
      if (e.buffT > 0) e.buffT -= dt;
      if (e.hurtT > 0) {
        e.hurtT -= dt; e.moving = false;
        continue; // 受击 4 帧递进演出期间不行动
      }
      if (e.boss && !e.enraged && e.hp / e.maxhp < .3) {
        e.enraged = true; e.speed *= 1.3; e.skillT *= .5;
        showToast('🔥 ' + ENEMIES[e.type].name + ' 狂暴了！'); G.shake = 10; Sound.boom();
        if (G.bossAlive === e) $('boss-wrap').classList.add('enraged');
      }
      const dx = pl.x - e.x, dy = pl.y - e.y, d = Math.hypot(dx, dy) || 1;
      e.dir = dirFrom(dx / d, dy / d, false);
      e.moving = false;
      e.phase += dt * 4;

      if (e.charm > 0) { // 被魅惑：远离其他敌人的同时靠近玩家身边晃悠
        if (d > 70) { e.x += dx / d * e.speed * .6 * dt; e.y += dy / d * e.speed * .6 * dt; e.moving = true; }
        continue;
      }

      if (e.behavior === 'charger') {
        if (e.chargeT > 0) {
          e.chargeT -= dt;
          e.x += e.chargeVX * dt; e.y += e.chargeVY * dt; e.moving = true;
          if (d < e.r + pl.r && pl.invuln <= 0) playerDamage(e.dmg, e.x, e.y);
        } else {
          e.atkCd -= dt;
          if (d < ENEMIES[e.type].atkRange && e.atkCd <= 0) {
            e.chargeT = .6; e.atkCd = ENEMIES[e.type].atkCd;
            e.chargeVX = dx / d * 430; e.chargeVY = dy / d * 430; // 方向锁定
            Sound.tone(140, .2, 'sawtooth', .04, 60);
          } else if (d > e.r + pl.r + 24) {
            e.x += dx / d * e.speed * dt; e.y += dy / d * e.speed * dt; e.moving = true;
          }
        }
      } else if (e.boss) {
        const range = e.type === 'banzhuren' ? 210 : 120;
        if (d > range) { e.x += dx / d * e.speed * dt; e.y += dy / d * e.speed * dt; e.moving = true; }
        if (e.vanish > 0) {
          e.vanish -= dt;
          if (e.vanish <= 0 && e.blinkPending) {
            e.blinkPending = false;
            const a = rand(0, TAU);
            e.x = pl.x + Math.cos(a) * 62; e.y = pl.y + Math.sin(a) * 62;
            for (let i = 0; i < 8; i++) {
              const aa = i / 8 * TAU;
              fireBullet({ x: e.x, y: e.y, vx: Math.cos(aa) * 260, vy: Math.sin(aa) * 260,
                r: 8, dmg: e.dmg, life: 1.4, color: '#e53935', kind: 'enemy', friendly: false });
            }
            if (d < 110) playerDamage(e.dmg, e.x, e.y);
            burst(e.x, e.y, '#e53935', 18, 180);
          }
        }
        if (e.bagLeft > 0) {
          e.bagT -= dt;
          if (e.bagT <= 0) {
            e.bagT = .5; e.bagLeft--;
            G.hazards.push({ type: 'bag', x: pl.x + rand(-60, 60), y: pl.y + rand(-60, 60),
              r: 66, life: .8, max: .8, dmg: e.dmg });
          }
        }
        e.skillT -= dt;
        if (e.skillT <= 0) {
          e.skillT = ENEMIES[e.type].skillCd * (e.enraged ? .7 : 1);
          bossSkill(e);
          e.atkT = .3;
        }
        if (d < e.r + pl.r && pl.invuln <= 0) playerDamage(e.dmg, e.x, e.y);
      } else {
        const t = ENEMIES[e.type];
        if (e.behavior === 'ranged') {
          if (d < 150) { e.x -= dx / d * e.speed * dt; e.y -= dy / d * e.speed * dt; e.moving = true; }
          else if (d > 250) { e.x += dx / d * e.speed * dt; e.y += dy / d * e.speed * dt; e.moving = true; }
          e.atkCd -= dt;
          if (e.atkCd <= 0 && d < 300) {
            e.atkCd = t.atkCd; e.atkT = .35;
            fireBullet({ x: e.x, y: e.y, vx: dx / d * ENEMY_CHALK_SPEED, vy: dy / d * ENEMY_CHALK_SPEED,
              r: 5, dmg: e.dmg, life: 2.6, color: '#fff', kind: 'enemy', friendly: false });
          }
        } else if (e.behavior === 'healer') {
          if (d > 130) { e.x += dx / d * e.speed * dt; e.y += dy / d * e.speed * dt; e.moving = true; }
          e.atkCd -= dt;
          if (e.atkCd <= 0) {
            e.atkCd = t.atkCd; e.atkT = .4;
            let n = 0;
            G.enemies.forEach(o => {
              if (o === e || o.dead || o.boss) return;
              if (dist2(o.x, o.y, e.x, e.y) < 150 * 150) {
                o.hp = Math.min(o.maxhp, o.hp + 10); o.buffT = 10; n++;
              }
            });
            if (n) { G.hazards.push({ type: 'heal', x: e.x, y: e.y, r: 150, life: .6, max: .6 }); dmgText(e.x, e.y - 34, '加油!', '#66bb6a', 12); }
          }
        } else {
          const range = t.atkRange || e.r + pl.r;
          e.atkCd -= dt;
          if (d > range) { e.x += dx / d * e.speed * (e.buffT > 0 ? 1.2 : 1) * dt; e.y += dy / d * e.speed * (e.buffT > 0 ? 1.2 : 1) * dt; e.moving = true; }
          else if (e.behavior === 'melee' && e.atkCd <= 0) {
            e.atkCd = t.atkCd; e.atkT = .32;
            if (d < range + 8 && pl.invuln <= 0) playerDamage(e.dmg, e.x, e.y);
          }
          if (e.behavior === 'rusher' && d < e.r + pl.r && pl.invuln <= 0) playerDamage(e.dmg, e.x, e.y);
        }
      }
    }
    G.enemies = G.enemies.filter(e => !e.dead);

    updateWeapons(dt);

    // 子弹
    for (const b of G.bullets) {
      if (b.home && b.friendly) {
        const ts = nearestEnemies(1);
        if (ts.length) {
          const a = Math.atan2(ts[0].y - b.y, ts[0].x - b.x);
          const ca = Math.atan2(b.vy, b.vx);
          let diff = ((a - ca + Math.PI * 3) % TAU) - Math.PI;
          const na = ca + clamp(diff, -b.home * dt, b.home * dt);
          const sp = Math.hypot(b.vx, b.vy);
          b.vx = Math.cos(na) * sp; b.vy = Math.sin(na) * sp; b.rot = na;
        }
      }
      if (b.home && !b.friendly) {
        const a = Math.atan2(pl.y - b.y, pl.x - b.x), ca = Math.atan2(b.vy, b.vx);
        let diff = ((a - ca + Math.PI * 3) % TAU) - Math.PI;
        const na = ca + clamp(diff, -b.home * dt, b.home * dt), sp = Math.hypot(b.vx, b.vy);
        b.vx = Math.cos(na) * sp; b.vy = Math.sin(na) * sp;
      }
      if (b.turn) { const a = Math.atan2(b.vy, b.vx) + b.turn * dt, sp = Math.hypot(b.vx, b.vy); b.vx = Math.cos(a) * sp; b.vy = Math.sin(a) * sp; b.rot = a; }
      b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
      if (b.life <= 0) continue;
      if (b.friendly) {
        for (const e of G.enemies) {
          if (e.dead || e.charm > 0 || b.hit.indexOf(e) >= 0) continue;
          if (dist2(b.x, b.y, e.x, e.y) < (b.r + e.r) * (b.r + e.r)) {
            damageEnemy(e, b.dmg, b.dmg > 20 && Math.random() < pl.crit);
            burst(b.x, b.y, b.color, 4, 90);
            b.hit.push(e);
            if (b.hit.length > (b.pierce || 0)) { b.life = 0; break; }
          }
        }
        // 打掉黑板擦
        if (b.life > 0 && (b.kind === 'chalk' || b.kind === 'compass')) {
          for (const o of G.bullets) {
            if (!o.friendly && o.kind === 'eraser' && o.hp > 0 && dist2(b.x, b.y, o.x, o.y) < (b.r + o.r) * (b.r + o.r)) {
              o.hp--; b.life = 0; burst(o.x, o.y, '#607d8b', 6, 100);
              if (o.hp <= 0) { o.life = 0; dmgText(o.x, o.y, '黑板擦坏啦!', '#90a4ae', 12); }
              break;
            }
          }
        }
      } else if (pl.invuln <= 0 && dist2(b.x, b.y, pl.x, pl.y) < (b.r + pl.r) * (b.r + pl.r)) {
        playerDamage(b.dmg, b.x, b.y); b.life = 0;
      }
    }
    G.bullets = G.bullets.filter(b => b.life > 0);

    // 危险区域
    for (const h of G.hazards) {
      h.life -= dt;
      if (h.type === 'laser' && h.track && h.life > .4) {
        h.x = damp(h.x, pl.x, .9, dt); h.y = damp(h.y, pl.y, .9, dt);
      } else if (h.type === 'laser' && h.life <= .4 && !h.fired) {
        h.fired = true;
        if (dist2(pl.x, pl.y, h.x, h.y) < h.r * h.r) playerDamage(h.dmg, h.x, h.y);
        burst(h.x, h.y, '#ff5252', 22, 220); G.shake = 8;
      }
      if (h.type === 'ball' && !h.fired && h.life < h.max * .5) {
        h.fired = true;
        G.enemies.forEach(e => { if (!e.dead && dist2(e.x, e.y, h.x, h.y) < (h.r + e.r) * (h.r + e.r)) damageEnemy(e, h.dmg * critRoll()); });
        burst(h.x, h.y, '#ff9800', 12, 140);
      }
      if (h.type === 'bag' && !h.fired && h.life < h.max * .4) {
        h.fired = true;
        if (dist2(pl.x, pl.y, h.x, h.y) < h.r * h.r) playerDamage(h.dmg, h.x, h.y);
        burst(h.x, h.y, '#8d6e63', 14, 150);
      }
    }
    G.hazards = G.hazards.filter(h => h.life > 0);

    // 经验珠
    for (const g of G.gems) {
      g.t += dt * 3;
      const d = Math.hypot(pl.x - g.x, pl.y - g.y);
      if (d < pl.pickup) {
        const a = Math.atan2(pl.y - g.y, pl.x - g.x), pull = 460 * (1 - d / pl.pickup) + 130;
        g.x += Math.cos(a) * pull * dt; g.y += Math.sin(a) * pull * dt;
      } else { g.x += g.vx * dt; g.y += g.vy * dt; g.vx *= .94; g.vy *= .94; }
      if (d < pl.r + 5) { g.got = true; gainExp(g.exp); Sound.pickup(); burst(g.x, g.y, '#64b5f6', 3, 60); }
    }
    G.gems = G.gems.filter(g => !g.got);

    // 特效
    for (const p of G.particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= .93; p.vy *= .93; p.life -= dt; }
    G.particles = G.particles.filter(p => p.life > 0);
    for (const d of G.texts) { d.y -= 34 * dt; d.life -= dt; }
    G.texts = G.texts.filter(d => d.life > 0);

    // BOSS 血条
    const boss = G.enemies.find(e => e.boss && !e.dead);
    if (boss) {
      G.bossAlive = boss;
      show(['boss-wrap']);
      $('boss-name').textContent = ENEMIES[boss.type].name + (boss.enraged ? ' · 狂暴' : '');
      $('boss-bar').style.transform = 'scaleX(' + clamp(boss.hp / boss.maxhp, 0, 1) + ')';
    }
    if (Math.floor(G.time * 2) !== Math.floor((G.time - dt) * 2)) updateHUD();
  }

  // ---------- 渲染 ----------
  function render() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = '#dfe8dc'; ctx.fillRect(0, 0, W, H);
    if (!G.player) return;
    const sx = G.shake ? rand(-G.shake, G.shake) : 0, sy = G.shake ? rand(-G.shake, G.shake) : 0;
    ctx.save();
    ctx.translate(W / 2 - G.cam.x + sx, H / 2 - G.cam.y + sy);

    drawGround();

    for (const g of G.gems) {
      const pulse = 1 + Math.sin(g.t) * .16;
      ctx.fillStyle = '#42a5f5'; ctx.shadowColor = '#42a5f5'; ctx.shadowBlur = 9;
      ctx.beginPath(); ctx.arc(g.x, g.y, g.r * pulse, 0, TAU); ctx.fill();
      ctx.shadowBlur = 0; ctx.fillStyle = '#e3f2fd';
      ctx.fillRect(g.x - 1.3, g.y - 3.4, 2.6, 6.8);
    }

    for (const h of G.hazards) drawHazard(h);

    // 敌人：按 y 排序，营造前后遮挡
    const sorted = G.enemies.slice().sort((a, b) => a.y - b.y);
    for (const e of sorted) {
      if (e.boss && e.vanish > 0 && Math.floor(e.vanish * 12) % 2 === 0) continue;
      shadow(e.x, e.y, e.r * .95);
      const scale = (e.boss ? 1.35 : 1.0) * VIS;
      const state = e.hurtT > 0 ? 'hurt' + clamp(Math.floor((.6 - e.hurtT) / .15) + 1, 1, 4)
        : e.atkT > 0 ? 'attack' : e.moving ? 'run' : 'idle';
      const alpha = e.charm > 0 ? (.72 + Math.sin(G.t * 8) * .18) : 1;
      drawSprite(e.atlas, state, e.dir, e.x, e.y, scale, alpha);
      if (e.charm > 0) {
        ctx.fillStyle = '#f06292'; ctx.font = 'bold ' + Math.round(13 * VIS) + 'px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('♥', e.x + 16 * VIS, e.y - 62 * VIS + Math.sin(G.t * 6) * 4 * VIS);
      }
      if (e.flash > 0) {
        ctx.globalAlpha = e.flash / .12 * .35; ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.ellipse(e.x, e.y - 34 * VIS, e.r, e.r * 1.1, 0, 0, TAU); ctx.fill(); ctx.globalAlpha = 1;
      }
      if (e.buffT > 0) {
        ctx.strokeStyle = 'rgba(102,187,106,.45)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(e.x, e.y - 20 * VIS, e.r + 8 * VIS + Math.sin(G.t * 4) * 3 * VIS, 0, TAU); ctx.stroke();
      }
    }

    // 玩家
    const pl = G.player;
    shadow(pl.x, pl.y, pl.r);
    const pstate = pl.hurtT > 0 ? 'hurt' + clamp(Math.floor((.6 - pl.hurtT) / .15) + 1, 1, 4)
      : pl.atkT > 0 ? 'attack' : pl.moving ? 'run' : 'idle';
    const alpha = pl.invuln > 0 && Math.floor(pl.invuln * 20) % 2 ? .55 : 1;
    drawSprite(HEROES[G.heroId].atlas, pstate, pl.dir, pl.x, pl.y, 1.05 * VIS, alpha);
    if (G.weapons.notebook) {
      const lv = G.weapons.notebook, count = 2 + Math.floor(lv / 2), radius = 58 + lv * 4;
      for (let i = 0; i < count; i++) {
        const a = G.orbitAngle * 1.5 + i / count * TAU;
        ctx.save(); ctx.translate(pl.x + Math.cos(a) * radius, pl.y - 24 * VIS + Math.sin(a) * radius * .5);
        ctx.rotate(a * 2);
        ctx.fillStyle = '#ef5350'; ctx.fillRect(-9, -11, 18, 22);
        ctx.fillStyle = '#fff'; ctx.fillRect(-7, -9, 14, 3); ctx.fillRect(-7, -3, 14, 2); ctx.fillRect(-7, 2, 14, 2);
        ctx.restore();
      }
    }

    // 子弹
    for (const b of G.bullets) {
      ctx.save(); ctx.translate(b.x, b.y);
      if (b.kind === 'chalk') {
        ctx.rotate(b.rot || 0);
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#90a4ae'; ctx.lineWidth = 1.5;
        ctx.fillRect(-9, -3, 18, 6); ctx.strokeRect(-9, -3, 18, 6);
      } else if (b.kind === 'compass') {
        ctx.rotate((b.rot || 0) + G.t * 8);
        ctx.fillStyle = '#7e57c2'; ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(8, 8); ctx.lineTo(-8, 8); ctx.closePath(); ctx.fill();
      } else if (b.kind === 'ruler') {
        ctx.rotate(b.rot || 0);
        ctx.fillStyle = '#ffca28'; ctx.fillRect(-12, -6, 24, 12);
        ctx.strokeStyle = '#6d4c41'; ctx.lineWidth = 1;
        for (let i = -8; i < 10; i += 5) { ctx.beginPath(); ctx.moveTo(i, -6); ctx.lineTo(i, -1); ctx.stroke(); }
      } else if (b.kind === 'eraser') {
        ctx.fillStyle = '#546e7a'; ctx.fillRect(-12, -8, 24, 16);
        ctx.fillStyle = '#cfd8dc'; ctx.fillRect(-12, -8, 24, 5);
      } else if (b.kind === 'enemy') {
        // 老师的粉笔：白色本体 + 醒目红色描边 + 红色微光，方便看清躲避
        ctx.shadowColor = '#e53935'; ctx.shadowBlur = 9;
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#d32f2f'; ctx.lineWidth = 2.6;
        ctx.beginPath(); ctx.arc(0, 0, b.r, 0, TAU); ctx.fill(); ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(211,47,47,.55)'; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(0, 0, b.r + 3.5, 0, TAU); ctx.stroke();
      } else {
        ctx.fillStyle = b.color; ctx.shadowColor = b.color; ctx.shadowBlur = 7;
        ctx.beginPath(); ctx.arc(0, 0, b.r, 0, TAU); ctx.fill(); ctx.shadowBlur = 0;
      }
      ctx.restore();
    }

    for (const p of G.particles) {
      ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
      ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;

    for (const d of G.texts) {
      ctx.globalAlpha = clamp(d.life / .8, 0, 1);
      ctx.fillStyle = d.color; ctx.font = 'bold ' + d.size + 'px sans-serif'; ctx.textAlign = 'center';
      ctx.strokeStyle = 'rgba(20,40,50,.75)'; ctx.lineWidth = 3;
      ctx.strokeText(d.val, d.x, d.y); ctx.fillText(d.val, d.x, d.y);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawGround() {
    const cx = G.cam.x, cy = G.cam.y, cell = 96;
    const x0 = Math.floor((cx - W / 2) / cell) - 1, x1 = Math.ceil((cx + W / 2) / cell) + 1;
    const y0 = Math.floor((cy - H / 2) / cell) - 1, y1 = Math.ceil((cy + H / 2) / cell) + 1;
    ctx.fillStyle = '#e3ecdf';
    ctx.fillRect(cx - W / 2 - cell, cy - H / 2 - cell, W + cell * 2, H + cell * 2);
    ctx.strokeStyle = 'rgba(90,125,95,.11)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = x0; x <= x1; x++) { ctx.moveTo(x * cell, y0 * cell); ctx.lineTo(x * cell, y1 * cell); }
    for (let y = y0; y <= y1; y++) { ctx.moveTo(x0 * cell, y * cell); ctx.lineTo(x1 * cell, y * cell); }
    ctx.stroke();
    // 操场跑道线
    ctx.strokeStyle = 'rgba(215,110,90,.22)'; ctx.lineWidth = 3;
    ctx.beginPath();
    for (let y = y0; y <= y1; y++) if (((y % 5) + 5) % 5 === 0) { ctx.moveTo(x0 * cell, y * cell + 18); ctx.lineTo(x1 * cell, y * cell + 18); }
    ctx.stroke();
    // 草地点缀（确定性）
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const h = ((x * 73856093) ^ (y * 19349663)) >>> 0;
      if (h % 7 === 0) {
        const gx = x * cell + (h % 60) + 16, gy = y * cell + ((h >> 8) % 60) + 16;
        ctx.fillStyle = 'rgba(110,160,110,.3)';
        ctx.beginPath(); ctx.ellipse(gx, gy, 5, 2.5, .5, 0, TAU); ctx.fill();
      }
    }
  }

  function drawHazard(h) {
    const k = clamp(h.life / h.max, 0, 1);
    if (h.type === 'slash') {
      ctx.save(); ctx.translate(h.x, h.y); ctx.rotate(h.a);
      ctx.strokeStyle = 'rgba(255,214,120,' + k + ')'; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.arc(0, 0, h.r, -.95, .95); ctx.stroke(); ctx.restore();
    } else if (h.type === 'ball') {
      ctx.strokeStyle = 'rgba(245,124,40,' + (k * .7) + ')'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, TAU); ctx.stroke();
      ctx.fillStyle = '#e65100'; ctx.beginPath(); ctx.arc(h.x, h.y - (1 - k) * 22, 13, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#5d4037'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(h.x - 13, h.y - (1 - k) * 22); ctx.lineTo(h.x + 13, h.y - (1 - k) * 22); ctx.stroke();
    } else if (h.type === 'bag') {
      const fall = 1 - k;
      ctx.fillStyle = '#5d4037'; ctx.fillRect(h.x - 13, h.y - 30 - fall * 100, 26, 30);
      ctx.fillStyle = '#8d6e63'; ctx.fillRect(h.x - 10, h.y - 27 - fall * 100, 20, 6);
      ctx.strokeStyle = 'rgba(93,64,55,' + (k * .6) + ')'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(h.x, h.y, h.r * (1 - fall * .5), 0, TAU); ctx.stroke();
    } else if (h.type === 'laser') {
      const firing = h.life <= .4;
      ctx.strokeStyle = firing ? 'rgba(255,60,60,.95)' : 'rgba(255,60,60,' + (.3 + .35 * Math.sin(G.t * 16) ** 2) + ')';
      ctx.lineWidth = firing ? 26 : 3;
      ctx.beginPath(); ctx.moveTo(h.x, h.y - 600); ctx.lineTo(h.x, h.y); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,180,180,.7)'; ctx.lineWidth = firing ? 8 : 1;
      ctx.beginPath(); ctx.moveTo(h.x, h.y - 600); ctx.lineTo(h.x, h.y); ctx.stroke();
      ctx.strokeStyle = 'rgba(229,57,53,' + (firing ? .9 : .45) + ')'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, TAU); ctx.stroke();
    } else if (h.type === 'heal') {
      ctx.strokeStyle = 'rgba(102,187,106,' + (k * .7) + ')'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(h.x, h.y, h.r * (1 - k * .2), 0, TAU); ctx.stroke();
    }
  }

  // ---------- HUD / 结算 ----------
  function updateHUD() {
    if (!G.player) return;
    $('timer').textContent = fmtTime(G.time);
    $('kills').textContent = G.kills;
    $('level').textContent = G.level;
    $('level-badge').textContent = 'LV.' + G.level;
    $('hp-bar').style.transform = 'scaleX(' + clamp(G.player.hp / G.player.maxhp, 0, 1) + ')';
    $('hp-label').textContent = Math.max(0, Math.ceil(G.player.hp)) + ' / ' + G.player.maxhp;
    $('exp-bar').style.transform = 'scaleX(' + clamp(G.acc / G.expNext, 0, 1) + ')';
  }
  let toastTimer = null;
  function showToast(text) {
    const el = $('toast').querySelector('span'); el.textContent = text;
    el.classList.add('show'); clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1500);
  }
  function broadcast(win) {
    if (win) return '📢 今日校园播报：全校师生已恢复正常！教导主任正在教务处补写检讨，校长表示「下次注意」。';
    if (G.kills >= 80) return '📢 今日校园播报：该校纪律因子大幅消退，多名同学表示「好像做了一个很长的噩梦」。';
    if (G.kills >= 30) return '📢 今日校园播报：校园秩序正在恢复，请同学们不要模仿用圆规对抗老师。';
    return '📢 今日校园播报：纪律因子仍在扩散，建议加强体育锻炼，下节课记得带文具。';
  }
  function gameOver(win) {
    G.state = 'gameover'; Sound.boom();
    const best = loadBest();
    const isRecord = G.time > best.time || (G.time === best.time && G.kills > best.kills);
    if (isRecord) saveBest({ time: Math.max(best.time, G.time), kills: Math.max(best.kills, G.kills) });
    $('result-title').textContent = win ? '放学啦！' : '今天先到这里';
    $('result-title').style.color = win ? '#2e7d32' : '#e64a3b';
    $('final-time').textContent = fmtTime(G.time);
    $('final-kills').textContent = G.kills;
    $('final-level').textContent = G.level;
    $('broadcast').textContent = broadcast(win);
    $('newrecord').classList.toggle('hidden', !isRecord);
    hide(HUD_IDS.concat(['boss-wrap']));
    show(['gameover']); refreshBest();
  }
  function refreshBest() { const b = loadBest(); $('best-time').textContent = fmtTime(b.time); $('best-kills').textContent = b.kills; }
  function pause() { if (G.state !== 'playing') return; G.state = 'paused'; show(['paused']); }
  function resume() { if (G.state !== 'paused') return; G.state = 'playing'; hide(['paused']); last = performance.now(); }

  // ---------- 按钮 ----------
  $('start-btn').onclick = openHeroSelect;
  $('how-btn').onclick = () => { Sound.click(); hide(['menu']); show(['how']); };
  $('how-back').onclick = () => { Sound.click(); hide(['how']); show(['menu']); };
  $('hero-back').onclick = () => { Sound.click(); hide(['hero-select']); show(['menu']); };
  $('retry-btn').onclick = () => { Sound.click(); startGame(); };
  $('home-btn').onclick = () => { Sound.click(); goMenu(); };
  $('quit-btn').onclick = () => { Sound.click(); goMenu(); };
  $('resume-btn').onclick = () => { Sound.click(); resume(); };
  $('pause-btn').onclick = () => { Sound.click(); pause(); };
  $('mute-btn').onclick = () => { Sound.muted = !Sound.muted; $('mute-btn').textContent = Sound.muted ? '🔇' : '🔊'; };

  // 角色选择卡
  const cardBox = $('hero-cards');
  for (const id in HEROES) {
    const h = HEROES[id];
    const div = document.createElement('div'); div.className = 'hero-card';
    div.innerHTML = '<canvas width="96" height="108" style="width:72px;height:81px"></canvas>' +
      '<div class="hn">' + h.name + '</div><div class="hs">《' + h.skill + '》</div><div class="hd">' + h.desc + '</div>';
    div.onclick = () => pickHero(id);
    cardBox.appendChild(div);
    // 预览动画
    (function (canvasEl, cid) {
      const c = canvasEl.getContext('2d');
      function draw() {
        if (G.state === 'hero-select') {
          c.clearRect(0, 0, 96, 108);
          const aid = HEROES[cid].atlas;
          const info = ATL.chars[aid], img = IMG[aid];
          if (info && img && img.complete && img.naturalWidth) {
            const idx = info.frames.idle_down;
            c.drawImage(img, (idx % ATL.cols) * ATL.cellW, Math.floor(idx / ATL.cols) * ATL.cellH,
              ATL.cellW, ATL.cellH, 0, 0, 96, 108);
          }
        }
        requestAnimationFrame(draw);
      }
      requestAnimationFrame(draw);
    })(div.querySelector('canvas'), id);
  }

  // ---------- 游戏循环 ----------
  let last = performance.now();
  function loop(now) {
    let dt = (now - last) / 1000; last = now;
    if (dt > .05) dt = .05;
    if (G.state === 'playing') update(dt);
    render();
    requestAnimationFrame(loop);
  }
  refreshBest();
  window.__CAMPUS_DEBUG = { IMG, ATL, G, spawnEnemy, damageEnemy, gainExp };
  requestAnimationFrame(loop);
})();
