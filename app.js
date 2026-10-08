/**
 * 領収書アプリ v1.1.0（Step 2〜4：まとめて申請・マイページ・使い方・不具合の送信・試行の感想）
 * v1.0.0（Step 1：撮る → 読み取り・確認 → 保存・台帳 → その場で申請）
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
  var VERSION = '1.2.7';
  var DEFAULT_SETTINGS = { folder: null, split: 'standard', favorites: [] };
  var SCOPES = 'openid email profile https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/calendar.readonly';
  var DRIVE = 'https://www.googleapis.com/drive/v3', UPLOAD = 'https://www.googleapis.com/upload/drive/v3', SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets/';
  var ALL = 'supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives';
  var BUSY_RE = /high demand|overloaded|UNAVAILABLE|RESOURCE_EXHAUSTED|quota|→429|→503|HTTP 429|HTTP 503/i;
  var AUTO_RETRY_SEC = [];     // 混雑時の自動やり直しはしない（待つかどうかは本人が「もう一度読み取る」で選ぶ）
  var READ_TIMEOUT_SEC = 40;   // 読み取りは画面側で必ず40秒で打ち切る（裏側でAIの返事が止まっても待ち続けない）
  var PREFIX = CFG.ledgerPrefix || '立替金精算台帳_';
  var SLACK_URL = CFG.slackChannelUrl || 'https://replayce.slack.com/archives/C08J736MX5H';
  var HEADER = ['申請ID', '登録日時', '立替日', '対象月', '対象案件', '利用会社', '用途', 'インボイス登録番号', '金額（税込・円）', '支払方法', '読取ステータス', '申請状態', '申請日', '申請文', '領収書ファイル名', '領収書のリンク', '備考'];
  var C = { id: 0, at: 1, date: 2, month: 3, project: 4, vendor: 5, purpose: 6, invoice: 7, amount: 8, pay: 9, readStatus: 10, status: 11, claimedOn: 12, claim: 13, fileName: 14, fileUrl: 15, note: 16 };
  var LEGAL_RE = /(株式会社|有限会社|合同会社|合資会社|合名会社|社団法人|財団法人|学校法人|医療法人|社会福祉法人|特定非営利活動法人|NPO法人|独立行政法人|国立大学法人|（株）|\(株\)|㈱|市|区|町|村|県|都|府|道|庁|委員会|協会|組合|大学|病院|SS）|SS\))/;

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var S = { user: null, google: { token: '', exp: 0 }, session: '', settings: Object.assign({}, DEFAULT_SETTINGS), settingsFileId: null, rows: [], ledgers: {}, cur: null, saved: null, screen: 'login', readSeq: 0 };
  var lastErrors = [];
  function noteError(where, e) { lastErrors.push({ t: new Date().toISOString(), where: where, msg: String(errText(e)).slice(0, 300) }); if (lastErrors.length > 8) lastErrors.shift(); }
  window.addEventListener('error', function (e) { noteError('画面', e.message); });
  window.addEventListener('unhandledrejection', function (e) { noteError('処理', e.reason); });

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
    if (ng) noteError(S.screen, msg);
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
      else if (canLeave()) go(to);
    });
  });
  function go(to) {
    if (to === 'batch') openBatch(); else if (to === 'mypage') openMy(); else if (to === 'help') show('help'); else goHome();
  }
  $('#brandHome').addEventListener('click', function (e) { e.preventDefault(); if (canLeave()) goHome(); });
  $('#verLabel').textContent = 'v' + VERSION; $('#verLabel2').textContent = 'v' + VERSION;
  function canLeave() {
    var inMulti = S.screen === 'multi' || (S.screen === 'confirm' && S.multiEdit);
    if (inMulti) {
      if (S.multiEdit) storeMultiItem();
      if (M.saving) { toast('保存が終わるまでお待ちください'); return false; }
      if (multiUnsaved().length && !confirm('まとめて読み取った領収書に、まだ保存していないものがあります。破棄して移動しますか？')) return false;
      endMulti(); $('#btnMultiBack').hidden = true; S.cur = null;
      return true;
    }
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
  // Android は、Googleのログインを別の窓（ポップアップ）で開くと真っ黒のまま止まることがある（2026-10-06 実機）。
  // そこで Android（と、ログイン画面の予備リンクを押した人）は、画面ごとGoogleに移って戻ってくる方式にする。
  // 戻り先は Google Cloud のログイン用クライアントの「承認済みのリダイレクトURI」に登録した住所と完全に一致させる。
  var ANDROID = /Android/i.test(navigator.userAgent);
  var REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, '');
  function useRedirect() { if (ANDROID) return true; try { return localStorage.getItem('receipt_login_redirect') === '1'; } catch (e) { return false; } }
  function redirectLogin(prompt) {
    var st = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { sessionStorage.setItem('receipt_oauth_state', st); } catch (e) {}
    var q = { client_id: CFG.clientId, redirect_uri: REDIRECT_URI, response_type: 'token', scope: SCOPES, include_granted_scopes: 'true', hd: CFG.allowedDomain, state: st };
    if (prompt) q.prompt = prompt;
    location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams(q).toString());
    return new Promise(function () {});   // 画面ごと移るので、ここには戻らない
  }
  /** ボタン操作の中でだけ呼ぶ（Googleのログイン画面はユーザー操作がないと開けない） */
  function requestToken(prompt) {
    if (DEMO) { S.google.token = 'demo'; S.google.exp = Date.now() + 3600e3; return Promise.resolve('demo'); }
    if (useRedirect()) {
      if (S.user && !confirm('Googleのログインの期限が切れました。Googleの画面に移ってログインし直します（入力中の内容は消えます）。よろしいですか？')) return Promise.reject(new Error('ログインし直しを取りやめました'));
      return redirectLogin(prompt);
    }
    return new Promise(function (resolve, reject) { pendingToken = { resolve: resolve, reject: reject }; getTokenClient().requestAccessToken({ prompt: prompt || '' }); });
  }
  function tokenValid() { return S.google.token && Date.now() < S.google.exp - 60000; }
  function ensureToken() { return tokenValid() ? Promise.resolve() : requestToken(); }

  $('#btnLogin').addEventListener('click', function () {
    var box = $('#loginError'); box.hidden = true;
    if (!DEMO && (!CFG.clientId || /ここに/.test(CFG.clientId) || !CFG.apiUrl || /ここに/.test(CFG.apiUrl))) {
      box.textContent = '設定（config.js）が未記入です。管理者に連絡してください。'; box.hidden = false; return;
    }
    var btn = this; btn.disabled = true;
    requestToken().then(finishLogin).catch(function (e) { box.textContent = errText(e); box.hidden = false; }).then(function () { btn.disabled = false; });
  });
  // 予備：ログイン画面が真っ黒・開かないときは、画面ごと移る方式に切り替える（この端末で覚えておく）
  $('#btnLoginRedirect').addEventListener('click', function (e) {
    e.preventDefault();
    if (!DEMO && (!CFG.clientId || /ここに/.test(CFG.clientId))) return;
    try { localStorage.setItem('receipt_login_redirect', '1'); } catch (err) {}
    if (DEMO) { $('#btnLogin').click(); return; }
    redirectLogin();
  });
  /** Googleのアクセストークンを受け取ったあとの共通の流れ（裏側で社内アカウントか確かめ → 設定を読む → ホームへ） */
  function finishLogin(tok) {
    return api('login', { accessToken: tok }).then(function (r) {
      if (!r.ok) throw new Error(r.error || 'ログインの確認に失敗しました');
      S.session = r.session; S.user = { email: r.email, name: r.email.split('@')[0] };
      return gfetch('https://www.googleapis.com/oauth2/v3/userinfo').then(function (u) { if (u && (u.name || u.given_name)) S.user.name = u.name || u.given_name; }).catch(function () {});
    }).then(loadSettings).then(function () {
      $('#menuName').textContent = S.user.name; $('#menuEmail').textContent = S.user.email; $('#menuInitial').textContent = S.user.name.slice(0, 1);
      goHome();
      if (PICK_MODE) {   // ホーム画面アプリから「Safariで開く」で来たとき：マイページの「選び直す」へ案内する
        try { history.replaceState(null, '', location.pathname + (DEMO ? '?demo=1' : '')); } catch (e) {}
        openMy(); toast('「選び直す」を押して、保存先のフォルダを選んでください');
      }
    });
  }
  // 画面ごと移る方式で、Googleから戻ってきたとき（住所の # の後ろにトークンが付いて戻る）
  (function () {
    var h = location.hash || '';
    if (!/(^|[#&])(access_token|error)=/.test(h)) return;
    var p = new URLSearchParams(h.replace(/^#/, ''));
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    var saved = null; try { saved = sessionStorage.getItem('receipt_oauth_state'); sessionStorage.removeItem('receipt_oauth_state'); } catch (e) {}
    var box = $('#loginError'), fail = function (msg) { box.textContent = msg; box.hidden = false; };
    if (p.get('error')) { fail('ログインできませんでした（' + p.get('error') + '）'); return; }
    if (saved && p.get('state') !== saved) { fail('ログインの確認に失敗しました。もう一度「Googleでログイン」を押してください'); return; }
    S.google.token = p.get('access_token') || ''; S.google.exp = Date.now() + (Number(p.get('expires_in')) || 3600) * 1000;
    if (!S.google.token) return;
    $('#btnLogin').disabled = true;
    setTimeout(function () {
      finishLogin(S.google.token).catch(function (e) { fail(errText(e)); }).then(function () { $('#btnLogin').disabled = false; });
    }, 0);
  })();
  function logout() {
    if (!canLeave()) return;
    if (window.google && google.accounts && google.accounts.oauth2 && S.google.token && !DEMO) { try { google.accounts.oauth2.revoke(S.google.token, function () {}); } catch (e) {} }
    S.google = { token: '', exp: 0 }; S.session = ''; S.user = null; S.settings = Object.assign({}, DEFAULT_SETTINGS); S.settingsFileId = null; S.rows = []; S.ledgers = {}; S.cur = null; S.saved = null; S.homeMonth = null; S.pastRows = {};
    show('login');
  }

  // ============================================================ 裏側API（GAS）・Google API
  /** 通信そのものの失敗（Failed to fetch／返事が読めない）は、3秒あけて1回だけやり直す */
  function api(action, payload, retried) {
    if (DEMO) return demoApi(action, payload);
    var t0 = Date.now(), ctl = null, timer = null, timedOut = false;
    if (action === 'read' && window.AbortController) {
      ctl = new AbortController();
      timer = setTimeout(function () { timedOut = true; ctl.abort(); }, READ_TIMEOUT_SEC * 1000);
    }
    return fetch(CFG.apiUrl, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow', signal: ctl ? ctl.signal : undefined,
      body: JSON.stringify(Object.assign({ action: action, session: S.session }, payload || {}))
    }).then(function (res) { return res.text(); }).then(function (t) {
      clearTimeout(timer);
      var j; try { j = JSON.parse(t); } catch (e) {
        // 何が返ってきたかを添える（例：Googleのエラーページの題名）。次に起きたときの手がかりにする
        var m = String(t).match(/<title>([^<]{1,60})<\/title>/i), what = m ? m[1] : String(t).replace(/\s+/g, ' ').slice(0, 40);
        throw new Error('裏側APIの返事を読めませんでした（' + (what || '空の返事') + '）');
      }
      j.ms = Date.now() - t0;
      if (j.code === 401 && action !== 'login') throw new Error('ログインの期限が切れました。メニューからログアウトして、もう一度ログインしてください');
      return j;
    }).catch(function (e) {
      clearTimeout(timer);
      if (timedOut) throw new Error(READ_TIMEOUT_SEC + '秒たってもAIから返事がないので止めました。「もう一度読み取る」で再挑戦できます');
      if (retried || /ログインの期限/.test(errText(e))) throw e;   // ログインの確認も含めて、1回だけやり直す
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
    if (DEMO) { S.settings = Object.assign({}, DEFAULT_SETTINGS, { folder: { id: 'demo', name: '稼働（見本）' }, favorites: ['横須賀市：定例会'] }); return Promise.resolve(); }
    return gfetch(DRIVE + '/files?spaces=appDataFolder&fields=files(id)&q=' + encodeURIComponent("name='receipt-settings.json'")).then(function (j) {
      var f = (j.files || [])[0]; if (!f) return;
      S.settingsFileId = f.id;
      return gfetch(DRIVE + '/files/' + f.id + '?alt=media').then(function (s) { if (s) S.settings = Object.assign({}, DEFAULT_SETTINGS, s); });
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
  // iPhoneのホーム画面アプリでは、はめ込みのGoogle画面がログイン情報（クッキー）を使えず、フォルダ選択が開けない。
  // そこでフォルダ選択だけSafariで行い、選んだ結果（ドライブの設定ファイル）をアプリに読み直す。
  var IOS_APP = (/iPhone|iPad|iPod/.test(navigator.userAgent) && navigator.standalone === true) || /[?&]iosapp=1\b/.test(location.search);
  // Safari（iPhone・Mac）は、ポップアップのGoogle画面を本人が操作した直後だけ、はめ込みのGoogle画面にもログイン情報を渡す。
  // そこでフォルダ選択の直前に、アカウント選択画面を出して1回タップしてもらう。
  var UA = navigator.userAgent;
  var NEEDS_TAP = /iPhone|iPad|iPod/.test(UA) || (/Safari\//.test(UA) && !/Chrome|Chromium|CriOS|Edg|Firefox|FxiOS/.test(UA)) || IOS_APP;
  var PICK_MODE = /[?&]pick=1\b/.test(location.search);
  function pickUrl() { return location.origin + location.pathname + '?pick=1'; }
  function openPickDlg() {
    closeMenu(); var d = $('#pickDlg');
    $('#pickStep1').hidden = false; $('#pickStep2').hidden = true; $('#pickStep3').hidden = true;
    $('#pickSafari').href = 'x-safari-' + pickUrl(); $('#pickSafari').hidden = !IOS_APP; $('#pickCopy').hidden = !IOS_APP; $('#pickAppNote').hidden = !IOS_APP;
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
  }
  function showPickDone(name) {
    var d = $('#pickDlg');
    $('#pickStep1').hidden = true; $('#pickStep2').hidden = true; $('#pickStep3').hidden = false;
    $('#pickDoneName').textContent = name;
    if (d.showModal) { if (!d.open) d.showModal(); } else d.setAttribute('open', '');
    if (S.screen === 'home') goHome(); else if (S.screen === 'mypage') openMy();
  }
  function closePickDlg() { var d = $('#pickDlg'); if (d.close) d.close(); else d.removeAttribute('open'); }
  /** Safariで選んだ保存先を読み直して画面に反映する */
  function reloadFolder(fromButton) {
    var before = S.settings.folder && S.settings.folder.id;
    var go = fromButton ? ensureToken() : (tokenValid() ? Promise.resolve() : Promise.reject(new Error('skip')));
    return go.then(loadSettings).then(function () {
      var f = S.settings.folder;
      if (f && f.id !== before) {
        S.ledgers = {}; closePickDlg(); toast('保存先を「' + f.name + '」にしました');
        if (S.screen === 'mypage') openMy(); else if (S.screen === 'home') goHome(); else updatePreview();
      } else if (fromButton) toast('まだ変わっていません。Safariでフォルダを選び終えてから押してください', true);
    }).catch(function (e) { if (fromButton) toast(errText(e), true); });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && IOS_APP && S.user && !$('#pickStep2').hidden) reloadFolder(false);
  });
  $('#pickSafari').addEventListener('click', function () { $('#pickStep1').hidden = true; $('#pickStep2').hidden = false; });
  $('#pickCopy').addEventListener('click', function () {
    var u = pickUrl();
    (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(u) : Promise.reject()).catch(function () { fallbackCopy(u); })
      .then(function () { toast('住所をコピーしました。Safariに貼り付けて開いてください'); $('#pickStep1').hidden = true; $('#pickStep2').hidden = false; });
  });
  $('#pickReload').addEventListener('click', function () { reloadFolder(true); });
  $('#pickTryHere').addEventListener('click', function () { closePickDlg(); pickFolder(); });
  $$('[data-action="pick-close"]').forEach(function (b) { b.addEventListener('click', closePickDlg); });

  /**
   * 保存先フォルダをマイドライブに新しく作って、そのまま設定する（初めての人向け。Googleのフォルダ選択画面を使わない）。
   * 同じ名前のフォルダをこのアプリで作ってあれば、それを使う（二重に作らない）。
   */
  function makeFolder() {
    var name = window.prompt('マイドライブに作るフォルダの名前です。そのままでよければ「OK」を押してください。', '立替精算（領収書）');
    if (name === null) return Promise.resolve(false);
    name = safeName(name) || '立替精算（領収書）';
    if (DEMO) { S.settings.folder = { id: 'demo', name: name }; toast('マイドライブに「' + name + '」を作って、保存先にしました'); if (S.screen === 'mypage') openMy(); else if (S.screen === 'home') goHome(); return Promise.resolve(true); }
    return ensureToken().then(function () {
      return listChildren('root', "mimeType='application/vnd.google-apps.folder' and name='" + qName(name) + "'");
    }).then(function (list) { return list[0] || createFolder(name, 'root'); }).then(function (f) {
      S.settings.folder = { id: f.id, name: f.name, driveId: '' }; S.ledgers = {};
      return saveSettings().then(function () {
        toast('マイドライブに「' + f.name + '」を用意して、保存先にしました');
        if (S.screen === 'home') goHome(); else if (S.screen === 'mypage') openMy(); else updatePreview();
        return true;
      });
    }).catch(function (e) { toast('フォルダを作れませんでした：' + errText(e), true); return false; });
  }
  /** 保存しようとしたのに保存先が無いとき：新しく作るか、今あるフォルダを選ぶか */
  function chooseFolder() {
    if (window.confirm('保存先のフォルダがまだ決まっていません。\n\nマイドライブに新しく作るなら「OK」\n今あるフォルダを選ぶなら「キャンセル」を押してください。')) return makeFolder();
    return pickFolder();
  }
  function pickFolder() {
    if (DEMO) { S.settings.folder = { id: 'demo', name: '稼働（見本）' }; toast('保存先を「稼働（見本）」にしました'); if (S.screen === 'mypage') openMy(); else goHome(); return Promise.resolve(); }
    if (!CFG.pickerApiKey || /ここに/.test(CFG.pickerApiKey)) { toast('フォルダ選択の設定（config.js の pickerApiKey）が未記入です。管理者に連絡してください', true); return Promise.resolve(); }
    // ボタンを押した流れの中で、すぐにアカウント選択画面を開く（後回しにするとポップアップが止められる）
    var ready = NEEDS_TAP ? requestToken('select_account') : ensureToken();
    if (NEEDS_TAP) toast('準備のため、Googleのアカウントを1回タップしてください');
    return ready.then(loadPicker).then(function () {
      return new Promise(function (resolve) {
        var P = google.picker;
        var mine = new P.DocsView(P.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes('application/vnd.google-apps.folder');
        var shared = new P.DocsView(P.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes('application/vnd.google-apps.folder').setEnableDrives(true);
        var b = new P.PickerBuilder().setTitle('保存先のフォルダを選んでください（月のフォルダはこの中に自動で作られます）').addView(mine).addView(shared)
          .setOAuthToken(S.google.token).setDeveloperKey(CFG.pickerApiKey).setAppId(String(CFG.clientId).split('-')[0]).setLocale('ja')
          .setCallback(function (data) {
            var act = data[P.Response.ACTION];
            // エラー画面（「キーが無効」など）を閉じたときも CANCEL になるので、選べなかったときの案内を出す
            if (act === P.Action.CANCEL) { if (NEEDS_TAP) openPickDlg(); resolve(); return; }
            if (act !== P.Action.PICKED) return;
            var id = data[P.Response.DOCUMENTS][0][P.Document.ID];
            gfetch(DRIVE + '/files/' + id + '?supportsAllDrives=true&fields=id,name,driveId,capabilities(canAddChildren)').then(function (f) {
              if (f.capabilities && f.capabilities.canAddChildren === false) { toast('このフォルダには保存する権限がありません。別のフォルダを選んでください', true); return; }
              S.settings.folder = { id: f.id, name: f.name, driveId: f.driveId || '' }; S.ledgers = {};
              return saveSettings().then(function () {
                if (PICK_MODE) { showPickDone(f.name); return; }
                toast('保存先を「' + f.name + '」にしました'); if (S.screen === 'home') goHome(); else if (S.screen === 'mypage') openMy(); else updatePreview(); });
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
    if (DEMO) { S.rows = S.demoRows || (S.demoRows = demoRows()); return Promise.resolve(); }
    if (!S.settings.folder) { S.rows = []; return Promise.resolve(); }
    var now = new Date(), years = [now.getFullYear()]; if (now.getMonth() === 0) years.push(now.getFullYear() - 1);
    S.pastRows = {};
    return Promise.all(years.map(loadYearRows)).then(function (lists) { S.rows = [].concat.apply([], lists); });
  }
  /** 1年分の台帳を読む（台帳が無ければ空） */
  function loadYearRows(y) {
    var rows = [];
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
    }).then(function () { return rows; });
  }
  async function ensureMonthSheet(L, tab) {
    var meta = await gfetch(SHEETS + L.id + '?fields=sheets.properties(sheetId,title)');
    var sheets = (meta.sheets || []).map(function (s) { return s.properties; });
    var mine = sheets.filter(function (s) { return s.title === tab; })[0];
    if (mine) { await formatMonthSheet(L.id, mine.sheetId, tab); return mine.sheetId; }
    var rename = L.created && sheets.length === 1 && !/^\d{4}-\d{2}$/.test(sheets[0].title);
    var req = rename ? { updateSheetProperties: { properties: { sheetId: sheets[0].sheetId, title: tab, gridProperties: { frozenRowCount: 1 } }, fields: 'title,gridProperties.frozenRowCount' } }
      : { addSheet: { properties: { title: tab, gridProperties: { frozenRowCount: 1 } } } };
    var res = await jsonPost(SHEETS + L.id + ':batchUpdate', { requests: [req] });
    var sheetId = rename ? sheets[0].sheetId : res.replies[0].addSheet.properties.sheetId;
    await jsonPost(rangeUrl(L.id, "'" + tab + "'!A1") + '?valueInputOption=RAW', { values: [HEADER] }, 'PUT');
    await formatMonthSheet(L.id, sheetId, tab);
    return sheetId;
  }
  // 列の幅（A〜Q、ピクセル）
  var COL_PX = [170, 130, 90, 70, 220, 200, 120, 130, 110, 110, 100, 90, 90, 260, 260, 160, 160];
  /**
   * 月のシートの見た目を整える（このページを開いてから、シートごとに1回だけ）。
   * 見出し＝太字・薄い青／データ行＝通常の文字・背景なし・1行の高さ固定／申請状態（L列）＝プルダウン／金額＝3桁区切り。
   * 以前の版で崩れたシート（データ行が太字・青、プルダウンが無い、行が縦に伸びる）も、ここで直る。
   */
  async function formatMonthSheet(ssId, sheetId, tab) {
    S.formatted = S.formatted || {};
    var key = ssId + ':' + sheetId; if (S.formatted[key]) return;
    // 今の状態を見る：L2にプルダウンがあるか／申請状態の色分けが既にあるか（あれば足さない・上書きしない。手で変えた見た目を消さないため）
    var cur = await gfetch(SHEETS + ssId + '?ranges=' + encodeURIComponent("'" + tab + "'!L2") + '&fields=sheets(properties.sheetId,conditionalFormats,data.rowData.values.dataValidation)');
    var sh = (cur.sheets || []).filter(function (x) { return x.properties && x.properties.sheetId === sheetId; })[0] || {};
    var cell0 = ((((((sh.data || [])[0] || {}).rowData || [])[0] || {}).values) || [])[0] || {};
    var hasValidation = !!cell0.dataValidation;
    var hasColors = (sh.conditionalFormats || []).some(function (cf) {
      var c = cf.booleanRule && cf.booleanRule.condition;
      return c && c.type === 'TEXT_EQ' && (c.values || []).some(function (v) { return v.userEnteredValue === '未申請' || v.userEnteredValue === '申請済み'; });
    });
    var END = 1000, rng = function (r0, r1, c0, c1) { return { sheetId: sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 }; };
    var reqs = [
      { updateSheetProperties: { properties: { sheetId: sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
      { repeatCell: { range: rng(0, 1, 0, HEADER.length), cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.933, green: 0.949, blue: 0.98 }, verticalAlignment: 'MIDDLE', wrapStrategy: 'CLIP' } }, fields: 'userEnteredFormat(textFormat.bold,backgroundColor,verticalAlignment,wrapStrategy)' } },
      { repeatCell: { range: rng(1, END, 0, HEADER.length), cell: { userEnteredFormat: { textFormat: { bold: false }, backgroundColor: { red: 1, green: 1, blue: 1 }, verticalAlignment: 'MIDDLE', wrapStrategy: 'CLIP' } }, fields: 'userEnteredFormat(textFormat.bold,backgroundColor,verticalAlignment,wrapStrategy)' } },
      { repeatCell: { range: rng(1, END, C.amount, C.amount + 1), cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' } } }, fields: 'userEnteredFormat.numberFormat' } },
      { updateDimensionProperties: { range: { sheetId: sheetId, dimension: 'ROWS', startIndex: 0, endIndex: END }, properties: { pixelSize: 24 }, fields: 'pixelSize' } }
    ];
    if (!hasValidation) reqs.push({ setDataValidation: { range: rng(1, END, C.status, C.status + 1),
      rule: { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: '未申請' }, { userEnteredValue: '申請済み' }] }, strict: true, showCustomUi: true } } });
    // 申請状態の色分け（未申請＝薄い黄色、申請済み＝薄い緑）。チップ型の色はAPIで付けられないため、条件付き書式で色を付ける
    var color = function (text, bg, fg, i) {
      return { addConditionalFormatRule: { index: i, rule: { ranges: [rng(1, END, C.status, C.status + 1)],
        booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: text }] },
          format: { backgroundColor: bg, textFormat: { foregroundColor: fg, bold: true } } } } } };
    };
    if (!hasColors) {
      reqs.push(color('未申請', { red: 1, green: 0.953, blue: 0.839 }, { red: 0.478, green: 0.294, blue: 0 }, 0));
      reqs.push(color('申請済み', { red: 0.902, green: 0.957, blue: 0.918 }, { red: 0.075, green: 0.451, blue: 0.2 }, 1));
    }
    COL_PX.forEach(function (px, i) { reqs.push({ updateDimensionProperties: { range: { sheetId: sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize: px }, fields: 'pixelSize' } }); });
    await jsonPost(SHEETS + ssId + ':batchUpdate', { requests: reqs });
    S.formatted[key] = true;
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
    $('#btnToBatch').hidden = wait.length < 1;
    var old = wait.map(function (r) { return r.cells[C.date]; }).filter(Boolean).sort()[0];
    if (old) {
      var p = parts(old), days = Math.floor((new Date(isoDate(new Date())) - new Date(old)) / 864e5);
      $('#sumOld').textContent = 'いちばん古いものは' + p.m + '月' + p.d + '日（' + days + '日前）です。' + (days >= 7 ? '月末まで溜めずに出しましょう。' : '');
      $('#sumOld').hidden = false;
    } else $('#sumOld').hidden = true;
    renderMonth();
  }

  // ---- 月ごとの登録（「＜ ＞」で表示する月を切り替える。月は立替日で決める）
  function ymOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
  function shiftYm(m, k) { return ymOf(new Date(+m.slice(0, 4), +m.slice(5, 7) - 1 + k, 1)); }
  function rowYm(r) { var d = String(r.cells[C.date] || ''); return /^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : r.tab; }
  function monthBounds() {
    var now = ymOf(new Date()), latest = now;
    S.rows.forEach(function (r) { var m = rowYm(r); if (m > latest) latest = m; });
    // 戻れるのは去年の1月まで（それより前は台帳を開いて見る）
    return { min: (new Date().getFullYear() - 1) + '-01', max: latest };
  }
  function rowsOfMonth(m) {
    var y = +m.slice(0, 4), pool = S.rows.concat(S.pastRows && S.pastRows[y] || []), seen = {};
    return pool.filter(function (r) {
      if (rowYm(r) !== m || seen[r.cells[C.id]]) return false;
      return (seen[r.cells[C.id]] = true);
    }).sort(function (a, b) {
      return String(b.cells[C.date]).localeCompare(String(a.cells[C.date])) || String(b.cells[C.at]).localeCompare(String(a.cells[C.at]));
    });
  }
  function moveMonth(k) {
    var b = monthBounds(), m = shiftYm(S.homeMonth || ymOf(new Date()), k);
    if (m < b.min || m > b.max) return;
    S.homeMonth = m;
    var y = +m.slice(0, 4), loaded = S.rows.some(function (r) { return r.ssId !== 'demo' && +rowYm(r).slice(0, 4) === y; }) || y >= new Date().getFullYear();
    S.pastRows = S.pastRows || {};
    if (DEMO || loaded || S.pastRows[y] || !S.settings.folder) { renderMonth(); return; }
    // 去年の月に戻ったときだけ、去年の台帳をあとから読む
    $('#monthLabel').textContent = '読み込み中…';
    loadYearRows(y).then(function (rows) { S.pastRows[y] = rows; renderMonth(); })
      .catch(function (e) { S.pastRows[y] = []; toast(y + '年の台帳を読み込めませんでした：' + errText(e), true); renderMonth(); });
  }
  function renderMonth() {
    var b = monthBounds();
    if (!S.homeMonth || S.homeMonth > b.max || S.homeMonth < b.min) S.homeMonth = ymOf(new Date());
    var m = S.homeMonth, list = rowsOfMonth(m);
    $('#monthLabel').textContent = +m.slice(0, 4) + '年' + +m.slice(5, 7) + '月';
    $('#monthPrev').disabled = shiftYm(m, -1) < b.min;
    $('#monthNext').disabled = shiftYm(m, 1) > b.max;
    var sum = list.reduce(function (s, r) { return s + num(r.cells[C.amount]); }, 0);
    $('#monthSum').textContent = list.length ? list.length + '件・' + yen(sum) + '円' : '';
    var box = $('#recentList'); box.innerHTML = '';
    box.hidden = !list.length;
    $('#recentEmpty').hidden = !!list.length || !S.settings.folder;
    $('#recentEmpty').textContent = S.rows.length ? 'この月の登録はありません。' : 'まだ登録がありません。下のボタンから領収書を撮ってみましょう。';
    list.forEach(function (r) {
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
  $$('[data-action="make-folder"]').forEach(function (b) { b.addEventListener('click', function () { makeFolder(); }); });
  $$('[data-action="home"]').forEach(function (b) { b.addEventListener('click', function () { goHome(); }); });
  $('#monthPrev').addEventListener('click', function () { moveMonth(-1); });
  $('#monthNext').addEventListener('click', function () { moveMonth(1); });
  ['#fileShoot', '#filePick'].forEach(function (sel) { $(sel).addEventListener('change', function () { var f = this.files && this.files[0]; if (f) startConfirm(f, sel === '#fileShoot' ? '撮影' : '選択'); }); });

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

  function startConfirm(file, source) {
    S.readSeq++; S.multiEdit = false; $('[data-screen="confirm"]').classList.remove('multi-edit'); $('#btnMultiBack').hidden = true;
    if (S.cur && S.cur.url) URL.revokeObjectURL(S.cur.url);
    S.cur = { file: file, ai: null, saved: false, events: [], stats: { source: source || '', type: file.type === 'application/pdf' ? 'PDF' : '画像', readSec: '', retries: 0, model: '' } };
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
    var seq = S.readSeq, b64 = await toBase64(S.cur.blob), t0 = Date.now();
    for (var i = 0; i <= AUTO_RETRY_SEC.length; i++) {
      var tStart = Date.now(), msg = function () { setStatus2('busy', '読み取り中… ' + Math.round((Date.now() - tStart) / 1000) + '秒', 'ふつう5〜10秒で終わります（' + READ_TIMEOUT_SEC + '秒で打ち切ります）。待たずに手で入れても構いません。'); };
      msg(); var timer = setInterval(function () { if (seq === S.readSeq) msg(); }, 1000);
      var r;
      try { r = await api('read', { file: b64, mimeType: S.cur.mime }); } catch (e) { r = { ok: false, error: errText(e) }; }
      clearInterval(timer);
      if (seq !== S.readSeq) return;
      S.cur.stats.retries = i + ((r.tried && r.tried.length > 1) ? r.tried.length - 1 : 0);
      if (r.ok && r.result) { S.cur.stats.readSec = Math.round((Date.now() - t0) / 100) / 10; S.cur.stats.model = r.model || ''; fillFromAi(r.result); return; }
      noteError('読み取り', r.error || '');
      if (!BUSY_RE.test(r.error || '') || i === AUTO_RETRY_SEC.length) {
        setStatus2('ng', '読み取れませんでした', 'お手数ですが、写真を見ながら手で入れてください。（' + String(r.error || '').slice(0, 80) + '）');
        return;
      }
      for (var left = AUTO_RETRY_SEC[i]; left > 0; left--) {
        if (seq !== S.readSeq) return;
        setStatus2('busy', 'AIが混み合っています', left + '秒後にもう一度だけ読み取ります。待たずに手で入れても構いません。');
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
    (S.settings.favorites || []).forEach(add);
    S.rows.slice().sort(function (a, b) { return String(b.cells[C.at]).localeCompare(String(a.cells[C.at])); }).forEach(function (r) { add(r.cells[C.project]); });
    list = list.slice(0, 8);
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
    if (f.date && f.project) { var p = parts(f.date); $('#pvPath').textContent = (S.settings.folder ? S.settings.folder.name + ' › ' : '') + p.y + '年' + p.m + '月稼働' + (S.settings.split !== 'month' ? ' › 経費領収書：' + p.m + '/' + p.d + '_' + f.project : ''); }
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
    if (!S.settings.folder) { await chooseFolder(); if (!S.settings.folder) return; }
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
    var rName = '経費領収書：' + p.m + '/' + p.d + '_' + f.project, rFolder = month;
    if (S.settings.split !== 'month') {   // 標準：月の稼働フォルダの中に「経費領収書：日付_案件名」フォルダを作る
      var rList = await listChildren(month.id, "mimeType='application/vnd.google-apps.folder' and name='" + qName(rName) + "'");
      rFolder = rList[0] || await createFolder(rName, month.id);
    }
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
    await jsonPost(rangeUrl(L.id, "'" + tab + "'!A:Q") + ':append?valueInputOption=RAW&insertDataOption=OVERWRITE', { values: [row] });
    S.rows.push({ ssId: L.id, tab: tab, cells: row.map(String) }); S.homeMonth = f.date.slice(0, 7);
    return { id: id, ssId: L.id, tab: tab, claim: claim, status: '未申請', fileName: up.name, fileUrl: up.webViewLink, path: S.settings.folder.name + ' › ' + month.name + (S.settings.split !== 'month' ? ' › ' + rName : ''), fresh: true, readStatus: row[10] };
  }

  // ============================================================ 2b まとめて読み取り（5枚まで。読み取りは1枚ずつ順番に、保存はまとめて）
  var MULTI_MAX = 5;
  var M = { items: [], gen: 0, saving: false };
  function multiUnsaved() { return M.items.filter(function (it) { return it.status !== 'saved'; }); }
  function multiFlags(v, x) {
    var un = (x && x.unreadable) || [];
    return { date: !v.date || un.indexOf('date') >= 0, amount: !v.amount || un.indexOf('amount') >= 0, purpose: !v.purpose, vendor: !v.vendor || !LEGAL_RE.test(v.vendor) };
  }
  function multiNeedsCheck(it) { var f = it.flags || {}; return !!(f.date || f.amount || f.purpose || f.vendor) || it.receiptCount > 1; }
  function multiDup(it, idx) {
    var v = it.vals; if (!v.date || !v.amount) return false;
    return duplicates(v).some(function (r) { return !it.saved || r.cells[C.id] !== it.saved.id; }) ||
      M.items.slice(0, idx).some(function (o) { return o.vals.date === v.date && o.vals.amount === v.amount; });
  }
  function endMulti() {
    M.gen++; M.items.forEach(function (it) { if (it.url) URL.revokeObjectURL(it.url); });
    M.items = []; M.saving = false; S.multiEdit = false; $('[data-screen="confirm"]').classList.remove('multi-edit');
  }

  $$('[data-action="pick-multi"]').forEach(function (b) { b.addEventListener('click', function () { $('#fileMulti').value = ''; $('#fileMulti').click(); }); });
  $('#fileMulti').addEventListener('change', function () {
    var files = Array.prototype.slice.call(this.files || []); if (!files.length) return;
    if (files.length > MULTI_MAX) toast(MULTI_MAX + '枚までです。最初の' + MULTI_MAX + '枚を読み取ります', true);
    startMulti(files.slice(0, MULTI_MAX));
  });
  function startMulti(files) {
    endMulti();
    var gen = M.gen;
    M.items = files.map(function (file) {
      var isPdf = file.type === 'application/pdf';
      return { file: file, isPdf: isPdf, url: URL.createObjectURL(file), status: 'wait', wait: 0, error: '', ai: null, saved: null, receiptCount: 1,
        vals: { date: '', amount: 0, project: '', vendor: '', purpose: '', pay: '不明', invoice: '' }, flags: {},
        stats: { source: 'まとめて', type: isPdf ? 'PDF' : '画像', readSec: '', retries: 0, model: '' } };
    });
    $('#mProject').value = ''; renderMultiCands();
    show('multi'); renderMulti();
    (async function () { for (var i = 0; i < M.items.length; i++) { if (gen !== M.gen) return; await readItem(M.items[i], gen); } })();
  }
  async function readItem(it, gen) {
    it.status = 'reading'; renderMulti();
    try { var p = await prepare(it.file); it.blob = p.blob; it.mime = p.mime; }
    catch (e) { it.status = 'ng'; it.error = errText(e); renderMulti(); return; }
    var b64 = await toBase64(it.blob), t0 = Date.now();
    for (var i = 0; i <= AUTO_RETRY_SEC.length; i++) {
      var r, tStart = Date.now(); it.elapsed = 0;
      var timer = setInterval(function () { if (gen === M.gen) { it.elapsed = Math.round((Date.now() - tStart) / 1000); renderMulti(); } }, 1000);
      try { r = await api('read', { file: b64, mimeType: it.mime }); } catch (e) { r = { ok: false, error: errText(e) }; }
      clearInterval(timer); it.elapsed = 0;
      if (gen !== M.gen) return;
      it.stats.retries = i + ((r.tried && r.tried.length > 1) ? r.tried.length - 1 : 0);
      if (r.ok && r.result) { it.stats.readSec = Math.round((Date.now() - t0) / 100) / 10; it.stats.model = r.model || ''; applyAi(it, r.result); renderMulti(); return; }
      noteError('まとめて読み取り', r.error || '');
      if (!BUSY_RE.test(r.error || '') || i === AUTO_RETRY_SEC.length) { it.status = 'ng'; it.error = String(r.error || '').slice(0, 80); renderMulti(); return; }
      for (var left = AUTO_RETRY_SEC[i]; left > 0; left--) { if (gen !== M.gen) return; it.wait = left; renderMulti(); await sleep(1000); }
      it.wait = 0;
    }
  }
  function applyAi(it, x) {
    it.ai = { date: x.date || '', amount: x.amount === '' ? '' : String(x.amount), vendor: x.vendor || '' };
    var v = it.vals;
    if (!v.date) v.date = x.date || ''; if (!v.amount) v.amount = num(x.amount); if (!v.vendor) v.vendor = x.vendor || '';
    if (!v.purpose) v.purpose = x.purposeHint || ''; if (!v.invoice) v.invoice = x.invoiceNumber || '';
    if (x.paymentMethod) v.pay = x.paymentMethod;
    it.receiptCount = x.receiptCount || 1; it.flags = multiFlags(v, x); it.status = 'ok';
  }

  function renderMulti() {
    if (!M.items.length) return;
    var done = M.items.filter(function (it) { return it.status === 'ok' || it.status === 'ng' || it.status === 'saved'; }).length;
    var saved = M.items.filter(function (it) { return it.status === 'saved'; }).length;
    $('#mCount').textContent = done < M.items.length ? M.items.length + '枚中 ' + done + '枚 読み取り済み' : M.items.length + '枚';
    var box = $('#mList'); box.innerHTML = '';
    M.items.forEach(function (it, idx) {
      var v = it.vals, p = v.date ? parts(v.date) : null, busy = it.status === 'wait' || it.status === 'reading' || it.status === 'saving';
      var pills = [];
      if (it.status === 'wait') pills.push('<span class="pill busy">順番待ち</span>');
      else if (it.status === 'reading') pills.push('<span class="pill busy">' + (it.wait ? 'AIが混雑中・' + it.wait + '秒後に再試行' : '読み取り中…' + (it.elapsed ? ' ' + it.elapsed + '秒' : '')) + '</span>');
      else if (it.status === 'saving') pills.push('<span class="pill busy">保存中…</span>');
      else if (it.status === 'saved') pills.push('<span class="pill done">保存済み</span>');
      else {
        if (it.status === 'ng') pills.push('<span class="pill ng">読み取れず・手で入力</span>');
        else if (multiNeedsCheck(it)) pills.push('<span class="pill warn">' + (it.receiptCount > 1 ? '複数枚写っています' : '要確認') + '</span>');
        if (multiDup(it, idx)) pills.push('<span class="pill warn">重複の疑い</span>');
        if (it.saveError) pills.push('<span class="pill ng">保存できず</span>');
      }
      var b = document.createElement('button'); b.type = 'button'; b.className = 'row-item' + (busy ? ' busy' : '');
      b.innerHTML = '<span class="m-thumb">' + (it.isPdf ? 'PDF' : '<img alt="" src="' + it.url + '">') + '</span>' +
        '<span class="row-main"><b>' + (p ? p.m + '/' + p.d + '　' : '') + esc(v.vendor || (busy ? '' : '（利用会社 未入力）')) + '</b>' +
        '<span class="small' + (v.project ? '' : ' miss') + '">' + esc(v.project || (busy ? '' : '対象案件 未入力')) + '</span>' +
        '<span class="pills">' + pills.join('') + '</span></span>' +
        '<span class="row-amt">' + (v.amount ? yen(v.amount) + '円' : '') + '</span>';
      b.addEventListener('click', function () { openMultiItem(idx); });
      box.appendChild(b);
    });
    var left = multiUnsaved(), readyN = left.filter(function (it) { return it.status === 'ok' || it.status === 'ng'; }).filter(function (it) { return ready(it.vals); }).length;
    var reading = M.items.some(function (it) { return it.status === 'wait' || it.status === 'reading'; });
    var allSaved = !left.length;
    $('#mBulk').hidden = allSaved; $('#mLead').hidden = allSaved;
    $('#mDone').hidden = !saved; $('#mDoneTitle').textContent = saved + '枚を保存して、台帳に記録しました';
    $('#btnMSave').hidden = allSaved; $('#btnMToBatch').hidden = !allSaved;
    $('#btnMSave').disabled = M.saving || !readyN;
    $('#btnMSave').textContent = M.saving ? '保存しています…' : 'まとめて保存（' + readyN + '枚）';
    var notReady = left.filter(function (it) { return (it.status === 'ok' || it.status === 'ng') && !ready(it.vals); }).length;
    $('#mNote').textContent = allSaved ? '' : reading ? '読み取りが終わったものから確かめられます' :
      notReady ? notReady + '枚は入力が足りません（対象案件など）。タップして入れてください' : '';
    $('#btnMHome').textContent = allSaved ? 'ホームへ戻る' : 'やめてホームへ戻る';
  }

  // 対象案件をまとめて入れる
  function renderMultiCands() {
    var seen = {}, list = [];
    var add = function (s) { s = cleanTitle(s); if (s && !seen[s]) { seen[s] = 1; list.push(s); } };
    (S.settings.favorites || []).forEach(add);
    S.rows.slice().sort(function (a, b) { return String(b.cells[C.at]).localeCompare(String(a.cells[C.at])); }).forEach(function (r) { add(r.cells[C.project]); });
    var box = $('#mCands'); box.innerHTML = '';
    list.slice(0, 8).forEach(function (s) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = s; b.title = s;
      b.setAttribute('aria-pressed', String($('#mProject').value.trim() === s));
      b.addEventListener('click', function () { $('#mProject').value = s; renderMultiCands(); });
      box.appendChild(b);
    });
  }
  $('#mProject').addEventListener('input', function () { $$('#mCands .chip').forEach(function (b) { b.setAttribute('aria-pressed', String(b.textContent === $('#mProject').value.trim())); }); });
  $('#btnMApply').addEventListener('click', function () {
    var s = $('#mProject').value.trim(); if (!s) { toast('案件名を選ぶか入力してください', true); return; }
    var n = 0; multiUnsaved().forEach(function (it) { if (it.status !== 'saving') { it.vals.project = s; n++; } });
    renderMulti(); toast(n + '枚の対象案件を「' + s + '」にしました');
  });

  // 1枚を確認画面で直す（確認画面を使い回す。保存はせず、一覧に戻る）
  function openMultiItem(idx) {
    var it = M.items[idx]; if (!it) return;
    if (it.status === 'wait' || it.status === 'reading' || it.status === 'saving') { toast('読み取りが終わるまでお待ちください'); return; }
    if (it.status === 'saved') { toast('保存済みです。申請文は「まとめて申請」から作れます'); return; }
    S.readSeq++; S.cur = it; S.multiEdit = true; S.multiIdx = idx;
    $('[data-screen="confirm"]').classList.add('multi-edit');
    var v = it.vals;
    Object.keys(F).forEach(function (k) { var el = $(F[k]); el.value = k === 'amount' ? (v.amount ? yen(v.amount) : '') : (v[k] || ''); el.classList.remove('check'); });
    if (!v.pay) $('#fPay').value = '不明';
    var fl = it.flags || {};
    $('#fDate').classList.toggle('check', !!fl.date); $('#fAmount').classList.toggle('check', !!fl.amount); $('#fPurpose').classList.toggle('check', !!fl.purpose);
    $('#thumbPdf').hidden = !it.isPdf; $('#thumbImg').hidden = it.isPdf; if (!it.isPdf) $('#thumbImg').src = it.url;
    $('#btnMultiBack').hidden = false;
    show('confirm');
    if (it.status === 'ng') setStatus2('ng', '読み取れませんでした', 'お手数ですが、写真を見ながら手で入れてください。' + (it.error ? '（' + it.error + '）' : ''));
    else setStatus2('ok', (idx + 1) + '枚目', it.receiptCount > 1 ? '写真に' + it.receiptCount + '枚写っています。1枚ずつ読み取ると確実です。' : '黄色の欄はAIが自信のない項目です。写真と見比べてください。');
    checkVendor(); loadEvents(); onFormChange();
  }
  /** 確認画面の内容を、まとめて読み取りの1枚に書き戻す */
  function storeMultiItem() {
    var it = S.cur; if (!S.multiEdit || !it) return;
    it.vals = form();
    it.flags = { date: $('#fDate').classList.contains('check'), amount: $('#fAmount').classList.contains('check'), purpose: $('#fPurpose').classList.contains('check'), vendor: $('#fVendor').classList.contains('check') };
    if (it.ai && it.status === 'ng') it.status = 'ok';   // 確認画面で「もう一度読み取る」が成功した
    it.saveError = '';
  }
  $('#btnMultiBack').addEventListener('click', function () {
    storeMultiItem(); S.multiEdit = false; $('[data-screen="confirm"]').classList.remove('multi-edit'); $('#btnMultiBack').hidden = true;
    S.readSeq++; S.cur = null; show('multi'); renderMulti();
  });

  // まとめて保存（1枚ずつ順番にドライブ＋台帳へ）
  $('#btnMSave').addEventListener('click', async function () {
    if (M.saving) return;
    var todo = multiUnsaved().filter(function (it) { return (it.status === 'ok' || it.status === 'ng') && ready(it.vals); });
    if (!todo.length) return;
    var dups = todo.filter(function (it) { return multiDup(it, M.items.indexOf(it)); });
    if (dups.length && !confirm('同じ立替日・金額の申請が、台帳か今回の中に既にあるものが' + dups.length + '枚あります。\n同じ領収書を2回送っていませんか？\n\n別の支払いで、含めて保存するなら「OK」\nその' + dups.length + '枚を除いて保存するなら「キャンセル」')) {
      todo = todo.filter(function (it) { return dups.indexOf(it) < 0; });
      if (!todo.length) return;
    }
    if (!S.settings.folder) { await chooseFolder(); if (!S.settings.folder) return; }
    M.saving = true; renderMulti();
    var ok = 0, ng = 0, gen = M.gen;
    try { await ensureToken(); } catch (e) { M.saving = false; renderMulti(); toast(errText(e), true); return; }
    for (var i = 0; i < todo.length; i++) {
      var it = todo[i]; if (gen !== M.gen) return;
      it.status = 'saving'; renderMulti();
      try {
        S.cur = it;   // 保存の処理は S.cur の画像・形式を使う
        it.saved = DEMO ? demoSave(it.vals) : await saveAll(it.vals);
        it.status = 'saved'; it.saveError = ''; ok++;
      } catch (e) { it.status = 'ok'; it.saveError = errText(e); ng++; noteError('まとめて保存', e); }
      S.cur = null; renderMulti();
    }
    M.saving = false; renderMulti();
    if (ng) toast(ok + '枚を保存しました。' + ng + '枚は保存できませんでした（もう一度「まとめて保存」を押してください）', true);
    else toast(ok + '枚を保存して、台帳に記録しました');
    window.scrollTo(0, 0);
  });
  $('#btnMHome').addEventListener('click', function () { if (canLeave()) goHome(); });

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
    // 試行の感想欄は、いま保存した1件のときだけ出す（閉じた状態・空欄で）
    $('#fbCard').hidden = !s.fresh; $('#fbCard').open = false; $('#fbText').value = ''; $('#fbMin').value = ''; fbRating = 0; paintStars();
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

  // ============================================================ 共通のボタン（data-action）
  $$('[data-action="batch"]').forEach(function (b) { b.addEventListener('click', function () { openBatch(); }); });
  $$('[data-action="ledger"]').forEach(function (b) { b.addEventListener('click', openLedger); });
  $$('[data-action="help"]').forEach(function (b) { b.addEventListener('click', function () { show('help'); }); });
  $$('[data-action="report"]').forEach(function (b) { b.addEventListener('click', function () { openReport(); }); });
  $$('[data-action="logout"]').forEach(function (b) { b.addEventListener('click', logout); });

  // ============================================================ 4 まとめて申請
  var B = { list: [], off: {}, copied: false };
  function openBatch() {
    show('batch'); B.off = {}; B.copied = false; $('#bList').innerHTML = '<p class="note pad">読み込み中…</p>';
    loadRows().then(renderBatch).catch(function (e) { toast('台帳を読み込めませんでした：' + errText(e), true); renderBatch(); });
  }
  function renderBatch() {
    B.list = S.rows.filter(function (r) { return r.cells[C.status] === '未申請'; })
      .sort(function (a, b) { return String(a.cells[C.date]).localeCompare(String(b.cells[C.date])) || String(a.cells[C.at]).localeCompare(String(b.cells[C.at])); });
    var box = $('#bList'); box.innerHTML = '';
    $('#bEmpty').hidden = B.list.length > 0; box.hidden = !B.list.length; $('#bPreviewCard').hidden = !B.list.length;
    B.list.forEach(function (r) {
      var c = r.cells, p = parts(c[C.date] || ''), id = c[C.id];
      var lab = document.createElement('label'); lab.className = 'check-item';
      lab.innerHTML = '<input type="checkbox"' + (B.off[id] ? '' : ' checked') + '>' +
        '<span class="row-main"><b>' + (p.m || '-') + '/' + (p.d || '-') + '　' + esc(c[C.vendor]) + '</b><span class="small">' + esc(c[C.project]) + '</span></span>' +
        '<span class="row-amt">' + yen(num(c[C.amount])) + '円</span>';
      lab.querySelector('input').addEventListener('change', function () { B.off[id] = !this.checked; B.copied = false; updateBatch(); });
      box.appendChild(lab);
    });
    updateBatch();
  }
  function batchChosen() { return B.list.filter(function (r) { return !B.off[r.cells[C.id]]; }); }
  function batchText() { return batchChosen().map(function (r) { return r.cells[C.claim] || ''; }).filter(Boolean).join('\n———\n'); }
  function updateBatch() {
    var ch = batchChosen(), total = ch.reduce(function (s, r) { return s + num(r.cells[C.amount]); }, 0);
    $('#bCount').textContent = ch.length; $('#bCount2').textContent = ch.length; $('#bTotal').textContent = yen(total);
    $('#bPreview').innerHTML = ch.length ? claimHtml(batchText()) : '<span class="note">申請するものを選んでください</span>';
    var old = ch.map(function (r) { return r.cells[C.date]; }).filter(Boolean).sort()[0];
    if (old) {
      var days = Math.floor((new Date(isoDate(new Date())) - new Date(old)) / 864e5), p = parts(old);
      $('#bOld').textContent = p.m + '月' + p.d + '日の分は' + days + '日たっています。経理のルールは「月末まで溜めず、その都度」です。';
      $('#bOld').hidden = days < 7;
    } else $('#bOld').hidden = true;
    $('#btnBatchCopy').hidden = B.copied; $('#btnBatchCopy').disabled = !ch.length;
    $('#btnBatchMark').hidden = !B.copied; $('#btnBatchRecopy').hidden = !B.copied;
  }
  function batchCopyOpen() {
    if (!batchChosen().length) return;
    copyClaim(batchText()).then(function () { toast('まとめた申請文をコピーしました'); });
    window.open(SLACK_URL, '_blank', 'noopener');
    B.copied = true; updateBatch();
  }
  $('#btnBatchCopy').addEventListener('click', batchCopyOpen);
  $('#btnBatchRecopy').addEventListener('click', batchCopyOpen);
  $('#btnBatchMark').addEventListener('click', function () {
    var ch = batchChosen(), btn = this; if (!ch.length) return; btn.disabled = true;
    (DEMO ? Promise.resolve() : ensureToken().then(function () { return setStatusMany(ch, '申請済み'); })).then(function () {
      var today = isoDate(new Date());
      ch.forEach(function (r) { r.cells[C.status] = '申請済み'; r.cells[C.claimedOn] = today; });
      toast(ch.length + '件を「申請済み」にしました'); goHome();
    }).catch(function (e) { toast('台帳を書き換えられませんでした：' + errText(e), true); }).then(function () { btn.disabled = false; });
  });
  /** 複数の行をまとめて書き換える。シートごとにA列を1回だけ読み、申請IDで行を探す */
  async function setStatusMany(rows, status) {
    var groups = {};
    rows.forEach(function (r) { var k = r.ssId + '\t' + r.tab; (groups[k] = groups[k] || []).push(r.cells[C.id]); });
    for (var k in groups) {
      var ssId = k.split('\t')[0], tab = k.split('\t')[1];
      var j = await gfetch(rangeUrl(ssId, "'" + tab + "'!A:A")), ids = (j.values || []).map(function (r) { return r[0]; });
      var data = groups[k].map(function (id) {
        var idx = ids.indexOf(id); if (idx < 0) throw new Error('台帳に見つからない申請があります（' + id + '）');
        return { range: "'" + tab + "'!L" + (idx + 1) + ':M' + (idx + 1), values: [[status, status === '申請済み' ? isoDate(new Date()) : '']] };
      });
      await jsonPost(SHEETS + ssId + '/values:batchUpdate', { valueInputOption: 'RAW', data: data });
    }
  }

  // ============================================================ 5 マイページ
  function openMy() {
    show('mypage');
    $('#myName').textContent = S.user ? S.user.name : ''; $('#myEmail').textContent = S.user ? S.user.email : ''; $('#myInitial').textContent = S.user ? S.user.name.slice(0, 1) : '?';
    $('#myFolder').textContent = S.settings.folder ? S.settings.folder.name : '未設定';
    $$('input[name="split"]').forEach(function (r) { r.checked = r.value === (S.settings.split || 'standard'); });
    renderFavs();
  }
  $$('input[name="split"]').forEach(function (r) {
    r.addEventListener('change', function () {
      S.settings.split = this.value;
      saveSettings().then(function () { toast(S.settings.split === 'month' ? '月の稼働フォルダに直接保存します' : '月の稼働フォルダの中に「経費領収書：日付_案件名」フォルダを作って保存します'); })
        .catch(function (e) { toast('設定を保存できませんでした：' + errText(e), true); });
    });
  });
  function renderFavs() {
    var box = $('#favList'); box.innerHTML = '';
    var favs = S.settings.favorites || [];
    if (!favs.length) { box.innerHTML = '<span class="note">まだありません</span>'; return; }
    favs.forEach(function (s, i) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.title = '「' + s + '」を外す';
      b.innerHTML = esc(s) + '<span class="x" aria-hidden="true">×</span>'; b.setAttribute('aria-label', s + ' を外す');
      b.addEventListener('click', function () { favs.splice(i, 1); S.settings.favorites = favs; saveSettings(); renderFavs(); });
      box.appendChild(b);
    });
  }
  $('#btnFavAdd').addEventListener('click', function () {
    var v = $('#favInput').value.trim(); if (!v) return;
    var favs = (S.settings.favorites || []).filter(function (x) { return x !== v; });
    favs.unshift(v); S.settings.favorites = favs.slice(0, 10); $('#favInput').value = '';
    saveSettings().then(function () { toast('「' + v + '」を追加しました'); }).catch(function (e) { toast('保存できませんでした：' + errText(e), true); });
    renderFavs();
  });
  $('#favInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('#btnFavAdd').click(); } });

  // ============================================================ 不具合・要望の送信（宛先は裏側GASで固定。診断情報だけを送る）
  function diagnostics() {
    var ua = navigator.userAgent;
    return { app: VERSION, screen: S.screen, ua: ua, device: /iPhone|iPad|Android/.test(ua) ? 'スマホ' : 'PC', folderSet: !!S.settings.folder, split: S.settings.split, rows: S.rows.length, errors: lastErrors.slice() };
  }
  function openReport() {
    closeMenu(); var d = $('#reportDlg'); $('#repText').value = '';
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
  }
  function closeReport() { var d = $('#reportDlg'); if (d.close) d.close(); else d.removeAttribute('open'); }
  $('#btnRepCancel').addEventListener('click', closeReport);
  $('#btnRepSend').addEventListener('click', function () {
    var text = $('#repText').value.trim(), btn = this;
    if (!text) { toast('内容を書いてください', true); return; }
    btn.disabled = true;
    api('report', { kind: lastErrors.length ? 'error' : 'feedback', screen: S.screen, message: text.slice(0, 60), comment: text, detail: diagnostics() }).then(function (r) {
      if (!r.ok) throw new Error(r.error || '送れませんでした');
      closeReport(); toast('管理者に送りました。ありがとうございます');
    }).catch(function (e) { toast('送れませんでした：' + errText(e), true); }).then(function () { btn.disabled = false; });
  });

  // ============================================================ 試行の感想（裏側GASが管理者のスプレッドシートに1行記録）
  var fbRating = 0;
  function paintStars() { $$('#fbStars button').forEach(function (b) { b.setAttribute('aria-checked', String(Number(b.dataset.v) === fbRating)); }); }
  $$('#fbStars button').forEach(function (b) { b.addEventListener('click', function () { fbRating = Number(b.dataset.v); paintStars(); }); });
  $('#btnFb').addEventListener('click', function () {
    if (!fbRating) { toast('使い心地（1〜5）を選んでください', true); return; }
    var st = (S.cur && S.cur.stats) || {}, btn = this; btn.disabled = true;
    var stats = { app: VERSION, device: /iPhone|iPad|Android/.test(navigator.userAgent) ? 'スマホ' : 'PC', source: st.source, type: st.type, readSec: st.readSec, retries: st.retries, model: st.model, readStatus: S.saved && S.saved.readStatus || '' };
    api('feedback', { rating: fbRating, savedMin: num($('#fbMin').value) || '', comment: $('#fbText').value.trim(), stats: stats }).then(function (r) {
      if (!r.ok) throw new Error(r.error || '送れませんでした');
      $('#fbCard').hidden = true; toast('感想を記録しました。ありがとうございます');
    }).catch(function (e) { toast('送れませんでした：' + errText(e), true); }).then(function () { btn.disabled = false; });
  });

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
    if (action === 'read') return sleep(1500).then(function () { return { ok: true, model: 'gemini-3.5-flash-lite', result: { receiptCount: 1, docType: 'レシート', date: '2026-09-26', vendor: 'ファミリーマート', amount: 1220, paymentMethod: 'QR決済', invoiceNumber: 'T5180302016192', purposeHint: '菓子購入', unreadable: [] } }; });
    if (action === 'report' || action === 'feedback') return sleep(400).then(function () { return { ok: true }; });
    return Promise.resolve({ ok: false, error: '見本モード' });
  }
  function demoSave(f) {
    var p = parts(f.date), id = p.ymd + '-demo-0' + (S.rows.length + 1), claim = claimText(f); S.homeMonth = f.date.slice(0, 7);
    S.rows.push({ ssId: 'demo', tab: p.y + '-' + pad(p.m), cells: [id, stamp(), f.date, '', f.project, f.vendor, f.purpose, f.invoice, String(f.amount), f.pay, 'AIのまま', '未申請', '', claim, fileName(f), '', ''] });
    return { id: id, ssId: 'demo', tab: '', claim: claim, status: '未申請', fileName: fileName(f), fileUrl: '', path: '稼働（見本） › ' + p.y + '年' + p.m + '月稼働' + (S.settings.split !== 'month' ? ' › 経費領収書：' + p.m + '/' + p.d + '_' + f.project : ''), fresh: true, readStatus: 'AIのまま' };
  }
  if (DEMO) {
    gfetch = function (url) { return url.indexOf('userinfo') >= 0 ? Promise.resolve({ name: '見本 太郎' }) : Promise.resolve({}); };
    setTimeout(function () { $('#btnLogin').click(); }, 50);
  }
})();
