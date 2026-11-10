// shogi.js — 将棋エンジン（ブラウザ / Node 両用、依存なし）
// 盤面: 配列81、idx = y*9 + x
//   x: 0=9筋 … 8=1筋（先手から見て左→右）
//   y: 0=一段 … 8=九段（上=後手側、下=先手側）
// 駒: 正の数=先手、負の数=後手、絶対値が駒コード
//   1歩 2香 3桂 4銀 5金 6角 7飛 8玉 / +8で成駒（9と 10成香 11成桂 12成銀 14龍馬 15龍王）
(function (global) {
'use strict';

var FU = 1, KY = 2, KE = 3, GI = 4, KI = 5, KA = 6, HI = 7, OU = 8;

function baseType(code) { return code > 8 ? code - 8 : code; }
function isPromoted(code) { return code > 8; }
function canPromote(code) {
  var b = baseType(code);
  return !isPromoted(code) && b !== KI && b !== OU;
}

var GOLD_STEPS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [0, 1]];
var OU_STEPS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
var DIAG = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
var ORTHO = [[0, -1], [-1, 0], [1, 0], [0, 1]];

// 先手視点の動き（dy<0 が前）。後手は dy を反転する
var MOVE_DEFS = {};
MOVE_DEFS[FU] = { steps: [[0, -1]], slides: [] };
MOVE_DEFS[KY] = { steps: [], slides: [[0, -1]] };
MOVE_DEFS[KE] = { steps: [[-1, -2], [1, -2]], slides: [] };
MOVE_DEFS[GI] = { steps: [[-1, -1], [0, -1], [1, -1], [-1, 1], [1, 1]], slides: [] };
MOVE_DEFS[KI] = { steps: GOLD_STEPS, slides: [] };
MOVE_DEFS[KA] = { steps: [], slides: DIAG };
MOVE_DEFS[HI] = { steps: [], slides: ORTHO };
MOVE_DEFS[OU] = { steps: OU_STEPS, slides: [] };
MOVE_DEFS[9] = { steps: GOLD_STEPS, slides: [] };   // と
MOVE_DEFS[10] = { steps: GOLD_STEPS, slides: [] };  // 成香
MOVE_DEFS[11] = { steps: GOLD_STEPS, slides: [] };  // 成桂
MOVE_DEFS[12] = { steps: GOLD_STEPS, slides: [] };  // 成銀
MOVE_DEFS[14] = { steps: ORTHO, slides: DIAG };     // 龍馬
MOVE_DEFS[15] = { steps: DIAG, slides: ORTHO };     // 龍王

var PIECE_NAMES = {
  1: '歩', 2: '香', 3: '桂', 4: '銀', 5: '金', 6: '角', 7: '飛', 8: '玉',
  9: 'と', 10: '成香', 11: '成桂', 12: '成銀', 14: '龍馬', 15: '龍王'
};
var PIECE_NAMES_FULL = {
  1: '歩兵', 2: '香車', 3: '桂馬', 4: '銀将', 5: '金将', 6: '角行', 7: '飛車', 8: '玉将',
  9: 'と金', 10: '成香', 11: '成桂', 12: '成銀', 14: '龍馬', 15: '龍王'
};
var HAND_TYPES = [FU, KY, KE, GI, KI, KA, HI]; // 持ち駒になりうる基本駒（玉以外）

function emptyHands() { return [0, 0, 0, 0, 0, 0, 0, 0, 0]; } // index=基本駒コード

function initialState() {
  var b = new Array(81).fill(0);
  var back = [KY, KE, GI, KI, OU, KI, GI, KE, KY];
  for (var x = 0; x < 9; x++) {
    b[x] = -back[x];       // 後手 一段
    b[72 + x] = back[x];   // 先手 九段
    b[18 + x] = -FU;       // 後手 三段
    b[54 + x] = FU;        // 先手 七段
  }
  b[9 + 1] = -HI;  // 後手 8二 飛
  b[9 + 7] = -KA;  // 後手 2二 角
  b[63 + 1] = KA;  // 先手 8八 角
  b[63 + 7] = HI;  // 先手 2八 飛
  return {
    board: b,
    hands: { '1': emptyHands(), '-1': emptyHands() },
    turn: 1, // 1=先手, -1=後手
    moveCount: 0
  };
}

function cloneState(s) {
  return {
    board: s.board.slice(),
    hands: { '1': s.hands['1'].slice(), '-1': s.hands['-1'].slice() },
    turn: s.turn,
    moveCount: s.moveCount
  };
}

function kingPos(state, side) {
  var target = OU * side;
  for (var i = 0; i < 81; i++) if (state.board[i] === target) return i;
  return -1;
}

// from の駒が攻撃できるマス一覧（盤上の移動のみ、合法性は不問）
function pseudoTargets(state, from) {
  var v = state.board[from];
  if (v === 0) return [];
  var code = Math.abs(v);
  var side = v > 0 ? 1 : -1;
  var def = MOVE_DEFS[code];
  var fx = from % 9, fy = (from / 9) | 0;
  var out = [];
  var i, dx, dy, nx, ny;
  for (i = 0; i < def.steps.length; i++) {
    dx = def.steps[i][0]; dy = def.steps[i][1] * side;
    nx = fx + dx; ny = fy + dy;
    if (nx < 0 || nx > 8 || ny < 0 || ny > 8) continue;
    var t = state.board[ny * 9 + nx];
    if (t === 0 || (t > 0) !== (v > 0)) out.push(ny * 9 + nx);
  }
  for (i = 0; i < def.slides.length; i++) {
    dx = def.slides[i][0]; dy = def.slides[i][1] * side;
    nx = fx; ny = fy;
    while (true) {
      nx += dx; ny += dy;
      if (nx < 0 || nx > 8 || ny < 0 || ny > 8) break;
      var t2 = state.board[ny * 9 + nx];
      if (t2 === 0) { out.push(ny * 9 + nx); continue; }
      if ((t2 > 0) !== (v > 0)) out.push(ny * 9 + nx);
      break;
    }
  }
  return out;
}

// side の玉が bySide に攻撃されているか
function isAttacked(state, kingIdx, bySide) {
  if (kingIdx < 0) return false;
  for (var i = 0; i < 81; i++) {
    var v = state.board[i];
    if (v === 0 || (v > 0 ? 1 : -1) !== bySide) continue;
    var targets = pseudoTargets(state, i);
    for (var j = 0; j < targets.length; j++) if (targets[j] === kingIdx) return true;
  }
  return false;
}

function inCheck(state, side) {
  return isAttacked(state, kingPos(state, side), -side);
}

function inPromotionZone(idx, side) {
  var y = (idx / 9) | 0;
  return side === 1 ? y <= 2 : y >= 6;
}
function deadRankForMove(code, toIdx, side) {
  // 移動後に行き場がなくなるマス（強制成り対象）
  var y = (toIdx / 9) | 0;
  var b = baseType(code);
  if (side === 1) {
    if ((b === FU || b === KY) && y === 0) return true;
    if (b === KE && y <= 1) return true;
  } else {
    if ((b === FU || b === KY) && y === 8) return true;
    if (b === KE && y >= 7) return true;
  }
  return false;
}
function deadRankForDrop(base, toIdx, side) {
  var y = (toIdx / 9) | 0;
  if (side === 1) {
    if ((base === FU || base === KY) && y === 0) return true;
    if (base === KE && y <= 1) return true;
  } else {
    if ((base === FU || base === KY) && y === 8) return true;
    if (base === KE && y >= 7) return true;
  }
  return false;
}

function applyMove(state, move) {
  var s = cloneState(state);
  var side = s.turn;
  if (move.drop) {
    s.hands[String(side)][move.piece]--;
    s.board[move.to] = move.piece * side;
  } else {
    var v = s.board[move.from];
    var captured = s.board[move.to];
    if (captured !== 0) {
      var cb = baseType(Math.abs(captured));
      if (cb !== OU) s.hands[String(side)][cb]++;
    }
    s.board[move.to] = move.promote ? (Math.abs(v) + 8) * side : v;
    s.board[move.from] = 0;
  }
  s.turn = -side;
  s.moveCount++;
  return s;
}

// 合法手生成。opts.checkUchiFu=false のとき打ち歩詰め判定を省略（再帰防止）
function legalMoves(state, opts) {
  opts = opts || {};
  var checkUchiFu = opts.checkUchiFu !== false;
  var side = state.turn;
  var moves = [];
  var i, x, y;

  // --- 盤上の駒の移動 ---
  for (i = 0; i < 81; i++) {
    var v = state.board[i];
    if (v === 0 || (v > 0 ? 1 : -1) !== side) continue;
    var code = Math.abs(v);
    var targets = pseudoTargets(state, i);
    for (var j = 0; j < targets.length; j++) {
      var to = targets[j];
      var variants;
      if (canPromote(code) && (inPromotionZone(i, side) || inPromotionZone(to, side))) {
        if (deadRankForMove(code, to, side)) variants = [true];
        else variants = [false, true];
      } else {
        variants = [false];
      }
      for (var k = 0; k < variants.length; k++) {
        var mv = { from: i, to: to, piece: code, promote: variants[k], drop: false };
        var ns = applyMove(state, mv);
        if (!inCheck(ns, side)) moves.push(mv);
      }
    }
  }

  // --- 持ち駒を打つ ---
  var hand = state.hands[String(side)];
  for (var h = 0; h < HAND_TYPES.length; h++) {
    var base = HAND_TYPES[h];
    if (hand[base] <= 0) continue;
    for (var t = 0; t < 81; t++) {
      if (state.board[t] !== 0) continue;
      if (deadRankForDrop(base, t, side)) continue;
      if (base === FU) {
        // 二歩チェック: 同じ筋に自分の歩（未成）があれば不可
        x = t % 9;
        var nifu = false;
        for (y = 0; y < 9; y++) {
          if (state.board[y * 9 + x] === FU * side) { nifu = true; break; }
        }
        if (nifu) continue;
      }
      var dm = { from: -1, to: t, piece: base, promote: false, drop: true };
      var ns2 = applyMove(state, dm);
      if (inCheck(ns2, side)) continue;
      // 打ち歩詰め: 歩を打って王手になり、相手に合法手が一切なければ違法
      if (checkUchiFu && base === FU && inCheck(ns2, -side)) {
        var replies = legalMoves(ns2, { checkUchiFu: false });
        if (replies.length === 0) continue;
      }
      moves.push(dm);
    }
  }
  return moves;
}

function positionKey(state) {
  return state.board.join(',') + '|' +
    state.hands['1'].join(',') + '|' + state.hands['-1'].join(',') + '|' + state.turn;
}

var KANJI_RANK = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
var ZEN_DIGITS = ['０', '１', '２', '３', '４', '５', '６', '７', '８', '９'];

// 棋譜表記（例: ▲７六歩 / △同 金 / ▲５二金打）
function moveToKifu(state, move, prevMove) {
  var sideMark = state.turn === 1 ? '▲' : '△';
  var tx = move.to % 9, ty = (move.to / 9) | 0;
  var dest;
  if (prevMove && prevMove.to === move.to) dest = '同';
  else dest = ZEN_DIGITS[9 - tx] + KANJI_RANK[ty];
  var name;
  if (move.drop) {
    name = PIECE_NAMES[move.piece] + '打';
    return sideMark + dest + ' ' + name;
  }
  name = PIECE_NAMES[move.piece];
  if (move.promote) name += '成';
  else if (isPromoted(move.piece)) name = PIECE_NAMES[move.piece];
  return sideMark + dest + name;
}

var Shogi = {
  FU: FU, KY: KY, KE: KE, GI: GI, KI: KI, KA: KA, HI: HI, OU: OU,
  baseType: baseType,
  isPromoted: isPromoted,
  canPromote: canPromote,
  PIECE_NAMES: PIECE_NAMES,
  PIECE_NAMES_FULL: PIECE_NAMES_FULL,
  HAND_TYPES: HAND_TYPES,
  initialState: initialState,
  cloneState: cloneState,
  kingPos: kingPos,
  inCheck: inCheck,
  legalMoves: legalMoves,
  applyMove: applyMove,
  positionKey: positionKey,
  moveToKifu: moveToKifu
};

if (typeof module !== 'undefined' && module.exports) module.exports = Shogi;
global.Shogi = Shogi;
})(typeof window !== 'undefined' ? window : globalThis);
