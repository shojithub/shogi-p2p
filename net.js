// net.js — P2P対戦ネットワーキング
// マッチング/シグナリング: 公開MQTTブローカー（EMQX公開ブローカー、失敗時はHiveMQ公開ブローカー）
// 対戦データ: WebRTC DataChannel（P2P直結）
// IPv6優先: 自分のSDP内の候補を IPv6 → IPv4 の順に並べ替え、IPv6候補の優先度を
//           高く書き換えてから相手に渡すことで、ICEのペア選択をIPv6へ誘導する。
//           （ブラウザのICE自体は制御できないため「優先」であって強制ではない。
//             実際に選ばれたペアは getStats で確認して画面に表示する）
(function (global) {
'use strict';

var NS = 'muse-shogi-p2p/v1';
var BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt'
];
var ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' }
];

function randomId() {
  var s = '';
  var chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  for (var i = 0; i < 12; i++) s += chars[(Math.random() * chars.length) | 0];
  return s;
}

function isIPv6(addr) { return addr && addr.indexOf(':') >= 0; }

// SDP内の a=candidate 行を IPv6 優先に並べ替え、優先度を付け直す
function preferIPv6(sdp) {
  var lines = sdp.split('\r\n');
  var candIdx = [];
  var i;
  for (i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('a=candidate:') === 0) candIdx.push(i);
  }
  if (candIdx.length <= 1) return sdp;
  var cands = candIdx.map(function (idx) { return lines[idx]; });
  var sorted = cands.map(function (line, order) {
    var parts = line.split(' ');
    // a=candidate:foundation component protocol priority ip port typ ...
    return { line: line, order: order, v6: isIPv6(parts[4]) };
  }).sort(function (a, b) {
    if (a.v6 !== b.v6) return a.v6 ? -1 : 1;
    return a.order - b.order;
  });
  for (i = 0; i < sorted.length; i++) {
    var parts = sorted[i].line.split(' ');
    parts[3] = String(2122260223 - i * 100000); // 優先度を単調に付け直す
    lines[candIdx[i]] = parts.join(' ');
  }
  return lines.join('\r\n');
}

function waitForIceComplete(pc, timeoutMs) {
  return new Promise(function (resolve) {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    var done = false;
    function finish() { if (!done) { done = true; resolve(); } }
    pc.addEventListener('icegatheringstatechange', function () {
      if (pc.iceGatheringState === 'complete') finish();
    });
    setTimeout(finish, timeoutMs || 5000);
  });
}

function P2PNet(callbacks) {
  this.cb = callbacks || {};
  this.myId = randomId();
  this.mqtt = null;
  this.pc = null;
  this.dc = null;
  this.mode = null;         // 'random' | 'room'
  this.state = 'idle';      // idle | matching | signaling | connected
  this.peerId = null;
  this.signalTopic = null;
  this.seekTimer = null;
  this.seenSeekers = {};    // id -> lastSeen(ms)
  this.paired = false;
  this.statsTimer = null;
}

P2PNet.prototype._status = function (text) {
  if (this.cb.onStatus) this.cb.onStatus(text);
};

P2PNet.prototype._connectMqtt = function () {
  var self = this;
  return new Promise(function (resolve, reject) {
    var brokerIdx = 0;
    function tryNext() {
      if (brokerIdx >= BROKERS.length) { reject(new Error('公開ブローカーに接続できませんでした')); return; }
      var url = BROKERS[brokerIdx++];
      var client = global.mqtt.connect(url, {
        clientId: 'shogi_' + self.myId + '_' + Date.now(),
        connectTimeout: 8000,
        reconnectPeriod: 3000,
        clean: true
      });
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) { settled = true; try { client.end(true); } catch (e) {} tryNext(); }
      }, 9000);
      client.on('connect', function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        self.mqtt = client;
        self._wireMqtt();
        resolve(url);
      });
      client.on('error', function () {
        if (!settled) { settled = true; clearTimeout(timer); try { client.end(true); } catch (e) {} tryNext(); }
      });
    }
    tryNext();
  });
};

P2PNet.prototype._wireMqtt = function () {
  var self = this;
  this.mqtt.on('message', function (topic, payload) {
    var msg;
    try { msg = JSON.parse(payload.toString()); } catch (e) { return; }
    self._onMqttMessage(topic, msg);
  });
};

P2PNet.prototype._publish = function (topic, obj) {
  if (this.mqtt) this.mqtt.publish(topic, JSON.stringify(obj));
};

P2PNet.prototype._onMqttMessage = function (topic, msg) {
  if (!msg || msg.from === this.myId) return;

  // --- マッチング段階（ロビー / ルーム共通） ---
  if ((msg.kind === 'seek' || msg.kind === 'hello') && this.state === 'matching' && !this.paired) {
    this.seenSeekers[msg.from] = Date.now();
    this._tryPair(msg.from);
    return;
  }
  if (msg.kind === 'paired' && this.state === 'matching' && !this.paired) {
    if (msg.peerA === this.myId || msg.peerB === this.myId) {
      var other = msg.peerA === this.myId ? msg.peerB : msg.peerA;
      this._beginSignaling(other, msg.topic, false);
    }
    return;
  }

  // --- シグナリング段階 ---
  if (topic === this.signalTopic && msg.to === this.myId) {
    if (msg.kind === 'offer') this._handleOffer(msg);
    else if (msg.kind === 'answer') this._handleAnswer(msg);
  }
};

