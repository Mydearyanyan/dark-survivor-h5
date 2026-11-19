/* 暗夜幸存者 - Survivors-like H5 小游戏
 * 纯原生 JS + Canvas，无任何外部依赖与素材
 */
(function () {
  'use strict';

  // ---------- 基础工具 ----------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const $ = (id) => document.getElementById(id);
  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const dist2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
  const TAU = Math.PI * 2;

  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * DPR; canvas.height = H * DPR;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  // ---------- 音效（Web Audio 合成，无外部文件） ----------
  const Sound = {
    ac: null, muted: false,
    init() { if (!this.ac) { try { this.ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} } },
    tone(freq, dur, type, vol, slide) {
      if (this.muted || !this.ac) return;
      const t = this.ac.currentTime, o = this.ac.createOscillator(), g = this.ac.createGain();
      o.type = type || 'square'; o.frequency.setValueAtTime(freq, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, slide), t + dur);
      g.gain.setValueAtTime(vol || 0.05, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(this.ac.destination); o.start(t); o.stop(t + dur + 0.02);
    },
    shoot() { this.tone(680, 0.08, 'square', 0.025, 340); },
    hit() { this.tone(180, 0.06, 'sawtooth', 0.03, 90); },
    hurt() { this.tone(220, 0.22, 'sawtooth', 0.08, 60); },
    pickup() { this.tone(880, 0.07, 'sine', 0.03, 1320); },
    level() { this.tone(520, 0.16, 'sine', 0.07, 1040); setTimeout(() => this.tone(780, 0.2, 'sine', 0.06, 1300), 110); },
    boom() { this.tone(90, 0.35, 'sawtooth', 0.09, 30); },
    click() { this.tone(440, 0.05, 'square', 0.03, 660); }
  };

  // ---------- 武器 / 被动定义 ----------
  const WEAPONS = {
    knife:     { name: '飞刀',   icon: '🗡️', color: '#d8dce8', max: 8, desc: '向最近的敌人投出飞刀' },
    aura:      { name: '圣光环', icon: '✨', color: '#ffd76a', max: 8, desc: '身边环绕持续伤害的光环' },
    lightning: { name: '雷击',   icon: '⚡', color: '#8ab4ff', max: 8, desc: '定期劈下闪电打击敌人' },
    bible:     { name: '圣书',   icon: '📖', color: '#c9a6ff', max: 8, desc: '环绕你旋转的魔法书' },
    fire:      { name: '烈焰',   icon: '🔥', color: '#ff8a5c', max: 8, desc: '周期性喷发范围火焰' }
  };
  const PASSIVES = {
    power:    { name: '攻击强化', icon: '💪', color: '#ff7a7a', max: 5, desc: '所有伤害 +20%' },
    speed:    { name: '疾行',     icon: '👟', color: '#7be0ff', max: 5, desc: '移动速度 +12%' },
    maxhp:    { name: '强健体魄', icon: '❤️', color: '#ff6a8a', max: 5, desc: '最大生命 +25 并回满' },
    pickup:   { name: '磁力',     icon: '🧲', color: '#a78bfa', max: 5, desc: '经验拾取范围 +40%' },
    cooldown: { name: '急速',     icon: '⏩', color: '#6affc0', max: 5, desc: '武器冷却 -12%' },
    armor:    { name: '护甲',     icon: '🛡️', color: '#b0b8c8', max: 5, desc: '受到伤害 -12%' },
    luck:     { name: '幸运',     icon: '🍀', color: '#9fe870', max: 5, desc: '经验获取 +18%' }
  };

  // ---------- 敌人类型 ----------
  const ENEMIES = {
    bat:    { hp: 9,  speed: 66, dmg: 6,  r: 10, color: '#b06bff', exp: 1, shape: 'bat' },
    slime:  { hp: 20, speed: 40, dmg: 9,  r: 14, color: '#5fd98a', exp: 2, shape: 'slime' },
    ghost:  { hp: 14, speed: 54, dmg: 8,  r: 12, color: '#9fd8ff', exp: 2, shape: 'ghost' },
    brute:  { hp: 55, speed: 30, dmg: 16, r: 20, color: '#e8734a', exp: 5, shape: 'brute' },
    boss:   { hp: 700,speed: 34, dmg: 26, r: 38, color: '#ff4d5e', exp: 60, shape: 'boss' }
  };

  // ---------- 游戏状态 ----------
  const G = {
    state: 'menu', time: 0, kills: 0, level: 1,
    player: null, enemies: [], gems: [], projectiles: [], particles: [], dmgTexts: [], hazards: [],
    cam: { x: 0, y: 0 }, shake: 0, spawnTimer: 0, bossTimer: 0, nextBoss: 60,
    keys: {}, joy: { active: false, dx: 0, dy: 0, cx: 0, cy: 0, id: null },
    weapons: {}, passives: {}, expNext: 8, acc: 0
  };

  function freshPlayer() {
    return {
      x: 0, y: 0, r: 13, hp: 100, maxhp: 100, speed: 132,
      power: 1, armor: 1, pickup: 1, luck: 1, cd: 1,
      invuln: 0, angle: 0, walk: 0
    };
  }

  // ---------- 存档 ----------
  const SAVE_KEY = 'dark_survivor_best_v1';
  function loadBest() { try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || { time: 0, kills: 0 }; } catch (e) { return { time: 0, kills: 0 }; } }
  function saveBest(b) { try { localStorage.setItem(SAVE_KEY, JSON.stringify(b)); } catch (e) {} }
  function fmtTime(s) { const m = Math.floor(s / 60), ss = Math.floor(s % 60); return String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0'); }

  // ---------- 开始 / 重置 ----------
  function startGame() {
    Sound.init();
    G.state = 'playing'; G.time = 0; G.kills = 0; G.level = 1;
    G.player = freshPlayer();
    G.enemies.length = 0; G.gems.length = 0; G.projectiles.length = 0;
    G.particles.length = 0; G.dmgTexts.length = 0; G.hazards.length = 0;
    G.weapons = { knife: 1 }; G.passives = {};
    G.expNext = 8; G.acc = 0; G.spawnTimer = 0; G.bossTimer = 0; G.nextBoss = 60;
    G.cam.x = 0; G.cam.y = 0; G.shake = 0;
    ['menu', 'gameover', 'levelup', 'paused', 'how'].forEach(id => $(id).classList.add('hidden'));
    ['hud', 'pause-btn', 'mute-btn', 'joystick'].forEach(id => $(id).classList.remove('hidden'));
    updateHUD(); renderSkills();
    last = performance.now();
  }

  // ---------- 输入 ----------
  window.addEventListener('keydown', e => {
    G.keys[e.key.toLowerCase()] = true;
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(e.key.toLowerCase())) e.preventDefault();
    if (e.key.toLowerCase() === 'p' || e.key.toLowerCase() === 'escape') { if (G.state === 'playing') pause(); else if (G.state === 'paused') resume(); }
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
  function joyEnd() {
    G.joy.active = false; G.joy.dx = 0; G.joy.dy = 0;
    joyBase.style.opacity = 0; joyKnob.style.opacity = 0;
  }
  joyZone.addEventListener('touchstart', e => { e.preventDefault(); joyStart(e); }, { passive: false });
  joyZone.addEventListener('touchmove', e => { e.preventDefault(); joyMove(e); }, { passive: false });
  joyZone.addEventListener('touchend', e => { e.preventDefault(); joyEnd(); }, { passive: false });
  joyZone.addEventListener('mousedown', joyStart);
  window.addEventListener('mousemove', e => { if (G.joy.active && G.joy.id === 'mouse') joyMove(e); });
  window.addEventListener('mouseup', () => { if (G.joy.id === 'mouse') joyEnd(); });

  // ---------- 生成实体 ----------
  function spawnEnemy(type, near) {
    const t = ENEMIES[type];
    let x, y;
    if (near) { x = near.x; y = near.y; }
    else {
      const a = rand(0, TAU), d = rand(Math.max(W, H) * 0.55, Math.max(W, H) * 0.75);
      x = G.player.x + Math.cos(a) * d; y = G.player.y + Math.sin(a) * d;
    }
    const scale = 1 + G.time / 180;
    G.enemies.push({
      type, x, y, r: t.r, hp: t.hp * scale, maxhp: t.hp * scale,
      speed: t.speed * rand(.9, 1.1), dmg: t.dmg, color: t.color, exp: t.exp,
      hitCd: 0, flash: 0, phase: rand(0, TAU), isBoss: type === 'boss'
    });
  }

  function spawnGem(x, y, exp) { G.gems.push({ x, y, exp, r: 5, t: rand(0, TAU), vx: rand(-40, 40), vy: rand(-40, 40) }); }

  function burst(x, y, color, n, spd) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU), s = rand(spd * .3, spd);
      G.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(.3, .7), max: .7, color, r: rand(1.5, 3.5) });
    }
  }
  function dmgText(x, y, val, color) { G.dmgTexts.push({ x, y, val: Math.round(val), color: color || '#fff', life: .7 }); }

  // ---------- 升级 ----------
  function gainExp(amount) {
    G.acc += amount * G.player.luck;
    while (G.acc >= G.expNext) {
      G.acc -= G.expNext; G.level++;
      G.expNext = Math.floor(G.expNext * 1.32) + 4;
      openLevelUp();
    }
    updateHUD();
  }

  function openLevelUp() {
    G.state = 'levelup'; Sound.level();
    const pool = [];
    for (const k in WEAPONS) {
      const lv = G.weapons[k] || 0;
      if (lv < WEAPONS[k].max) pool.push({ kind: 'weapon', key: k, lv, ...WEAPONS[k] });
      else if (lv > 0) { /* 已满级不再出现 */ }
    }
    for (const k in PASSIVES) {
      const lv = G.passives[k] || 0;
      if (lv < PASSIVES[k].max) pool.push({ kind: 'passive', key: k, lv, ...PASSIVES[k] });
    }
    // 随机取3个，优先保证有武器
    pool.sort(() => Math.random() - .5);
    let picks = pool.slice(0, 3);
    const cards = $('cards'); cards.innerHTML = '';
    picks.forEach(p => {
      const div = document.createElement('div'); div.className = 'card';
      const nextLv = p.lv + 1;
      div.innerHTML = '<div class="ic" style="background:' + p.color + '22">' + p.icon + '</div>' +
        '<div class="nm">' + p.name + '</div>' +
        '<div class="ds">' + p.desc + '</div>' +
        '<div class="lvtag">' + (p.lv === 0 ? '新获得' : 'Lv.' + p.lv + ' → ' + nextLv) + '</div>';
      div.onclick = () => { Sound.click(); applyPick(p); $('levelup').classList.add('hidden'); G.state = 'playing'; last = performance.now(); };
      cards.appendChild(div);
    });
    $('levelup').classList.remove('hidden');
  }

  function applyPick(p) {
    if (p.kind === 'weapon') {
      G.weapons[p.key] = (G.weapons[p.key] || 0) + 1;
      if (p.key === 'maxhp') {}
    } else {
      G.passives[p.key] = (G.passives[p.key] || 0) + 1;
      const pl = G.player, lv = G.passives[p.key];
      switch (p.key) {
        case 'power': pl.power = 1 + lv * .2; break;
        case 'speed': pl.speed = 132 * (1 + lv * .12); break;
        case 'maxhp': pl.maxhp += 25; pl.hp = pl.maxhp; break;
        case 'pickup': pl.pickup = 1 + lv * .4; break;
        case 'cooldown': pl.cd = 1 - lv * .12; break;
        case 'armor': pl.armor = 1 - lv * .12; break;
        case 'luck': pl.luck = 1 + lv * .18; break;
      }
    }
    renderSkills(); updateHUD();
  }

  function renderSkills() {
    const box = $('skills'); box.innerHTML = '';
    const all = [];
    for (const k in G.weapons) if (G.weapons[k] > 0) all.push({ lv: G.weapons[k], ...WEAPONS[k] });
    for (const k in G.passives) if (G.passives[k] > 0) all.push({ lv: G.passives[k], ...PASSIVES[k] });
    all.forEach(s => {
      const d = document.createElement('div'); d.className = 'skill-chip';
      d.innerHTML = '<div class="ic" style="background:' + s.color + '33">' + s.icon + '</div><span class="lv">Lv.' + s.lv + '</span>';
      box.appendChild(d);
    });
  }

  // ---------- 武器开火 ----------
  let fireTimer = {}, orbitAngle = 0;
  function updateWeapons(dt) {
    const pl = G.player;
    orbitAngle += dt * 1.8;

    // 飞刀
    if (G.weapons.knife) {
      const lv = G.weapons.knife;
      fireTimer.knife = (fireTimer.knife || 0) - dt;
      if (fireTimer.knife <= 0) {
        fireTimer.knife = Math.max(.22, .62 - lv * .05) * pl.cd;
        const targets = nearestEnemies(1 + Math.floor(lv / 3));
        if (targets.length) {
          const base = Math.atan2(targets[0].y - pl.y, targets[0].x - pl.x);
          const count = 1 + Math.floor((lv - 1) / 2);
          for (let i = 0; i < count; i++) {
            const a = base + (i - (count - 1) / 2) * .16;
            G.projectiles.push({ x: pl.x, y: pl.y, vx: Math.cos(a) * 460, vy: Math.sin(a) * 460,
              r: 6, dmg: 10 * pl.power, life: 1.2, color: '#d8dce8', kind: 'knife', rot: a, pierce: 0 });
          }
          Sound.shoot();
        }
      }
    }
    // 圣光环（持续范围伤害）
    if (G.weapons.aura) {
      const lv = G.weapons.aura, radius = 60 + lv * 12;
      G.enemies.forEach(e => {
        if (dist2(e.x, e.y, pl.x, pl.y) < (radius + e.r) * (radius + e.r)) {
          if (e.hitCd <= 0) { damageEnemy(e, (7 + lv * 3) * pl.power); e.hitCd = .5; }
        }
      });
    }
    // 圣书（环绕）
    if (G.weapons.bible) {
      const lv = G.weapons.bible, count = 2 + Math.floor(lv / 2), radius = 62 + lv * 3;
      for (let i = 0; i < count; i++) {
        const a = orbitAngle * 1.4 + i / count * TAU;
        const bx = pl.x + Math.cos(a) * radius, by = pl.y + Math.sin(a) * radius;
        G.enemies.forEach(e => {
          if (dist2(bx, by, e.x, e.y) < (12 + e.r) * (12 + e.r)) {
            if (e.hitCd <= 0) { damageEnemy(e, (9 + lv * 4) * pl.power); e.hitCd = .45; }
          }
        });
      }
    }
    // 雷击
    if (G.weapons.lightning) {
      const lv = G.weapons.lightning;
      fireTimer.lightning = (fireTimer.lightning || 0) - dt;
      if (fireTimer.lightning <= 0) {
        fireTimer.lightning = Math.max(.7, 2.2 - lv * .2) * pl.cd;
        const targets = nearestEnemies(1 + Math.floor(lv / 2));
        targets.forEach((e, i) => {
          setTimeout(() => {
            if (G.state !== 'playing') return;
            const R = 46 + lv * 4;
            G.enemies.forEach(o => { if (dist2(o.x, o.y, e.x, e.y) < R * R) damageEnemy(o, (16 + lv * 6) * pl.power); });
            G.hazards.push({ x: e.x, y: e.y, r: R, life: .22, max: .22, type: 'bolt' });
            Sound.tone(120, .18, 'sawtooth', .05, 800);
          }, i * 90);
        });
      }
    }
    // 烈焰
    if (G.weapons.fire) {
      const lv = G.weapons.fire;
      fireTimer.fire = (fireTimer.fire || 0) - dt;
      if (fireTimer.fire <= 0) {
        fireTimer.fire = Math.max(1.0, 2.6 - lv * .2) * pl.cd;
        const a = rand(0, TAU), fx = pl.x + Math.cos(a) * 40, fy = pl.y + Math.sin(a) * 40, R = 52 + lv * 8;
        G.hazards.push({ x: fx, y: fy, r: R, life: .6, max: .6, type: 'fire' });
        G.enemies.forEach(e => { if (dist2(e.x, e.y, fx, fy) < R * R) damageEnemy(e, (12 + lv * 5) * pl.power); });
        burst(fx, fy, '#ff8a5c', 12, 120);
      }
    }
  }

  function nearestEnemies(n) {
    const pl = G.player;
    return G.enemies.slice().sort((a, b) => dist2(a.x, a.y, pl.x, pl.y) - dist2(b.x, b.y, pl.x, pl.y)).slice(0, n);
  }

  function damageEnemy(e, dmg) {
    e.hp -= dmg; e.flash = .12;
    dmgText(e.x + rand(-6, 6), e.y - e.r, dmg, e.isBoss ? '#ffd76a' : '#fff');
    if (e.hp <= 0) {
      e.dead = true; G.kills++;
      spawnGem(e.x, e.y, e.exp);
      burst(e.x, e.y, e.color, e.isBoss ? 30 : 8, e.isBoss ? 260 : 130);
      if (e.isBoss) { Sound.boom(); G.shake = 14; showToast('BOSS 击破！'); }
      else Sound.hit();
      updateHUD();
    }
  }

  // ---------- 主更新 ----------
  function update(dt) {
    const pl = G.player;
    G.time += dt;

    // 移动输入
    let mx = 0, my = 0;
    if (G.keys['w'] || G.keys['arrowup']) my -= 1;
    if (G.keys['s'] || G.keys['arrowdown']) my += 1;
    if (G.keys['a'] || G.keys['arrowleft']) mx -= 1;
    if (G.keys['d'] || G.keys['arrowright']) mx += 1;
    if (G.joy.active) { mx += G.joy.dx; my += G.joy.dy; }
    const ml = Math.hypot(mx, my);
    if (ml > 0) { mx /= ml; my /= ml; pl.angle = Math.atan2(my, mx); pl.walk += dt * 12; }
    pl.x += mx * pl.speed * dt; pl.y += my * pl.speed * dt;
    if (pl.invuln > 0) pl.invuln -= dt;

    // 相机跟随
    G.cam.x += (pl.x - G.cam.x) * Math.min(1, dt * 6);
    G.cam.y += (pl.y - G.cam.y) * Math.min(1, dt * 6);
    if (G.shake > 0) G.shake = Math.max(0, G.shake - dt * 30);

    // 生命恢复（幸运被动无回血，靠强健体魄回满）
    // 生成敌人
    G.spawnTimer -= dt;
    const interval = Math.max(.18, 1.1 - G.time / 240);
    if (G.spawnTimer <= 0) {
      G.spawnTimer = interval;
      const roll = Math.random();
      let type = 'bat';
      if (G.time > 45 && roll > .65) type = 'slime';
      if (G.time > 90 && roll > .82) type = 'ghost';
      if (G.time > 150 && roll > .92) type = 'brute';
      spawnEnemy(type);
      // 随时间成群
      if (G.time > 70 && Math.random() < .35) spawnEnemy('bat');
    }
    // Boss
    if (G.time >= G.nextBoss) {
      spawnEnemy('boss'); G.nextBoss += 60;
      showToast('⚠ BOSS 来袭！'); G.shake = 10; Sound.boom();
    }

    // 敌人更新
    for (const e of G.enemies) {
      if (e.dead) continue;
      e.flash = Math.max(0, e.flash - dt);
      e.hitCd = Math.max(0, e.hitCd - dt);
      e.phase += dt * 4;
      const a = Math.atan2(pl.y - e.y, pl.x - e.x);
      let sp = e.speed;
      if (e.shape === 'ghost') sp *= 1 + Math.sin(e.phase) * .18;
      e.x += Math.cos(a) * sp * dt; e.y += Math.sin(a) * sp * dt;
      // 接触伤害
      const rr = (e.r + pl.r) * (e.r + pl.r);
      if (dist2(e.x, e.y, pl.x, pl.y) < rr && pl.invuln <= 0) {
        const dmg = Math.max(1, Math.round(e.dmg * pl.armor));
        pl.hp -= dmg; pl.invuln = .7;
        dmgText(pl.x, pl.y - 20, '-' + dmg, '#ff6a6a');
        G.shake = 8; Sound.hurt(); updateHUD();
        if (pl.hp <= 0) { gameOver(); return; }
      }
    }
    G.enemies = G.enemies.filter(e => !e.dead);

    // 武器
    updateWeapons(dt);

    // 子弹
    for (const p of G.projectiles) {
      p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; p.rot += dt * 18;
      for (const e of G.enemies) {
        if (e.dead) continue;
        if (dist2(p.x, p.y, e.x, e.y) < (p.r + e.r) * (p.r + e.r)) {
          damageEnemy(e, p.dmg); burst(p.x, p.y, p.color, 4, 90);
          p.life = 0; break;
        }
      }
    }
    G.projectiles = G.projectiles.filter(p => p.life > 0);
    G.enemies = G.enemies.filter(e => !e.dead);

    // 经验珠
    const pickR = 46 * pl.pickup;
    for (const g of G.gems) {
      g.t += dt * 3;
      const d = Math.hypot(pl.x - g.x, pl.y - g.y);
      if (d < pickR) {
        const a = Math.atan2(pl.y - g.y, pl.x - g.x), pull = 420 * (1 - d / pickR) + 120;
        g.x += Math.cos(a) * pull * dt; g.y += Math.sin(a) * pull * dt;
      } else {
        g.x += g.vx * dt; g.y += g.vy * dt; g.vx *= .94; g.vy *= .94;
      }
      if (d < pl.r + 4) { g.got = true; gainExp(g.exp); Sound.pickup(); burst(g.x, g.y, '#7be0ff', 3, 60); }
    }
    G.gems = G.gems.filter(g => !g.got);

    // 特效
    for (const p of G.particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= .93; p.vy *= .93; p.life -= dt; }
    G.particles = G.particles.filter(p => p.life > 0);
    for (const d of G.dmgTexts) { d.y -= 34 * dt; d.life -= dt; }
    G.dmgTexts = G.dmgTexts.filter(d => d.life > 0);
    for (const h of G.hazards) h.life -= dt;
    G.hazards = G.hazards.filter(h => h.life > 0);

    if (Math.floor(G.time * 2) !== Math.floor((G.time - dt) * 2)) updateHUD();
  }

  // ---------- 渲染 ----------
  function render() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = '#0a0a12'; ctx.fillRect(0, 0, W, H);
    if (!G.player) return;
    const shakeX = G.shake ? rand(-G.shake, G.shake) : 0, shakeY = G.shake ? rand(-G.shake, G.shake) : 0;
    ctx.save();
    ctx.translate(W / 2 - G.cam.x + shakeX, H / 2 - G.cam.y + shakeY);

    drawGround();

    // 经验珠
    for (const g of G.gems) {
      const pulse = 1 + Math.sin(g.t) * .18;
      ctx.fillStyle = '#7be0ff'; ctx.shadowColor = '#7be0ff'; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(g.x, g.y, g.r * pulse, 0, TAU); ctx.fill();
      ctx.shadowBlur = 0;
    }

    // 危险区域
    for (const h of G.hazards) {
      const k = h.life / h.max;
      if (h.type === 'fire') {
        ctx.fillStyle = 'rgba(255,110,60,' + (k * .35) + ')';
        ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, TAU); ctx.fill();
        ctx.strokeStyle = 'rgba(255,160,80,' + k + ')'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(h.x, h.y, h.r * .9, 0, TAU); ctx.stroke();
      } else {
        ctx.strokeStyle = 'rgba(150,200,255,' + k + ')'; ctx.lineWidth = 3 + k * 3;
        ctx.shadowColor = '#9fd8ff'; ctx.shadowBlur = 16;
        ctx.beginPath(); ctx.moveTo(h.x + rand(-20, 20), h.y - 400); ctx.lineTo(h.x, h.y); ctx.stroke();
        ctx.shadowBlur = 0;
      }
    }

    // 敌人
    for (const e of G.enemies) drawEnemy(e);

    // 玩家
    drawPlayer();

    // 子弹
    for (const p of G.projectiles) {
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = p.color; ctx.shadowColor = p.color; ctx.shadowBlur = 8;
      ctx.fillRect(-p.r, -p.r * .4, p.r * 2, p.r * .8);
      ctx.restore(); ctx.shadowBlur = 0;
    }

    // 圣书环绕
    if (G.weapons.bible) {
      const lv = G.weapons.bible, count = 2 + Math.floor(lv / 2), radius = 62 + lv * 3;
      for (let i = 0; i < count; i++) {
        const a = orbitAngle * 1.4 + i / count * TAU;
        const bx = G.player.x + Math.cos(a) * radius, by = G.player.y + Math.sin(a) * radius;
        ctx.save(); ctx.translate(bx, by); ctx.rotate(a);
        ctx.fillStyle = '#c9a6ff'; ctx.shadowColor = '#c9a6ff'; ctx.shadowBlur = 10;
        ctx.fillRect(-8, -11, 16, 22); ctx.fillStyle = '#fff'; ctx.fillRect(-6, -9, 3, 18);
        ctx.restore(); ctx.shadowBlur = 0;
      }
    }

    // 粒子
    for (const p of G.particles) {
      ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
      ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 伤害数字
    for (const d of G.dmgTexts) {
      ctx.globalAlpha = clamp(d.life / .7, 0, 1);
      ctx.fillStyle = d.color; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center';
      ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.lineWidth = 3;
      ctx.strokeText(d.val, d.x, d.y); ctx.fillText(d.val, d.x, d.y);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawGround() {
    const cx = G.cam.x, cy = G.cam.y;
    const x0 = Math.floor((cx - W / 2) / 80) - 1, x1 = Math.ceil((cx + W / 2) / 80) + 1;
    const y0 = Math.floor((cy - H / 2) / 80) - 1, y1 = Math.ceil((cy + H / 2) / 80) + 1;
    ctx.strokeStyle = 'rgba(120,130,180,.07)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = x0; x <= x1; x++) { ctx.moveTo(x * 80, y0 * 80); ctx.lineTo(x * 80, y1 * 80); }
    for (let y = y0; y <= y1; y++) { ctx.moveTo(x0 * 80, y * 80); ctx.lineTo(x1 * 80, y * 80); }
    ctx.stroke();
    // 圣光环可视化
    if (G.weapons.aura) {
      const r = 60 + G.weapons.aura * 12;
      ctx.strokeStyle = 'rgba(255,215,106,' + (.16 + Math.sin(G.time * 3) * .05) + ')';
      ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(G.player.x, G.player.y, r, 0, TAU); ctx.stroke();
    }
  }

  function drawPlayer() {
    const pl = G.player;
    ctx.save(); ctx.translate(pl.x, pl.y);
    // 影子
    ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(2, 8, pl.r, pl.r * .5, 0, 0, TAU); ctx.fill();
    const alpha = pl.invuln > 0 && Math.floor(pl.invuln * 20) % 2 ? .4 : 1;
    ctx.globalAlpha = alpha;
    // 身体
    ctx.fillStyle = '#ffe08a'; ctx.shadowColor = '#ffd76a'; ctx.shadowBlur = 12;
    ctx.beginPath(); ctx.arc(0, 0, pl.r, 0, TAU); ctx.fill(); ctx.shadowBlur = 0;
    // 眼睛（朝向）
    ctx.fillStyle = '#2a2338';
    const ex = Math.cos(pl.angle) * 5, ey = Math.sin(pl.angle) * 5;
    ctx.beginPath(); ctx.arc(ex - 3, ey - 2, 2, 0, TAU); ctx.arc(ex + 3, ey - 2, 2, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1; ctx.restore();
  }

  function drawEnemy(e) {
    ctx.save(); ctx.translate(e.x, e.y);
    ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.ellipse(1, e.r * .6, e.r, e.r * .45, 0, 0, TAU); ctx.fill();
    const col = e.flash > 0 ? '#fff' : e.color;
    ctx.fillStyle = col; ctx.shadowColor = e.color; ctx.shadowBlur = e.isBoss ? 20 : 6;
    ctx.beginPath();
    switch (e.shape) {
      case 'bat':
        ctx.moveTo(0, e.r); ctx.lineTo(-e.r * 1.4, -e.r * .5 + Math.sin(e.phase) * 5);
        ctx.lineTo(-e.r * .3, 0); ctx.lineTo(0, e.r * .6); ctx.lineTo(e.r * .3, 0);
        ctx.lineTo(e.r * 1.4, -e.r * .5 + Math.sin(e.phase) * 5); ctx.closePath(); break;
      case 'slime':
        ctx.ellipse(0, 2, e.r, e.r * (.85 + Math.sin(e.phase) * .1), 0, 0, TAU); break;
      case 'ghost':
        ctx.arc(0, -2, e.r, Math.PI, 0); ctx.lineTo(e.r, e.r * .8);
        for (let i = 0; i < 3; i++) { ctx.lineTo(e.r - (i * 2 + 1) * e.r / 3, e.r * .55); ctx.lineTo(e.r - (i * 2 + 2) * e.r / 3, e.r * .9); }
        ctx.closePath(); break;
      case 'brute':
        for (let i = 0; i < 8; i++) { const a = i / 8 * TAU, rr = i % 2 ? e.r : e.r * .8; i ? ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); } ctx.closePath(); break;
      default:
        ctx.arc(0, 0, e.r, 0, TAU);
    }
    ctx.fill(); ctx.shadowBlur = 0;
    // 眼睛
    ctx.fillStyle = '#1a1020';
    ctx.beginPath(); ctx.arc(-e.r * .3, -e.r * .15, Math.max(1.5, e.r * .13), 0, TAU); ctx.arc(e.r * .3, -e.r * .15, Math.max(1.5, e.r * .13), 0, TAU); ctx.fill();
    // Boss 血条
    if (e.isBoss) {
      ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(-e.r, -e.r - 14, e.r * 2, 6);
      ctx.fillStyle = '#ff4d5e'; ctx.fillRect(-e.r, -e.r - 14, e.r * 2 * clamp(e.hp / e.maxhp, 0, 1), 6);
    }
    ctx.restore();
  }

  // ---------- HUD ----------
  function updateHUD() {
    if (!G.player) return;
    $('timer').textContent = fmtTime(G.time);
    $('kills').textContent = G.kills;
    $('level').textContent = G.level;
    $('level-badge').textContent = 'LV.' + G.level;
    const hpRatio = clamp(G.player.hp / G.player.maxhp, 0, 1);
    $('hp-bar').style.transform = 'scaleX(' + hpRatio + ')';
    $('hp-label').textContent = Math.max(0, Math.ceil(G.player.hp)) + ' / ' + G.player.maxhp;
    $('exp-bar').style.transform = 'scaleX(' + clamp(G.acc / G.expNext, 0, 1) + ')';
  }

  let toastTimer = null;
  function showToast(text) {
    const el = $('toast').querySelector('span'); el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1400);
  }

  function gameOver() {
    G.state = 'gameover'; Sound.boom();
    const best = loadBest();
    const isRecord = G.time > best.time || (G.time === best.time && G.kills > best.kills);
    if (isRecord) { saveBest({ time: Math.max(best.time, G.time), kills: Math.max(best.kills, G.kills) }); }
    $('final-time').textContent = fmtTime(G.time);
    $('final-kills').textContent = G.kills;
    $('final-level').textContent = G.level;
    $('newrecord').classList.toggle('hidden', !isRecord);
    ['hud', 'pause-btn', 'mute-btn', 'joystick'].forEach(id => $(id).classList.add('hidden'));
    $('gameover').classList.remove('hidden');
    refreshBest();
  }
  function refreshBest() { const b = loadBest(); $('best-time').textContent = fmtTime(b.time); $('best-kills').textContent = b.kills; }

  function pause() { if (G.state !== 'playing') return; G.state = 'paused'; $('paused').classList.remove('hidden'); }
  function resume() { if (G.state !== 'paused') return; G.state = 'playing'; $('paused').classList.add('hidden'); last = performance.now(); }
  function goHome() {
    G.state = 'menu';
    ['gameover', 'paused', 'levelup'].forEach(id => $(id).classList.add('hidden'));
    ['hud', 'pause-btn', 'mute-btn', 'joystick'].forEach(id => $(id).classList.add('hidden'));
    refreshBest(); $('menu').classList.remove('hidden');
  }

  // ---------- 按钮绑定 ----------
  $('start-btn').onclick = () => { Sound.click(); startGame(); };
  $('retry-btn').onclick = () => { Sound.click(); startGame(); };
  $('home-btn').onclick = () => { Sound.click(); goHome(); };
  $('quit-btn').onclick = () => { Sound.click(); goHome(); };
  $('resume-btn').onclick = () => { Sound.click(); resume(); };
  $('pause-btn').onclick = () => { Sound.click(); pause(); };
  $('how-btn').onclick = () => { Sound.click(); $('menu').classList.add('hidden'); $('how').classList.remove('hidden'); };
  $('how-back').onclick = () => { Sound.click(); $('how').classList.add('hidden'); $('menu').classList.remove('hidden'); };
  $('mute-btn').onclick = () => { Sound.muted = !Sound.muted; $('mute-btn').textContent = Sound.muted ? '🔇' : '🔊'; };

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
  requestAnimationFrame(loop);
})();
