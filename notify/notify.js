'use strict';
/*
 Рассылка напоминаний. Запускается GitHub Actions раз в 5 минут.
 Читает data.json из приватного репозитория с данными, решает, что пора отправить,
 и шлёт web push на подписанные устройства. В логах только количества, без текста задач.
*/

function toMin(s) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  return m ? (+m[1]) * 60 + (+m[2]) : -1;
}

function localParts(now, tz) {
  var f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
  });
  var p = {};
  f.formatToParts(now).forEach(function (x) { p[x.type] = x.value; });
  var hh = p.hour === '24' ? 0 : +p.hour;
  var dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { date: p.year + '-' + p.month + '-' + p.day, min: hh * 60 + (+p.minute), dow: dow, dom: +p.day, y: +p.year, m: +p.month };
}

function recDue(r, L) {
  if (r.freq === 'd') return true;
  if (r.freq === 'w') return (r.days || []).indexOf(L.dow) >= 0;
  if (r.freq === 'm') {
    var last = new Date(Date.UTC(L.y, L.m, 0)).getUTCDate();
    return L.dom === Math.min(r.dom || 1, last);
  }
  return false;
}

function plan(data, state, now) {
  var set = data.set || {};
  var L = localParts(now, set.tz);
  var lead = +set.lead >= 0 ? +set.lead : 10;
  var sent = (state && state.sent) || {};
  var out = [];
  function add(key, title, body) { if (!sent[key]) out.push({ key: key, title: title, body: body, tag: key }); }

  var tasks = (data.tasks || []).filter(function (t) { return !t.del && !t.done; });
  var recs = (data.rec || []).filter(function (r) { return !r.del && recDue(r, L) && !(r.log || {})[L.date]; });

  var mm = toMin(set.morning || '08:00');
  if (mm >= 0 && L.min >= mm && L.min <= mm + 180) {
    var over = tasks.filter(function (t) { return t.due && t.due < L.date; });
    var today = tasks.filter(function (t) { return t.due === L.date; })
      .sort(function (a, b) { return (a.time || '99') < (b.time || '99') ? -1 : 1; });
    var teamLate = over.filter(function (t) { return t.assignee; });
    if (over.length || today.length || recs.length) {
      var lines = today.slice(0, 3).map(function (t) { return (t.time ? t.time + ' ' : '') + t.t; });
      var head = 'Задач на сегодня: ' + today.length;
      if (over.length) head += '. Просрочено: ' + over.length;
      if (recs.length) head += '. Ритуалов: ' + recs.length;
      if (teamLate.length) head += '. У команды просрочено: ' + teamLate.length;
      add('dg:' + L.date, 'Планировщик, утро', [head].concat(lines).join('\n'));
    }
  }

  tasks.forEach(function (t) {
    var tm = toMin(t.time);
    if (tm < 0 || t.due !== L.date) return;
    if (L.min >= tm - lead && L.min <= tm + 240) {
      add('t:' + t.id + ':' + L.date + ':' + t.time, t.t, 'Сегодня в ' + t.time + (t.assignee ? ', исполнитель: ' + t.assignee : ''));
    }
  });
  recs.forEach(function (r) {
    var tm = toMin(r.time);
    if (tm < 0) return;
    if (L.min >= tm - lead && L.min <= tm + 240) {
      add('r:' + r.id + ':' + L.date + ':' + r.time, r.t, 'Сегодня в ' + r.time);
    }
  });
  return out;
}

async function main() {
  var webpush = require('web-push');
  var env = process.env;
  var path = env.DATA_PATH || 'data.json';
  if (!env.DATA_TOKEN || !env.DATA_REPO || !env.VAPID_PRIVATE) {
    throw new Error('Не заданы секреты DATA_TOKEN, DATA_REPO, VAPID_PRIVATE');
  }
  async function gh(p, accept, opt) {
    opt = opt || {};
    return fetch('https://api.github.com/repos/' + env.DATA_REPO + '/contents/' + p, {
      method: opt.method || 'GET',
      body: opt.body,
      headers: {
        Authorization: 'Bearer ' + env.DATA_TOKEN,
        Accept: accept || 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'planner-notify'
      }
    });
  }
  var dr = await gh(path, 'application/vnd.github.raw+json');
  if (dr.status === 404) { console.log('data.json ещё не создан'); return; }
  if (!dr.ok) throw new Error('Не удалось прочитать данные: ' + dr.status);
  var data = JSON.parse(await dr.text());

  var state = { sent: {}, dead: [] };
  var sha;
  var sr = await gh('notify-state.json');
  if (sr.ok) {
    var j = await sr.json();
    sha = j.sha;
    state = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
    state.sent = state.sent || {};
    state.dead = state.dead || [];
  }

  var pub = data.set && data.set.vapidPub;
  if (!pub) { console.log('Ключи VAPID не созданы в приложении'); return; }
  var subs = (data.subs || []).filter(function (s) {
    return !s.del && s.sub && s.sub.endpoint && state.dead.indexOf(s.sub.endpoint) < 0;
  });
  var msgs = plan(data, state, new Date());
  console.log('Сообщений к отправке: ' + msgs.length + ', подписок: ' + subs.length);
  if (!msgs.length || !subs.length) return;

  webpush.setVapidDetails('https://github.com/' + (env.GITHUB_REPOSITORY_OWNER || 'planner'), pub, env.VAPID_PRIVATE);
  var changed = false;
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i], ok = 0;
    for (var k = 0; k < subs.length; k++) {
      try {
        await webpush.sendNotification(subs[k].sub, JSON.stringify({ title: m.title, body: m.body, tag: m.tag, url: './' }), { TTL: 3600, urgency: 'high' });
        ok++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          state.dead.push(subs[k].sub.endpoint);
          changed = true;
        } else {
          console.log('Ошибка отправки: ' + (e.statusCode || e.message));
        }
      }
    }
    if (ok > 0) { state.sent[m.key] = Date.now(); changed = true; }
    console.log('Доставлено на устройств: ' + ok);
  }
  var cutoff = Date.now() - 3 * 864e5;
  Object.keys(state.sent).forEach(function (k) { if (state.sent[k] < cutoff) { delete state.sent[k]; changed = true; } });
  if (changed) {
    var body = { message: 'notify state', content: Buffer.from(JSON.stringify(state)).toString('base64') };
    if (sha) body.sha = sha;
    var pr = await gh('notify-state.json', null, { method: 'PUT', body: JSON.stringify(body) });
    if (!pr.ok) throw new Error('Не удалось сохранить состояние: ' + pr.status);
  }
}

module.exports = { plan: plan, localParts: localParts, recDue: recDue, toMin: toMin };

if (typeof require !== 'undefined' && require.main === module) {
  main().catch(function (e) { console.error(e.message); process.exit(1); });
}