// 自分が小さいID側なら自分からペア成立を宣言する（決定性のあるタイブレーク）
P2PNet.prototype._tryPair = function (otherId) {
  if (this.paired || this.state !== 'matching') return;
  var pairTopic;
  if (this.mode === 'room') {
    pairTopic = this.signalTopic; // ルームでは同じトピックでシグナリング
  } else {
    var sorted = [this.myId, otherId].sort();
    pairTopic = NS + '/m/' + sorted.join('_');
  }
  if (this.myId < otherId) {
    // 自分がイニシエーター
    this._publish(this._lobbyTopic(), {
      kind: 'paired', from: this.myId, peerA: this.myId, peerB: otherId, topic: pairTopic
    });
    this._beginSignaling(otherId, pairTopic, true);
  }
  // 相手が小さいIDなら相手の 'paired' 宣言を待つ
};

P2PNet.prototype._lobbyTopic = function () {
  return this.mode === 'room' ? this.signalTopic : NS + '/lobby';
};

P2PNet.prototype._beginSignaling = function (peerId, topic, isInitiator) {
  var self = this;
  this.paired = true;
  this.peerId = peerId;
  this.signalTopic = topic;
  this.state = 'signaling';
  this._stopSeek();
  this.mqtt.subscribe(topic, function () {
    self._status(isInitiator ? '対戦相手が見つかりました。接続しています…' : '対戦相手が見つかりました。応答しています…');
    if (self.cb.onPaired) self.cb.onPaired({ initiator: isInitiator, peerId: peerId });
    // 相手のサブスクライブ完了を少し待ってからオファーを送る
    if (isInitiator) setTimeout(function () { self._createOffer(); }, 700);
  });
};

P2PNet.prototype._newPc = function () {
  var pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  var self = this;
  pc.onconnectionstatechange = function () {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      if (self.state === 'connected') {
        self.state = 'closed';
        if (self.cb.onClose) self.cb.onClose();
      }
    }
  };
  return pc;
};

P2PNet.prototype._setupDc = function (dc) {
  var self = this;
  this.dc = dc;
  dc.onopen = function () {
    self.state = 'connected';
    self._status('接続しました');
    self._reportConnInfo();
    if (self.cb.onOpen) self.cb.onOpen();
  };
  dc.onmessage = function (ev) {
    var obj;
    try { obj = JSON.parse(ev.data); } catch (e) { return; }
    if (self.cb.onMessage) self.cb.onMessage(obj);
  };
  dc.onclose = function () {
    if (self.state === 'connected') {
      self.state = 'closed';
      if (self.cb.onClose) self.cb.onClose();
    }
  };
};

P2PNet.prototype._createOffer = function () {
  var self = this;
  this.pc = this._newPc();
  var dc = this.pc.createDataChannel('game', { ordered: true });
  this._setupDc(dc);
  this.pc.createOffer().then(function (offer) {
    return self.pc.setLocalDescription(offer);
  }).then(function () {
    return waitForIceComplete(self.pc, 5000);
  }).then(function () {
    var sdp = preferIPv6(self.pc.localDescription.sdp);
    self._publish(self.signalTopic, { kind: 'offer', from: self.myId, to: self.peerId, sdp: sdp });
  }).catch(function (e) { self._status('接続に失敗しました: ' + e.message); });
};

P2PNet.prototype._handleOffer = function (msg) {
  var self = this;
  if (!this.pc) {
    this.pc = this._newPc();
    this.pc.ondatachannel = function (ev) { self._setupDc(ev.channel); };
  }
  this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }))
    .then(function () { return self.pc.createAnswer(); })
    .then(function (answer) { return self.pc.setLocalDescription(answer); })
    .then(function () { return waitForIceComplete(self.pc, 5000); })
    .then(function () {
      var sdp = preferIPv6(self.pc.localDescription.sdp);
      self._publish(self.signalTopic, { kind: 'answer', from: self.myId, to: self.peerId, sdp: sdp });
    })
    .catch(function (e) { self._status('接続に失敗しました: ' + e.message); });
};

P2PNet.prototype._handleAnswer = function (msg) {
  if (!this.pc) return;
  this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }))
    .catch(function (e) { /* 既に接続済みの場合などは無視 */ });
};

