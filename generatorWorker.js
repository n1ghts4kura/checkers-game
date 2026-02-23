// generatorWorker.js
// Web Worker: 接收生成请求并返回障碍物列表

let cancelled = false;

const shuffle = (arr) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

const pickColor = () => ['#A020F0','#3282FF','#FF69B4','#FFD700','#FF8C00','#DC143C'][Math.floor(Math.random()*6)];

onmessage = function(e) {
  const msg = e.data;
  if (!msg || !msg.cmd) return;

  if (msg.cmd === 'cancel') {
    cancelled = true;
    return;
  }

  if (msg.cmd === 'generate') {
    cancelled = false;
    const { options = {}, rowsLayout = [], boardCols = 17, requestId = null } = msg;

    const maxSteps = options.maxSteps || 12;
    const maxAttempts = options.maxAttempts || 200;
    const minDirChanges = (typeof options.minDirChanges === 'number') ? options.minDirChanges : 2;
    const maxStraight = (typeof options.maxStraight === 'number') ? options.maxStraight : 2;

    // 构建空板与轴向映射
    const BOARD_ROWS = rowsLayout.length;
    const BOARD_COLS = boardCols;

    const createEmptyBoard = () => {
      const board = Array(BOARD_ROWS).fill().map(() => Array(BOARD_COLS).fill(-1));
      for (let r = 0; r < BOARD_ROWS; r++) {
        const count = rowsLayout[r];
        const offset = Math.floor((BOARD_COLS - count) / 2);
        for (let i = 0; i < count; i++) {
          const c = offset + i;
          board[r][c] = 0;
        }
      }
      return board;
    };

    const indexToAxial = new Map();
    const axialToIndex = new Map();

    const buildAxial = (board) => {
      indexToAxial.clear();
      axialToIndex.clear();
      for (let r = 0; r < BOARD_ROWS; r++) {
        for (let c = 0; c < BOARD_COLS; c++) {
          if (board[r][c] !== -1) {
            const q = c - Math.floor(r / 2);
            const axialR = r;
            indexToAxial.set(`${r},${c}`, [q, axialR]);
            axialToIndex.set(`${q},${axialR}`, [r, c]);
          }
        }
      }
    };

    const logicalToIndex = (rNo, posNo) => {
      const r = rNo - 1;
      if (r < 0 || r >= BOARD_ROWS) return null;
      const count = rowsLayout[r];
      const offset = Math.floor((BOARD_COLS - count) / 2);
      const c = offset + (posNo - 1);
      if (c < 0 || c >= BOARD_COLS) return null;
      return [r, c];
    };

    const AXIAL_DIRS = [ [1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1] ];

    const board = createEmptyBoard();
    buildAxial(board);

    const startIdx = logicalToIndex(17, 1);
    if (!startIdx) {
      postMessage({ type: 'error', message: 'start not found', requestId });
      return;
    }
    const startAxial = indexToAxial.get(`${startIdx[0]},${startIdx[1]}`);
    if (!startAxial) {
      postMessage({ type: 'error', message: 'start axial missing', requestId });
      return;
    }

    const victoryCells = [];
    for (let r = 0; r <= 3 && r < BOARD_ROWS; r++) {
      for (let c = 0; c < BOARD_COLS; c++) if (board[r][c] !== -1) victoryCells.push([r,c]);
    }

    const tryFromTarget = (targetQ, targetR) => {
      const visited = new Set();
      const pathMid = [];
      const dirsTaken = [];

      const dfs = (qCur, rCur, depth, lastDir, straightCount) => {
        if (cancelled) return false;
        if (depth > maxSteps) return false;
        const curKey = `${qCur},${rCur}`;
        const startKey = `${startAxial[0]},${startAxial[1]}`;
        if (curKey === startKey) return true;

        let candidates = AXIAL_DIRS.slice();
        shuffle(candidates);

        for (const d of candidates) {
          const dq = d[0], dr = d[1];
          const prevQ = qCur + dq * 2;
          const prevR = rCur + dr * 2;
          const midQ = qCur + dq;
          const midR = rCur + dr;
          const prevKey = `${prevQ},${prevR}`;
          const midKey = `${midQ},${midR}`;

          if (visited.has(prevKey)) continue;
          if (!axialToIndex.has(prevKey) || !axialToIndex.has(midKey)) continue;
          const [prevRi, prevCi] = axialToIndex.get(prevKey);
          const [midRi, midCi] = axialToIndex.get(midKey);
          if (board[prevRi][prevCi] !== 0) continue;
          if (board[midRi][midCi] !== 0) continue;

          let newStraight = 1;
          if (lastDir && d[0] === lastDir[0] && d[1] === lastDir[1]) newStraight = straightCount + 1;
          if (newStraight > maxStraight) continue;

          visited.add(prevKey);
          pathMid.push([midRi+1, (midCi - Math.floor((BOARD_COLS - rowsLayout[midRi])/2)) + 1, pickColor()]);
          dirsTaken.push(d);

          if (dfs(prevQ, prevR, depth+1, d, newStraight)) return true;

          visited.delete(prevKey);
          pathMid.pop();
          dirsTaken.pop();
        }
        return false;
      };

      const ok = dfs(targetQ, targetR, 0, null, 0);
      if (ok) {
        const dirChanges = dirsTaken.length > 0 ? dirsTaken.reduce((acc,_,i,arr) => { if (i===0) return 0; return acc + ((arr[i][0]!==arr[i-1][0] || arr[i][1]!==arr[i-1][1])?1:0); },0) : 0;
        if (dirChanges < minDirChanges) return null;
        return pathMid.slice();
      }
      return null;
    };

    let attempts = 0;
    while (attempts < maxAttempts && !cancelled) {
      attempts++;
        if (attempts % 25 === 0) {
        const percent = Math.floor((attempts / maxAttempts) * 100);
        postMessage({ type: 'progress', percent, requestId });
      }
      const [tR,tC] = victoryCells[Math.floor(Math.random()*victoryCells.length)];
      const tAxial = indexToAxial.get(`${tR},${tC}`);
      if (!tAxial) continue;
      const res = tryFromTarget(tAxial[0], tAxial[1]);
      if (res && res.length) {
        postMessage({ type: 'result', obstacles: res, attempts, requestId });
        return;
      }
    }

    if (cancelled) {
      postMessage({ type: 'error', message: 'cancelled', requestId });
    } else {
      postMessage({ type: 'result', obstacles: [], attempts, requestId });
    }
  }
};
