/**
 * 領収書アプリ v1.0.0（Step 1：撮る → 読み取り・確認 → 保存・台帳 → その場で申請）
 * 画面：GitHub Pages 上の1ページ。裏側：GAS「領収書アプリ_API」（Gemini の窓口）。
 *
 * 守っていること
 *  - Google のドライブ・カレンダーは、ログインした本人の権限で直接扱う（drive.file / drive.appdata / calendar.readonly）
 *    drive.appdata＝ドライブの中の「このアプリ専用の見えない場所」。保存先フォルダの設定を置く
 *  - 裏側APIに送るのは領収書の画像（またはPDF）だけ。氏名・メールアドレスは送らない
 *  - Slackへの送信はしない。申請文をコピーして、Slackを開くところまで
 *  - 重複は「立替日＋金額」で探し、保存の前に確かめる（利用会社はAIの書き方がゆれるので使わない）
 *  - ?demo=1 で開くと、Google にも裏側APIにもつながない見本モード（画面確認用）
 */
(function () {
  'use strict';

  var CFG = window.RECEIPT_CONFIG || {};
  var DEMO = /[?&]demo=1\b/.test(location.search);
  var VERSION = '1.0.0';
  var SCOPES = 'openid email profile https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/calendar.readonly';
  var DRIVE = 'https://www.googleapis.com/drive/v3', UPLOAD = 'https://www.googleapis.com/upload/drive/v3', SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets/';
  var ALL = 'supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives';
  var BUSY_RE = /high demand|overloaded|UNAVAILABLE|RESOURCE_EXHAUSTED|quota|→429|→503|HTTP 429|HTTP 503/i;
  var AUTO_RETRY_SEC = [60, 120];
  var PREFIX = CFG.ledgerPrefix || '立替金精算台帳_';
  var SLACK_URL = CFG.slackChannelUrl || 'https://replayce.slack.com/archives/C08J736MX5H';
  var HEADER = ['申請ID', '登録日時', '立替日', '対象月', '対象案件', '利用会社', '用途', 'インボイス登録番号', '金額（税込・円）', '支払方法', '読取ステータス', '申請状態', '申請日', '申請文', '領収書ファイル名', '領収書のリンク', '備考'];
  var C = { id: 0, at: 1, date: 2, month: 3, project: 4, vendor: 5, purpose: 6, invoice: 7, amount: 8, pay: 9, readStatus: 10, status: 11, claimedOn: 12, claim: 13, fileName: 14, fileUrl: 15, note: 16 };
  var LEGAL_RE = /(株式会社|有限会社|合同会社|合資会社|合名会社|社団法人|財団法人|学校法人|医療法人|社会福祉法人|特定非営利活動法人|NPO法人|独立行政法人|国立大学法人|（株）|\(株\)|㈱|市|区|町|村|県|都|府|道|庁|委員会|協会|組合|大学|病院|SS）|SS\))/;

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var S = { user: null, google: { token: '', exp: 0 }, session: '', settings: { folder: null }, settingsFileId: null, rows: [], ledgers: {}, cur: null, saved: null, screen: 'login', readSeq: 0 };

  // ============================================================ 小道具
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pad(n) { return ('0' + n).slice(-2); }
  var WD = ['日', '月', '火', '水', '木', '金', '土'];
  function isoDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function stamp() { var d = new Date(); return isoDate(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function parts(s) { var a = String(s).split('-').map(Number); return { y: a[0], m: a[1], d: a[2], ymd: String(s).replace(/-/g, '') }; }
  function yen(n) { return Number(n || 0).toLocaleString('ja-JP'); }
  function num(v) { var n = Number(String(v == null ? '' : v).replace(/[^\d]/g, '')); return isFinite(n) ? n : 0; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function errText(e) { return (e && (e.message || e)) || String(e); }
  function safeName(s) { return String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim(); }
  function qName(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
  /** 予定名から【確定】【くぼさん】［仮］などの印と、余分な空白を取り除く */
  function cleanTitle(s) { return String(s || '').replace(/【[^】]*】|［[^］]*］|\[[^\]]*\]/g, ' ').replace(/[\s　]+/g, ' ').trim(); }
  var toastTimer = null;
  function toast(msg, ng) {
    var t = $('#toast'); t.textContent = msg; t.className = 'toast' + (ng ? ' ng' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, ng ? 7000 : 3500);
  }

  function show(name) {
    $$('[data-screen]').forEach(function (el) { el.hidden = el.dataset.screen !== name; });
    $('#appHeader').hidden = name === 'login';
    var step = { confirm: 2, result: 3 }[name];
    $('#stepper').hidden = !step;
    $$('#stepper li').forEach(function (li) { li.classList.toggle('on', Number(li.dataset.step) === step); });
    S.screen = name; closeMenu(); window.scrollTo(0, 0);
  }

  // ============================================================ メニュー
  function closeMenu() { $('#menuPanel').hidden = true; $('#btnMenu').setAttribute('aria-expanded', 'false'); }
  $('#btnMenu').addEventListener('click', function (e) {
    e.stopPropagation(); var open = $('#menuPanel').hidden;
    $('#menuPanel').hidden = !open; this.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', function (e) { if (!e.target.closest('#menuPanel') && !e.target.closest('#btnMenu')) closeMenu(); });
  $$('#menuPanel [data-nav]').forEach(function (b) {
    b.addEventListener('click', function () {
      var to = b.dataset.nav; closeMenu();
      if (to === 'logout') logout();
      else if (to === 'folder') pickFolder();
      else if (to === 'ledger') openLedger();
      else if (canLeave()) goHome();
    });
  });
  $('#brandHome').addEventListener('click', function (e) { e.preventDefault(); if (canLeave()) goHome(); });
  $('#verLabel').textContent = 'v' + VERSION;
  function canLeave() {
    if (S.screen === 'confirm' && S.cur && !S.cur.saved && !confirm('まだ保存していません。この領収書を破棄して移動しますか？')) return false;
    return true;
  }

  // ============================================================ ログイン
  $('#domainLabel').textContent = CFG.allowedDomain || 'replayce.co.jp';
  if (/FBAN|FBAV|Instagram|Line\/|Slack|MicroMessenger|GSA\//i.test(navigator.userAgent) || /; wv\)/.test(navigator.userAgent)) $('#inAppWarn').hidden = false;

  var tokenClient = null, pendingToken = null;
  function getTokenClient() {
    if (tokenClient) return tokenClient;
    if (!window.google || !google.accounts || !google.accounts.oauth2) throw new Error('Googleのログイン部品を読み込めていません。少し待ってからもう一度押してください');
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CFG.clientId, scope: SCOPES, hd: CFG.allowedDomain,
      callback: function (r) {
        var p = pendingToken; pendingToken = null;
        if (r.error) { if (p) p.reject(new Error('ログインできませんでした（' + r.error + '）')); return; }
        S.google.token = r.access_token; S.google.exp = Date.now() + (Number(r.expires_in) || 3600) * 1000;
        if (p) p.resolve(r.access_token);
      },
      error_callback: function (e) { var p = pendingToken; pendingToken = null; if (p) p.reject(new Error(e.type === 'popup_closed' ? 'ログイン画面が閉じられました' : 'ログイン画面を開けませんでした（ポップアップの許可を確認してください）')); }
    });
    return tokenClient;
  }
  /** ボタン操作の中でだけ呼ぶ（Googleのログイン画面はユーザー操作がないと開けない） */
  function requestToken() {
    if (DEMO) { S.google.token = 'demo'; S.google.exp = Date.now() + 3600e3; return Promise.resolve('demo'); }
    return new Promise(function (resolve, reject) { pendingToken = { resolve: resolve, reject: reject }; getTokenClient().requestAccessToken({ prompt: '' }); });
  }
  function tokenValid() { return S.google.token && Date.now() < S.google.exp - 60000; }
  function ensureToken() { return tokenValid() ? Promise.resolve() : requestToken(); }

  $('#btnLogin').addEventListener('click', function () {
    var box = $('#loginError'); box.hidden = true;
    if (!DEMO && (!CFG.clientId || /ここに/.test(CFG.clientId) || !CFG.apiUrl || /ここに/.test(CFG.apiUrl))) {
      box.textContent = '設定（config.js）が未記入です。管理者に連絡してください。'; box.hidden = false; return;
    }
    var btn = this; btn.disabled = true;
    requestToken().then(function (tok) { return api('login', { accessToken: tok }); }).then(function (r) {
      if (!r.ok) throw new Error(r.error || 'ログインの確認に失敗しました');
      S.session = r.session; S.user = { email: r.email, name: r.email.split('@')[0] };
      return gfetch('https://www.googleapis.com/oauth2/v3/userinfo').then(function (u) { if (u && (u.name || u.given_name)) S.user.name = u.name || u.given_name; }).catch(function () {});
    }).then(loadSettings).then(function () {
      $('#menuName').textContent = S.user.name; $('#menuEmail').textContent = S.user.email; $('#menuInitial').textContent = S.user.name.slice(0, 1);
      goHome();
    }).catch(function (e) { box.textContent = errText(e); box.hidden = false; }).then(function () { btn.disabled = false; });
  });
  function logout() {
    if (!canLeave()) return;
    if (window.google && google.accounts && google.accounts.oauth2 && S.google.token && !DEMO) { try { google.accounts.oauth2.revoke(S.google.token, function () {}); } catch (e) {} }
    S.google = { token: '', exp: 0 }; S.session = ''; S.user = null; S.settings = { folder: null }; S.settingsFileId = null; S.rows = []; S.ledgers = {}; S.cur = null; S.saved = null;
    show('login');
  }

  // ============================================================ 裏側API（GAS）・Google API
  /** 通信そのものの失敗（Failed to fetch／返事が読めない）は、3秒あけて1回だけやり直す */
  function api(action, payload, retried) {
    if (DEMO) return demoApi(action, payload);
    var t0 = Date.now();
    return fetch(CFG.apiUrl, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow',
      body: JSON.stringify(Object.assign({ action: action, session: S.session }, payload || {}))
    }).then(function (res) { return res.text(); }).then(function (t) {
      var j; try { j = JSON.parse(t); } catch (e) { throw new Error('裏側APIの返事を読めませんでした'); }
      j.ms = Date.now() - t0;
      if (j.code === 401 && action !== 'login') throw new Error('ログインの期限が切れました。メニューからログアウトして、もう一度ログインしてください');
      return j;
    }).catch(function (e) {
      if (retried || action === 'login' || /ログインの期限/.test(errText(e))) throw e;
      return sleep(3000).then(function () { return api(action, payload, true); });
    });
  }
  function gfetch(url, opts) {
    if (!tokenValid()) return Promise.reject(new Error('Googleのログインが切れました。もう一度ボタンを押してください'));
    opts = opts || {}; opts.headers = Object.assign({ Authorization: 'Bearer ' + S.google.token }, opts.headers || {});
    return fetch(url, opts).then(function (res) {
      return res.text().then(function (t) {
        var j = null; try { j = JSON.parse(t); } catch (e) {}
        if (!res.ok) throw new Error('Google HTTP ' + res.status + ' ' + ((j && j.error && (j.error.message || j.error)) || ''));
        return j;
      });
    });
  }
  function jsonPost(url, body, method) { return gfetch(url, { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }

  // ============================================================ 設定（ドライブのアプリ専用領域 settings.json）
  function loadSettings() {
    if (DEMO) { S.settings = { folder: { id: 'demo', name: '稼働（見本）' } }; return Promise.resolve(); }
    return gfetch(DRIVE + '/files?spaces=appDataFolder&fields=files(id)&q=' + encodeURIComponent("name='receipt-settings.json'")).then(function (j) {
      var f = (j.files || [])[0]; if (!f) return;
      S.settingsFileId = f.id;
      return gfetch(DRIVE + '/files/' + f.id + '?alt=media').then(function (s) { if (s) S.settings = Object.assign({ folder: null }, s); });
    }).catch(function () {});
  }
  function saveSettings() {
    if (DEMO) return Promise.resolve();
    var body = new Blob([JSON.stringify(S.settings)], { type: 'application/json' });
    if (S.settingsFileId) return gfetch(UPLOAD + '/files/' + S.settingsFileId + '?uploadType=media', { method: 'PATCH', body: body });
    return multipartUpload({ name: 'receipt-settings.json', parents: ['appDataFolder'] }, body, true).then(function (f) { S.settingsFileId = f.id; });
  }

  // ============================================================ 保存先フォルダ（Google Picker。選んだフォルダだけがアプリに許可される）
  var pickerReady = null;
  function loadPicker() {
    if (pickerReady) return pickerReady;
    pickerReady = new Promise(function (res, rej) {
      var sc = document.createElement('script'); sc.src = 'https://apis.google.com/js/api.js';
      sc.onload = function () { gapi.load('picker', { callback: res, onerror: function () { rej(new Error('フォルダ選択の部品を読み込めませんでした')); } }); };
      sc.onerror = function () { pickerReady = null; rej(new Error('フォルダ選択の部品を読み込めませんでした')); };
      document.head.appendChild(sc);
    });
    return pickerReady;
  }
  function pickFolder() {
    if (DEMO) { S.settings.folder = { id: 'demo', name: '稼働（見本）' }; toast('保存先を「稼働（見本）」にしました'); goHome(); return Promise.resolve(); }
    if (!CFG.pickerApiKey || /ここに/.test(CFG.pickerApiKey)) { toast('フォルダ選択の設定（config.js の pickerApiKey）が未記入です。管理者に連絡してください', true); return Promise.resolve(); }
    return ensureToken().then(loadPicker).then(function () {
      return new Promise(function (resolve) {
        var P = google.picker;
        var mine = new P.DocsView(P.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes('application/vnd.google-apps.folder');
        var shared = new P.DocsView(P.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes('application/vnd.google-apps.folder').setEnableDrives(true);
        var b = new P.PickerBuilder().setTitle('「○年○月稼働」フォルダが並んでいるフォルダを選んでください').addView(mine).addView(shared)
          .setOAuthToken(S.google.token).setDeveloperKey(CFG.pickerApiKey).setAppId(String(CFG.clientId).split('-')[0]).setLocale('ja')
          .setCallback(function (data) {
            var act = data[P.Response.ACTION];
            if (act === P.Action.CANCEL) { resolve(); return; }
            if (act !== P.Action.PICKED) return;
            var id = data[P.Response.DOCUMENTS][0][P.Document.ID];
            gfetch(DRIVE + '/files/' + id + '?supportsAllDrives=true&fields=id,name,driveId,capabilities(canAddChildren)').then(function (f) {
              if (f.capabilities && f.capabilities.canAddChildren === false) { toast('このフォルダには保存する権限がありません。別のフォルダを選んでください', true); return; }
              S.settings.folder = { id: f.id, name: f.name, driveId: f.driveId || '' }; S.ledgers = {};
              return saveSettings().then(function () { toast('保存先を「' + f.name + '」にしました'); if (S.screen === 'home') goHome(); else updatePreview(); });
            }).catch(function (e) { toast('フォルダを確認できませんでした：' + errText(e), true); }).then(resolve);
          });
        if (P.Feature && P.Feature.SUPPORT_DRIVES) b.enableFeature(P.Feature.SUPPORT_DRIVES);
        b.build().setVisible(true);
      });
    }).catch(function (e) { toast(errText(e), true); });
  }

  // ============================================================ ドライブ
  function listChildren(parentId, extraQ) {
    var q = "'" + parentId + "' in parents and trashed=false" + (extraQ ? ' and ' + extraQ : '');
    return gfetch(DRIVE + '/files?' + ALL + '&pageSize=200&fields=files(id,name,mimeType,webViewLink)&q=' + encodeURIComponent(q)).then(function (j) { return j.files || []; });
  }
  function createFolder(name, parentId) { return jsonPost(DRIVE + '/files?supportsAllDrives=true&fields=id,name,webViewLink', { name: name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }); }
  function multipartUpload(meta, blob, appData) {
    var boundary = 'b' + Math.random().toString(16).slice(2);
    var body = new Blob(['--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n',
      '--' + boundary + '\r\nContent-Type: ' + (blob.type || 'application/octet-stream') + '\r\n\r\n', blob, '\r\n--' + boundary + '--']);
    return gfetch(UPLOAD + '/files?uploadType=multipart' + (appData ? '' : '&supportsAllDrives=true') + '&fields=id,name,webViewLink', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: body });
  }
  /** 「2026年10月稼働」「2026年09月稼働」どちらの書き方でも見つける。無ければ作る */
  function monthFolder(y, m) {
    return listChildren(S.settings.folder.id, "mimeType='application/vnd.google-apps.folder'").then(function (list) {
      var hit = list.filter(function (f) { var x = f.name.match(/(\d{4})年0?(\d{1,2})月稼働/); return x && Number(x[1]) === y && Number(x[2]) === m; })[0];
      return hit || createFolder(y + '年' + m + '月稼働', S.settings.folder.id);
    });
  }

  // ============================================================ 台帳（1人1ファイル・1年1ファイル・月ごとに1シート）
  function ledgerUrl(id) { return 'https://docs.google.com/spreadsheets/d/' + id + '/edit'; }
  function findLedger(y, create) {
    if (S.ledgers[y]) return Promise.resolve(S.ledgers[y]);
    var title = PREFIX + y;
    return listChildren(S.settings.folder.id, "mimeType='application/vnd.google-apps.spreadsheet' and name='" + qName(title) + "'").then(function (list) {
      if (list.length) return (S.ledgers[y] = { id: list[0].id, created: false });
      if (!create) return null;
      return jsonPost(DRIVE + '/files?supportsAllDrives=true&fields=id', { name: title, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [S.settings.folder.id] })
        .then(function (f) { return (S.ledgers[y] = { id: f.id, created: true }); });
    });
  }
  function rangeUrl(ssId, range) { return SHEETS + ssId + '/values/' + encodeURIComponent(range); }
  /** 今年（1月は去年も）の台帳を全部読む */
  function loadRows() {
    if (DEMO) { S.rows = demoRows(); return Promise.resolve(); }
    if (!S.settings.folder) { S.rows = []; return Promise.resolve(); }
    var now = new Date(), years = [now.getFullYear()]; if (now.getMonth() === 0) years.push(now.getFullYear() - 1);
    var rows = [];
    return Promise.all(years.map(function (y) {
      return findLedger(y, false).then(function (L) {
        if (!L) return;
        return gfetch(SHEETS + L.id + '?fields=sheets.properties(title)').then(function (meta) {
          var tabs = (meta.sheets || []).map(function (s) { return s.properties.title; }).filter(function (t) { return /^\d{4}-\d{2}$/.test(t); });
          if (!tabs.length) return;
          var q = tabs.map(function (t) { return 'ranges=' + encodeURIComponent("'" + t + "'!A2:Q"); }).join('&');
          return gfetch(SHEETS + L.id + '/values:batchGet?' + q).then(function (j) {
            (j.valueRanges || []).forEach(function (vr, i) { (vr.values || []).forEach(function (r) { if (r[C.id]) rows.push({ ssId: L.id, tab: tabs[i], cells: r }); }); });
          });
        });
      });
    })).then(function () { S.rows = rows; });
  }
  async function ensureMonthSheet(L, tab) {
    var meta = await gfetch(SHEETS + L.id + '?fields=sheets.properties(sheetId,title)');
    var sheets = (meta.sheets || []).map(function (s) { return s.properties; });
    var mine = sheets.filter(function (s) { return s.title === tab; })[0];
    if (mine) return mine.sheetId;
    var rename = L.created && sheets.length === 1 && !/^\d{4}-\d{2}$/.test(sheets[0].title);
    var req = rename ? { updateSheetProperties: { properties: { sheetId: sheets[0].sheetId, title: tab, gridProperties: { frozenRowCount: 1 } }, fields: 'title,gridProperties.frozenRowCount' } }
      : { addSheet: { properties: { title: tab, gridProperties: { frozenRowCount: 1 } } } };
    var res = await jsonPost(SHEETS + L.id + ':batchUpdate', { requests: [req] });
    var sheetId = rename ? sheets[0].sheetId : res.replies[0].addSheet.properties.sheetId;
    await jsonPost(rangeUrl(L.id, "'" + tab + "'!A1") + '?valueInputOption=RAW', { values: [HEADER] }, 'PUT');
    // 申請状態（L列）はプルダウン、申請文（N列）は折り返して全部見えるように
    await jsonPost(SHEETS + L.id + ':batchUpdate', { requests: [
      { setDataValidation: { range: { sheetId: sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: C.status, endColumnIndex: C.status + 1 },
        rule: { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: '未申請' }, { userEnteredValue: '申請済み' }] }, strict: true, showCustomUi: true } } },
      { repeatCell: { range: { sheetId: sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: C.claim, endColumnIndex: C.claim + 1 }, cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat.wrapStrategy' } },
      { updateDimensionProperties: { range: { sheetId: sheetId, dimension: 'COLUMNS', startIndex: C.claim, endIndex: C.claim + 1 }, properties: { pixelSize: 320 }, fields: 'pixelSize' } },
      { repeatCell: { range: { sheetId: sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.933, green: 0.949, blue: 0.98 } } }, fields: 'userEnteredFormat(textFormat,backgroundColor)' } }
    ] });
    return sheetId;
  }
  /** 申請IDで行を探して、申請状態と申請日を書き換える（並べ替えられていても正しい行に書く） */
  async function setStatus(ssId, tab, id, status) {
    var j = await gfetch(rangeUrl(ssId, "'" + tab + "'!A:A"));
    var idx = (j.values || []).findIndex(function (r) { return r[0] === id; });
    if (idx < 0) throw new Error('台帳にこの申請が見つかりません（行が消されたかもしれません）');
    await jsonPost(rangeUrl(ssId, "'" + tab + "'!L" + (idx + 1) + ':M' + (idx + 1)) + '?valueInputOption=RAW', { values: [[status, status === '申請済み' ? isoDate(new Date()) : '']] }, 'PUT');
  }
  function openLedger() {
    if (!S.settings.folder) { toast('先に保存先フォルダを選んでください', true); return; }
    var y = new Date().getFullYear();
    findLedger(y, false).then(function (L) {
      if (!L) { toast(y + '年の台帳はまだありません。最初の1枚を保存すると作られます'); return; }
      window.open(ledgerUrl(L.id), '_blank', 'noopener');
    }).catch(function (e) { toast(errText(e), true); });
  }

  // ============================================================ 1 ホーム
  function goHome() {
    show('home');
    var d = new Date(); $('#todayLabel').textContent = d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日（' + WD[d.getDay()] + '）';
    $('#folderSetup').hidden = !!S.settings.folder;
    $('#recentNote').textContent = S.settings.folder ? '保存先：' + S.settings.folder.name : '';
    $('#sumCount').textContent = '…'; $('#sumTotal').textContent = '…';
    loadRows().then(renderHome).catch(function (e) { toast('台帳を読み込めませんでした：' + errText(e), true); renderHome(); });
  }
  function renderHome() {
    var wait = S.rows.filter(function (r) { return r.cells[C.status] === '未申請'; });
    var total = wait.reduce(function (s, r) { return s + num(r.cells[C.amount]); }, 0);
    $('#sumCount').textContent = wait.length; $('#sumTotal').textContent = yen(total);
    $('#sumEmpty').hidden = wait.length > 0 || !S.settings.folder;
    var old = wait.map(function (r) { return r.cells[C.date]; }).filter(Boolean).sort()[0];
    if (old) {
      var p = parts(old), days = Math.floor((new Date(isoDate(new Date())) - new Date(old)) / 864e5);
      $('#sumOld').textContent = 'いちばん古いものは' + p.m + '月' + p.d + '日（' + days + '日前）です。' + (days >= 7 ? '月末まで溜めずに出しましょう。' : '');
      $('#sumOld').hidden = false;
    } else $('#sumOld').hidden = true;
    var recent = S.rows.slice().sort(function (a, b) { return String(b.cells[C.at]).localeCompare(String(a.cells[C.at])); }).slice(0, 8);
    var box = $('#recentList'); box.innerHTML = '';
    box.hidden = !recent.length; $('#recentEmpty').hidden = !!recent.length || !S.settings.folder;
    recent.forEach(function (r) {
      var c = r.cells, p = parts(c[C.date] || ''), done = c[C.status] === '申請済み';
      var b = document.createElement('button'); b.type = 'button'; b.className = 'row-item';
      b.innerHTML = '<span class="row-date"><span class="m">' + (p.m || '-') + '月</span><span class="d">' + (p.d || '-') + '</span></span>' +
        '<span class="row-main"><b>' + esc(c[C.vendor]) + '</b><span class="small">' + esc(c[C.project]) + '</span></span>' +
        '<span class="row-amt">' + yen(num(c[C.amount])) + '円<br><span class="pill ' + (done ? 'done' : 'wait') + '">' + (done ? '申請済み' : '未申請') + '</span></span>';
      b.addEventListener('click', function () { openSaved(r); });
      box.appendChild(b);
    });
  }

  // ============================================================ 撮る・選ぶ
  $$('[data-action="shoot"], [data-action="reshoot"]').forEach(function (b) { b.addEventListener('click', function () { if (b.dataset.action === 'shoot' && S.screen === 'confirm' && !canLeave()) return; $('#fileShoot').value = ''; $('#fileShoot').click(); }); });
  $$('[data-action="pick-file"]').forEach(function (b) { b.addEventListener('click', function () { $('#filePick').value = ''; $('#filePick').click(); }); });
  $$('[data-action="pick-folder"]').forEach(function (b) { b.addEventListener('click', pickFolder); });
  $$('[data-action="home"]').forEach(function (b) { b.addEventListener('click', function () { goHome(); }); });
  ['#fileShoot', '#filePick'].forEach(function (sel) { $(sel).addEventListener('change', function () { var f = this.files && this.files[0]; if (f) startConfirm(f); }); });

  /** 画像は長辺1600pxのJPEGに縮める（文字が読める大きさ）。PDFはそのまま */
  function prepare(file) {
    if (file.type === 'application/pdf') return Promise.resolve({ blob: file, mime: 'application/pdf' });
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight, s = Math.min(1, 1600 / Math.max(w, h));
        var c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? resolve({ blob: b, mime: 'image/jpeg' }) : reject(new Error('画像を縮められませんでした')); }, 'image/jpeg', 0.85);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('この形式の画像は開けません（iPhoneの写真なら、Safariから選ぶと開けます）')); };
      img.src = url;
    });
  }
  function toBase64(blob) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(String(r.result).split(',')[1] || ''); }; r.onerror = rej; r.readAsDataURL(blob); }); }

  // ============================================================ 2 読み取り・確認
  var F = { date: '#fDate', amount: '#fAmount', vendor: '#fVendor', purpose: '#fPurpose', project: '#fProject', pay: '#fPay', invoice: '#fInvoice' };
  function fv(k) { return $(F[k]).value.trim(); }
  function form() { return { date: fv('date'), amount: num(fv('amount')), project: fv('project'), vendor: fv('vendor'), purpose: fv('purpose'), pay: fv('pay'), invoice: fv('invoice') }; }

  function startConfirm(file) {
    S.readSeq++;
    if (S.cur && S.cur.url) URL.revokeObjectURL(S.cur.url);
    S.cur = { file: file, ai: null, saved: false, events: [] };
    Object.keys(F).forEach(function (k) { var el = $(F[k]); if (k !== 'pay') el.value = ''; el.classList.remove('check'); });
    $('#fPay').value = '不明'; $('#dupWarn').hidden = true; $('#vendorHint').classList.remove('warn');
    var isPdf = file.type === 'application/pdf';
    $('#thumbPdf').hidden = !isPdf; $('#thumbImg').hidden = isPdf;
    S.cur.url = URL.createObjectURL(file); if (!isPdf) $('#thumbImg').src = S.cur.url;
    show('confirm'); renderCandidates(); updatePreview();
    prepare(file).then(function (p) { S.cur.blob = p.blob; S.cur.mime = p.mime; return read(); })
      .catch(function (e) { setStatus2('ng', '写真を開けませんでした', errText(e)); });
  }
  $('#thumbBtn').addEventListener('click', function () { if (S.cur && S.cur.url) window.open(S.cur.url, '_blank'); });

  function setStatus2(kind, title, text) {
    $('#readStatus').innerHTML = '<b class="' + (kind === 'busy' ? 'busy' : '') + '">' + esc(title) + '</b><span>' + esc(text || '') + '</span>';
    $('#btnRetryRead').hidden = kind !== 'ng';
    $$('#fDate, #fAmount, #fVendor, #fPurpose').forEach(function (el) { el.classList.toggle('loading', kind === 'busy'); });
  }
  $('#btnRetryRead').addEventListener('click', function () { if (S.cur && S.cur.blob) read(); });

  async function read() {
    var seq = S.readSeq, b64 = await toBase64(S.cur.blob);
    for (var i = 0; i <= AUTO_RETRY_SEC.length; i++) {
      setStatus2('busy', '読み取り中…', 'ふつう5秒ほどで終わります。待たずに手で入れても構いません。');
      var r;
      try { r = await api('read', { file: b64, mimeType: S.cur.mime }); } catch (e) { r = { ok: false, error: errText(e) }; }
      if (seq !== S.readSeq) return;
      if (r.ok && r.result) { fillFromAi(r.result); return; }
      if (!BUSY_RE.test(r.error || '') || i === AUTO_RETRY_SEC.length) {
        setStatus2('ng', '読み取れませんでした', 'お手数ですが、写真を見ながら手で入れてください。（' + String(r.error || '').slice(0, 80) + '）');
        return;
      }
      for (var left = AUTO_RETRY_SEC[i]; left > 0; left--) {
        if (seq !== S.readSeq) return;
        setStatus2('busy', 'AIが混み合っています', left + '秒後に自動でやり直します。待たずに手で入れても構いません。');
        await sleep(1000);
      }
    }
  }
  function fillFromAi(x) {
    S.cur.ai = { date: x.date || '', amount: x.amount === '' ? '' : String(x.amount), vendor: x.vendor || '' };
    var set = function (k, v) { var el = $(F[k]); if (!el.value && v !== '' && v != null) el.value = v; };
    set('date', x.date); set('amount', x.amount === '' ? '' : yen(x.amount)); set('vendor', x.vendor); set('purpose', x.purposeHint); set('invoice', x.invoiceNumber);
    if (x.paymentMethod) $('#fPay').value = x.paymentMethod;
    var un = x.unreadable || [];
    $('#fDate').classList.toggle('check', !fv('date') || un.indexOf('date') >= 0);
    $('#fAmount').classList.toggle('check', !fv('amount') || un.indexOf('amount') >= 0);
    $('#fPurpose').classList.toggle('check', !fv('purpose'));
    checkVendor();
    var many = x.receiptCount > 1 ? '写真に' + x.receiptCount + '枚写っています。1枚ずつ撮り直すと確実です。' : '';
    setStatus2('ok', '読み取りました', (many || '黄色の欄はAIが自信のない項目です。写真と見比べてください。'));
    loadEvents(); onFormChange();
  }
  /** 法人格が無い社名は黄色にして、正式社名に直すよう促す */
  function checkVendor() {
    var v = fv('vendor'), bad = !v || !LEGAL_RE.test(v);
    $('#fVendor').classList.toggle('check', bad);
    $('#vendorHint').classList.toggle('warn', bad && !!v);
  }

  // 対象案件の候補：その日の予定（印を取り除く）＋過去の申請で使った案件名
  function loadEvents() {
    var d = fv('date'); if (!d) { S.cur.events = []; renderCandidates(); return; }
    if (DEMO) { S.cur.events = ['【確定】愛知県　豊田市　中学校プログラム', '社内定例']; renderCandidates(); return; }
    var d0 = new Date(d + 'T00:00:00'), d1 = new Date(d0.getTime() + 864e5);
    gfetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=20&timeMin=' + encodeURIComponent(d0.toISOString()) + '&timeMax=' + encodeURIComponent(d1.toISOString()))
      .then(function (j) { S.cur.events = (j.items || []).map(function (e) { return e.summary; }).filter(Boolean); renderCandidates(); })
      .catch(function () { S.cur.events = []; renderCandidates(); });
  }
  function renderCandidates() {
    var seen = {}, list = [];
    var add = function (s) { s = cleanTitle(s); if (s && !seen[s]) { seen[s] = 1; list.push(s); } };
    (S.cur && S.cur.events || []).forEach(add);
    S.rows.slice().sort(function (a, b) { return String(b.cells[C.at]).localeCompare(String(a.cells[C.at])); }).forEach(function (r) { add(r.cells[C.project]); });
    list = list.slice(0, 6);
    var d = fv('date'), p = d ? parts(d) : null;
    $('#candNote').textContent = list.length ? (p ? p.m + '月' + p.d + '日の予定と、過去の申請から' : '過去の申請から') : '';
    var box = $('#candList'); box.innerHTML = '';
    list.forEach(function (s) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = s; b.title = s;
      b.setAttribute('aria-pressed', String(fv('project') === s));
      b.addEventListener('click', function () { $('#fProject').value = s; onFormChange(); });
      box.appendChild(b);
    });
  }

  function claimText(f) {
    var p = parts(f.date);
    return ['▶︎立替日：' + p.y + '年' + p.m + '月' + p.d + '日', '▶︎対象案件：' + f.project, '▶︎利用会社：' + f.vendor, '▶︎用途：' + f.purpose, '`金額：' + yen(f.amount) + '円`'].join('\n');
  }
  function claimHtml(text) { return String(text).split('\n').map(function (l) { var m = l.match(/^`(.*)`$/); return m ? '<code>' + esc(m[1]) + '</code>' : esc(l); }).join('\n'); }
  function ext() { return S.cur && S.cur.mime === 'application/pdf' ? '.pdf' : '.jpg'; }
  function fileName(f) { return parts(f.date).ymd + '_' + safeName(f.project) + '_' + f.amount + '円' + ext(); }
  function ready(f) { return /^\d{4}-\d{2}-\d{2}$/.test(f.date) && f.amount > 0 && f.vendor && f.purpose && f.project; }
  function updatePreview() {
    var f = form(), ok = ready(f);
    $('#pvName').textContent = ok ? fileName(f) : '—';
    if (f.date && f.project) { var p = parts(f.date); $('#pvPath').textContent = (S.settings.folder ? S.settings.folder.name + ' › ' : '') + p.y + '年' + p.m + '月稼働 › 経費領収書：' + p.m + '/' + p.d + '_' + f.project; }
    else $('#pvPath').textContent = '—';
    var missing = [['date', '立替日'], ['amount', '金額'], ['vendor', '利用会社'], ['purpose', '用途'], ['project', '対象案件']].filter(function (k) { return !f[k[0]]; }).map(function (k) { return k[1]; });
    $('#saveNote').textContent = missing.length ? missing.join('・') + 'を入れると保存できます' : (S.settings.folder ? '' : '保存するときに保存先フォルダを選びます');
    $('#btnSave').disabled = !ok || !S.cur || !S.cur.blob || S.cur.saving;
  }
  function duplicates(f) { return S.rows.filter(function (r) { return r.cells[C.date] === f.date && num(r.cells[C.amount]) === f.amount; }); }
  function onFormChange() {
    var f = form(), d = f.date && f.amount ? duplicates(f) : [];
    if (d.length) {
      $('#dupWarn').innerHTML = '<b>同じ立替日・金額の申請が、台帳に既にあります</b><br>' + d.map(function (r) { return esc(r.cells[C.date] + '／' + r.cells[C.vendor] + '／' + yen(num(r.cells[C.amount])) + '円（' + r.cells[C.status] + '）'); }).join('<br>') + '<br>同じ領収書を2回送っていないか確認してください。';
      $('#dupWarn').hidden = false;
    } else $('#dupWarn').hidden = true;
    $$('#candList .chip').forEach(function (b) { b.setAttribute('aria-pressed', String(b.textContent === f.project)); });
    updatePreview();
  }
  Object.keys(F).forEach(function (k) { $(F[k]).addEventListener('input', onFormChange); $(F[k]).addEventListener('change', onFormChange); });
  $('#fVendor').addEventListener('input', checkVendor);
  $('#fDate').addEventListener('change', loadEvents);
  $('#fAmount').addEventListener('blur', function () { var n = num(this.value); this.value = n ? yen(n) : ''; });
  ['#fDate', '#fAmount', '#fPurpose'].forEach(function (s) { $(s).addEventListener('input', function () { if (this.value) this.classList.remove('check'); }); });

  // ============================================================ 保存（ドライブ＋台帳）
  $('#btnSave').addEventListener('click', async function () {
    var f = form(); if (!ready(f) || !S.cur || S.cur.saving) return;
    if (duplicates(f).length && !confirm('同じ立替日・金額の申請が、台帳に既にあります。\n同じ領収書を2回送っていませんか？\n\n別の支払いなら「OK」、取りやめるなら「キャンセル」を押してください。')) return;
    if (!S.settings.folder) { toast('最初に保存先フォルダを選んでください'); await pickFolder(); if (!S.settings.folder) return; }
    S.cur.saving = true; updatePreview(); $('#saveNote').textContent = '保存しています…';
    try {
      await ensureToken();
      S.saved = DEMO ? demoSave(f) : await saveAll(f);
      S.cur.saved = true; openResult();
    } catch (e) { toast('保存できませんでした：' + errText(e), true); }
    S.cur.saving = false; updatePreview();
  });
  async function saveAll(f) {
    var p = parts(f.date), tab = p.y + '-' + pad(p.m);
    var month = await monthFolder(p.y, p.m);
    var rName = '経費領収書：' + p.m + '/' + p.d + '_' + f.project;
    var rList = await listChildren(month.id, "mimeType='application/vnd.google-apps.folder' and name='" + qName(rName) + "'");
    var rFolder = rList[0] || await createFolder(rName, month.id);
    var base = fileName(f), dot = base.lastIndexOf('.'), stem = base.slice(0, dot), name = base;
    var same = await listChildren(rFolder.id, "name contains '" + qName(stem) + "'");
    for (var n = 2; same.some(function (x) { return x.name === name; }); n++) name = stem + '_' + n + base.slice(dot);
    var up = await multipartUpload({ name: name, parents: [rFolder.id] }, S.cur.blob);
    var L = await findLedger(p.y, true);
    await ensureMonthSheet(L, tab);
    var cur = await gfetch(rangeUrl(L.id, "'" + tab + "'!A2:A"));
    var prefix = p.ymd + '-' + S.user.email.split('@')[0] + '-';
    var seq = (cur.values || []).filter(function (r) { return String(r[0] || '').indexOf(prefix) === 0; }).length + 1;
    var ai = S.cur.ai, edited = ai && (ai.date !== f.date || num(ai.amount) !== f.amount || ai.vendor !== f.vendor);
    var claim = claimText(f), id = prefix + pad(seq);
    var row = [id, stamp(), f.date, tab, f.project, f.vendor, f.purpose, f.invoice, f.amount, f.pay, !ai ? '手入力' : edited ? '一部手直し' : 'AIのまま', '未申請', '', claim, up.name, up.webViewLink, ''];
    await jsonPost(rangeUrl(L.id, "'" + tab + "'!A:Q") + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', { values: [row] });
    S.rows.push({ ssId: L.id, tab: tab, cells: row.map(String) });
    return { id: id, ssId: L.id, tab: tab, claim: claim, status: '未申請', fileName: up.name, fileUrl: up.webViewLink, path: S.settings.folder.name + ' › ' + month.name + ' › ' + rName, fresh: true };
  }

  // ============================================================ 3 保存完了・申請
  function openSaved(r) {
    var c = r.cells;
    S.saved = { id: c[C.id], ssId: r.ssId, tab: r.tab, claim: c[C.claim] || '', status: c[C.status] || '未申請', fileName: c[C.fileName] || '', fileUrl: c[C.fileUrl] || '', path: '', fresh: false };
    openResult();
  }
  function openResult() {
    var s = S.saved; show('result');
    $('#savedTitle').textContent = s.fresh ? '保存して、台帳に記録しました' : '登録した領収書';
    $('#savedName').textContent = s.fileName; $('#savedPath').textContent = s.path; $('#savedPath').hidden = !s.path;
    $('#linkFile').href = s.fileUrl || '#'; $('#linkFile').hidden = !s.fileUrl;
    $('#linkLedger').href = ledgerUrl(s.ssId);
    $('#claimBox').innerHTML = claimHtml(s.claim);
    renderStep(s.status === '申請済み' ? 'done' : 'copy');
  }
  function renderStep(step) {
    S.saved.step = step;
    $('#stepCopy').hidden = step !== 'copy'; $('#stepMark').hidden = step !== 'mark'; $('#stepDone').hidden = step !== 'done';
    var done = step === 'done'; $('#statusPill').textContent = done ? '申請済み' : '未申請'; $('#statusPill').className = 'pill ' + (done ? 'done' : 'wait');
  }
  /** 書式つき（金額行を枠に）と文字のみの2種類をクリップボードに入れる。Slackは書式つきを受け取る */
  function copyClaim(text) {
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      var html = claimHtml(text).split('\n').join('<br>');
      return navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })])
        .catch(function () { return copyPlain(text); });
    }
    return copyPlain(text);
  }
  function copyPlain(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
    fallbackCopy(text); return Promise.resolve();
  }
  function fallbackCopy(text) { var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e) {} document.body.removeChild(ta); }
  $$('[data-action="copy-open"]').forEach(function (b) {
    b.addEventListener('click', function () {
      // コピーとSlackを開くのを、同じボタン操作の中で行う（iPhoneはボタン操作の外だと開けないため）
      copyClaim(S.saved.claim).then(function () { toast('申請文をコピーしました'); });
      window.open(SLACK_URL, '_blank', 'noopener');
      renderStep('mark');
    });
  });
  $$('[data-action="mark"], [data-action="undo"]').forEach(function (b) {
    b.addEventListener('click', function () {
      var to = b.dataset.action === 'mark' ? '申請済み' : '未申請', s = S.saved; b.disabled = true;
      (DEMO ? Promise.resolve() : ensureToken().then(function () { return setStatus(s.ssId, s.tab, s.id, to); })).then(function () {
        s.status = to;
        S.rows.forEach(function (r) { if (r.cells[C.id] === s.id) { r.cells[C.status] = to; r.cells[C.claimedOn] = to === '申請済み' ? isoDate(new Date()) : ''; } });
        renderStep(to === '申請済み' ? 'done' : 'mark');
        toast(to === '申請済み' ? '台帳を「申請済み」にしました' : '「未申請」に戻しました');
      }).catch(function (e) { toast('台帳を書き換えられませんでした：' + errText(e), true); }).then(function () { b.disabled = false; });
    });
  });
  $$('[data-action="later"]').forEach(function (b) { b.addEventListener('click', function () { toast('台帳に「未申請」で残しました。ホームの件数から確かめられます'); goHome(); }); });

  // ============================================================ 見本モード（?demo=1）
  function demoRows() {
    var mk = function (id, at, date, project, vendor, purpose, amount, status) {
      var f = { date: date, project: project, vendor: vendor, purpose: purpose, amount: amount };
      return { ssId: 'demo', tab: date.slice(0, 7), cells: [id, at, date, date.slice(0, 7), project, vendor, purpose, '', String(amount), '', 'AIのまま', status, '', claimText(f), parts(date).ymd + '_' + project + '_' + amount + '円.jpg', '', ''] };
    };
    return [
      mk('20261002-demo-01', '2026-10-02 18:10', '2026-10-02', '愛知県長久手市：小学校プログラム', '長久手市教育委員会', '会場利用料', 3160, '申請済み'),
      mk('20260926-demo-01', '2026-09-26 15:02', '2026-09-26', '愛知県豊田市：中学校プログラム', '株式会社ファミリーマート', '菓子購入', 1220, '未申請'),
      mk('20260925-demo-01', '2026-09-25 09:40', '2026-09-25', '愛知県豊田市：中学校プログラム', '東海旅客鉄道株式会社', '乗車券購入', 10440, '未申請')
    ];
  }
  function demoApi(action) {
    if (action === 'login') return Promise.resolve({ ok: true, email: 'demo.user@replayce.co.jp', session: 'demo' });
    if (action === 'read') return sleep(1500).then(function () { return { ok: true, result: { receiptCount: 1, docType: 'レシート', date: '2026-09-26', vendor: 'ファミリーマート', amount: 1220, paymentMethod: 'QR決済', invoiceNumber: 'T5180302016192', purposeHint: '菓子購入', unreadable: [] } }; });
    return Promise.resolve({ ok: false, error: '見本モード' });
  }
  function demoSave(f) {
    var p = parts(f.date), id = p.ymd + '-demo-0' + (S.rows.length + 1), claim = claimText(f);
    S.rows.push({ ssId: 'demo', tab: p.y + '-' + pad(p.m), cells: [id, stamp(), f.date, '', f.project, f.vendor, f.purpose, f.invoice, String(f.amount), f.pay, 'AIのまま', '未申請', '', claim, fileName(f), '', ''] });
    return { id: id, ssId: 'demo', tab: '', claim: claim, status: '未申請', fileName: fileName(f), fileUrl: '', path: '稼働（見本） › ' + p.y + '年' + p.m + '月稼働 › 経費領収書：' + p.m + '/' + p.d + '_' + f.project, fresh: true };
  }
  if (DEMO) {
    gfetch = function (url) { return url.indexOf('userinfo') >= 0 ? Promise.resolve({ name: '見本 太郎' }) : Promise.resolve({}); };
    setTimeout(function () { $('#btnLogin').click(); }, 50);
  }
})();