// 実際に選ばれたICEペア（IPv6かどうか）を調べて通知する
P2PNet.prototype._reportConnInfo = function () {
  var self = this;
  var tries = 0;
  if (this.statsTimer) clearInterval(this.statsTimer);
  this.statsTimer = setInterval(function () {
    tries++;
    if (!self.pc || tries > 8) { clearInterval(self.statsTimer); return; }
    self.pc.getStats().then(function (stats) {
      var pair = null, local = null, remote = null;
      var byId = {};
      stats.forEach(function (r) { byId[r.id] = r; });
      stats.forEach(function (r) {
        if (r.type === 'candidate-pair' && r.nominated && (r.state === 'succeeded' || r.state === 'in-progress')) {
          pair = r;
          local = byId[r.localCandidateId];
          remote = byId[r.remoteCandidateId];
        }
      });
      if (pair && local && remote) {
        clearInterval(self.statsTimer);
        var localAddr = local.address || local.ip || '';
        var remoteAddr = remote.address || remote.ip || '';
        var family = isIPv6(localAddr) && isIPv6(remoteAddr) ? 'IPv6'
          : (isIPv6(localAddr) || isIPv6(remoteAddr) ? 'IPv6/IPv4混在' : 'IPv4');
        if (self.cb.onConnInfo) {
          self.cb.onConnInfo({
            localAddr: localAddr, localType: local.candidateType,
            remoteAddr: remoteAddr, remoteType: remote.candidateType,
            protocol: local.protocol, family: family
          });
        }
      }
    }).catch(function () {});
  }, 1000);
};

P2PNet.prototype._startSeekLoop = function (kind) {
  var self = this;
  var send = function () {
    self._publish(self._lobbyTopic(), { kind: kind, from: self.myId, ts: Date.now() });
    // 古いシーカーを掃除しつつ、見えている相手とペアを試す
    var now = Date.now();
    Object.keys(self.seenSeekers).forEach(function (id) {
      if (now - self.seenSeekers[id] > 9000) delete self.seenSeekers[id];
      else self._tryPair(id);
    });
  };
  send();
  this.seekTimer = setInterval(send, 2500);
};

P2PNet.prototype._stopSeek = function () {
  if (this.seekTimer) { clearInterval(this.seekTimer); this.seekTimer = null; }
};

// ランダムマッチング開始
P2PNet.prototype.seekRandom = function () {
  var self = this;
  this.disconnect(true);
  this.mode = 'random';
  this.state = 'matching';
  this.paired = false;
  this.seenSeekers = {};
  this._status('公開ブローカーに接続しています…');
  this._connectMqtt().then(function (url) {
    self._status('対戦相手を探しています…（公開ブローカー経由: ' + url.replace('wss://', '') + '）');
    self.mqtt.subscribe(NS + '/lobby', function () {
      self._startSeekLoop('seek');
    });
  }).catch(function (e) { self._status(e.message); self.state = 'idle'; });
};

// あいことば→ルームトピックの決定的な変換。
// crypto.subtle（SHA-256）はセキュアコンテキスト（https / localhost）でしか
// 使えないため、file:// や平文httpで開いたときに joinRoom が無言で死ぬ。
// ルーム名は合言葉を知る者同士の待ち合わせ場所でしかないので、どの環境でも
// 同じ結果になる単純ハッシュ（cyrb53、二つのシードで32桁の16進数）で十分。
// PCがPages（https）、スマホがfile:// のような混在でも同じトピックになる。
function roomTopicHex(code) {
  var s = 'shogi-room:' + code.trim();
  function cyrb53(str, seed) {
    var h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (var i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  }
  return cyrb53(s, 0) + cyrb53(s, 1);
}

// あいことばルーム
P2PNet.prototype.joinRoom = function (code) {
  var self = this;
  this.disconnect(true);
  this.mode = 'room';
  this.state = 'matching';
  this.paired = false;
  this.seenSeekers = {};
  try {
    this.signalTopic = NS + '/room/' + roomTopicHex(code);
  } catch (e) {
    this._status('エラー: ' + e.message); this.state = 'idle'; return Promise.resolve();
  }
  this._status('公開ブローカーに接続しています…');
  return this._connectMqtt().then(function () {
    self._status('ルームで待機しています。同じあいことばを相手も入力すると始まります');
    self.mqtt.subscribe(self.signalTopic, function () {
      self._startSeekLoop('hello');
    });
  }).catch(function (e) { self._status('エラー: ' + e.message); self.state = 'idle'; });
};

P2PNet.prototype.send = function (obj) {
  if (this.dc && this.dc.readyState === 'open') {
    this.dc.send(JSON.stringify(obj));
    return true;
  }
  return false;
};

P2PNet.prototype.disconnect = function (silent) {
  this._stopSeek();
  if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
  if (this.dc) { try { this.dc.close(); } catch (e) {} this.dc = null; }
  if (this.pc) { try { this.pc.close(); } catch (e) {} this.pc = null; }
  if (this.mqtt) { try { this.mqtt.end(true); } catch (e) {} this.mqtt = null; }
  this.state = 'idle';
  this.paired = false;
  this.peerId = null;
  if (!silent) this._status('切断しました');
};

global.P2PNet = P2PNet;
global.P2PPreferIPv6 = preferIPv6;
})(typeof window !== 'undefined' ? window : globalThis);
