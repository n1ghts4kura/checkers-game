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

// Axial <-> Cube conversions and rotation helpers
const axialToCube = (q, r) => {
  const x = q;
  const z = r;
  const y = -x - z;
  return {x, y, z};
};

const cubeToAxial = (c) => {
  return [c.x, c.z];
};

const rotateCube60 = (c) => {
  // rotate 60 degrees clockwise: (x,y,z) -> (-z,-x,-y)
  return { x: -c.z, y: -c.x, z: -c.y };
};

const rotateAxial = (q, r, times) => {
  let c = axialToCube(q, r);
  for (let i = 0; i < (times % 6 + 6) % 6; i++) {
    c = rotateCube60(c);
  }
  return cubeToAxial(c);
};

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

    const maxSteps = options.maxSteps || 18;
    const maxAttempts = options.maxAttempts || 800;
    const minDirChanges = (typeof options.minDirChanges === 'number') ? options.minDirChanges : 1;
    const maxStraight = (typeof options.maxStraight === 'number') ? options.maxStraight : 1;
    const allowLongJumps = (typeof options.allowLongJumps === 'boolean') ? options.allowLongJumps : true;
    const maxFactor = options.maxFactor || 8;
    const branchChance = (typeof options.branchChance === 'number') ? options.branchChance : 0.18;
    const radialBias = (typeof options.radialBias === 'number') ? options.radialBias : 0.35;
    const directionBias = (typeof options.directionBias === 'number') ? options.directionBias : 0.8;
    const minDecisionPoints = (typeof options.minDecisionPoints === 'number') ? options.minDecisionPoints : 2;
    const decisionSeparation = (typeof options.decisionSeparation === 'number') ? options.decisionSeparation : 3;
    const minAlternatives = (typeof options.minAlternatives === 'number') ? options.minAlternatives : 2;
    // decorationDensity removed — worker no longer places visual decorations

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

    // Build backbone: forward growth from start with optional axis rotation and long-jump sampling
    const indexToLogical = (rIdx, cIdx) => {
      return [rIdx + 1, (cIdx - Math.floor((BOARD_COLS - rowsLayout[rIdx]) / 2)) + 1];
    };

    const buildBackbone = () => {
      const S = [];
      if (allowLongJumps) {
        for (let f = 2; f <= Math.max(2, maxFactor); f += 2) S.push(f);
      } else {
        S.push(2);
      }

      // prepare factor sampling weights with decay, prefer small jumps but allow up to 8
      let factorWeights = [];
      if (S.length === 1) {
        factorWeights = [1];
      } else {
        // assign heuristic weights depending on available factors
        const mapWeights = {2:0.6,4:0.18,6:0.12,8:0.10};
        let total = 0;
        for (const v of S) {
          const w = mapWeights[v] || 0.02; factorWeights.push(w); total += w;
        }
        // normalize
        if (total > 0) factorWeights = factorWeights.map(w => w / total);
        else factorWeights = S.map(() => 1 / S.length);
      }

      // compute map center (global axial) for radial bias
      let centerQ = 0, centerR = 0, countCells = 0;
      for (const k of axialToIndex.keys()) {
        const [qStr, rStr] = k.split(',');
        centerQ += parseInt(qStr, 10);
        centerR += parseInt(rStr, 10);
        countCells++;
      }
      if (countCells > 0) { centerQ /= countCells; centerR /= countCells; }

      // attempt multiple times
      for (let att = 0; att < maxAttempts && !cancelled; att++) {
        // random rotate (0..5)
        const rot = Math.floor(Math.random() * 6);

        // working temp board
        const tempBoard = board.map(row => row.slice());

        // start in local (rotated) coords
        const startLocal = rotateAxial(startAxial[0], startAxial[1], rot);
        let curQ = startLocal[0], curR = startLocal[1];

        const pathMid = [];
        const dirsTaken = [];
        let lastDirIdx = -1;
        let straightCount = 0;

        // local directions: rotate base directions
        const localDirs = AXIAL_DIRS.map(d => rotateAxial(d[0], d[1], rot));

        // helper: convert local axial -> global axial
        const localToGlobal = (lq, lr) => rotateAxial(lq, lr, (6 - rot) % 6);

        let success = false;

        let lastDecisionStep = -999;
        let decisionPointsCreated = 0;
        const alternativesPerDecision = [];

        for (let step = 0; step < maxSteps && !cancelled; step++) {
          // sample factor using prepared factorWeights (favor small jumps)
          let f = S[0];
          if (S.length > 1) {
            const rrr = Math.random();
            let cum = 0;
            for (let fi = 0; fi < S.length; fi++) {
              cum += factorWeights[fi];
              if (rrr <= cum) { f = S[fi]; break; }
            }
          }

          // compute weighted direction probabilities based on directionBias
          // groups: pair indices (0,3),(1,4),(2,5) rotated by rot
          // compute directional weights using group bias + radial bias, then softmax
          const weights = new Array(6).fill(1);
          const bias = Math.max(-1, Math.min(1, directionBias));
          // group bias in local coords: groups [0,3],[1,4],[2,5]
          if (bias > 0) {
            [0,3].forEach(i => weights[i] = 1 + bias);
            [1,4].forEach(i => weights[i] = 1 - bias * 0.3);
            [2,5].forEach(i => weights[i] = 1 - bias * 0.3);
          } else if (bias < 0) {
            [2,5].forEach(i => weights[i] = 1 + Math.abs(bias));
            [0,3].forEach(i => weights[i] = 1 - Math.abs(bias) * 0.3);
            [1,4].forEach(i => weights[i] = 1 - Math.abs(bias) * 0.3);
          }

          // radial bias component
          if (radialBias && Math.abs(radialBias) > 1e-6) {
            const centerLocal = rotateAxial(centerQ, centerR, rot);
            const radialX = curQ - centerLocal[0];
            const radialY = curR - centerLocal[1];
            const radialLen = Math.sqrt(radialX*radialX + radialY*radialY) || 1;
            for (let di = 0; di < localDirs.length; di++) {
              const dir = localDirs[di];
              const dirLen = Math.sqrt(dir[0]*dir[0] + dir[1]*dir[1]) || 1;
              const dot = (radialX * dir[0] + radialY * dir[1]) / (radialLen * dirLen);
              weights[di] = Math.max(0.001, weights[di] * (1 + radialBias * dot));
            }
          }

          // apply softmax normalization with temperature influenced by directionBias magnitude
          const temp = Math.max(0.3, 1 - Math.abs(bias) * 0.6);
          const exps = weights.map(w => Math.exp(w / temp));
          const sumExp = exps.reduce((s,v)=>s+v,0) || 1;
          const probs = exps.map(v => v / sumExp);

          // pick index by probability
          let pick = Math.random();
          let acc = 0;
          let chosenIdx = 0;
          for (let i = 0; i < probs.length; i++) {
            acc += probs[i];
            if (pick <= acc) { chosenIdx = i; break; }
          }
          const dir = localDirs[chosenIdx];
          const dirIdx = chosenIdx;

          // check straight constraint
          if (lastDirIdx === dirIdx) straightCount++; else straightCount = 1;
          if (straightCount > maxStraight) {
            // try next candidate (skip this iteration)
            continue;
          }

          // remember source (before move) and compute local mid and target
          const sourceLQ = curQ, sourceLR = curR;
          const midLQ = sourceLQ + dir[0] * (f / 2);
          const midLR = sourceLR + dir[1] * (f / 2);
          const tgtLQ = sourceLQ + dir[0] * f;
          const tgtLR = sourceLR + dir[1] * f;

          // convert to global and check
          const midGlobal = localToGlobal(midLQ, midLR);
          const tgtGlobal = localToGlobal(tgtLQ, tgtLR);
          const midKey = `${midGlobal[0]},${midGlobal[1]}`;
          const tgtKey = `${tgtGlobal[0]},${tgtGlobal[1]}`;
          if (!axialToIndex.has(midKey) || !axialToIndex.has(tgtKey)) {
            // cannot place here
            continue;
          }
          const [midRi, midCi] = axialToIndex.get(midKey);
          const [tRi, tCi] = axialToIndex.get(tgtKey);
          if (tempBoard[midRi][midCi] !== 0) continue;
          if (tempBoard[tRi][tCi] !== 0) continue;

          // check path between cur and target (all intermediate cells must be empty except mid which we will fill)
          let pathBlocked = false;
          for (let i = 1; i <= f; i++) {
            if (i === f/2) continue;
            const inLQ = curQ + dir[0] * i;
            const inLR = curR + dir[1] * i;
            const inGlobal = localToGlobal(inLQ, inLR);
            const inKey = `${inGlobal[0]},${inGlobal[1]}`;
            if (!axialToIndex.has(inKey)) { pathBlocked = true; break; }
            const [ir, ic] = axialToIndex.get(inKey);
            if (tempBoard[ir][ic] !== 0) { pathBlocked = true; break; }
          }
          if (pathBlocked) continue;

          // place mid obstacle
          tempBoard[midRi][midCi] = 1;
          const [rowNo, posNo] = indexToLogical(midRi, midCi);
          pathMid.push([rowNo, posNo, pickColor()]);
          dirsTaken.push(dirIdx);
          lastDirIdx = dirIdx;

          // move cur to target (in local coords)
          curQ = tgtLQ; curR = tgtLR;

          // optional short branch growth to create forks (doesn't need to reach victory)
          if (branchChance && Math.random() < branchChance) {
            const branchLen = 3; // more aggressive short local growth
            let bCurQ = curQ, bCurR = curR;
            for (let bi = 0; bi < branchLen; bi++) {
              // sample a direction greedily (reuse weights but small random)
              const bcands = [];
              for (let di = 0; di < localDirs.length; di++) bcands.push({idx: di, dir: localDirs[di], w: weights[di]});
              let btotal = bcands.reduce((s,c)=>s+c.w,0);
              let bpick = Math.random() * btotal; let bchosen = bcands[0];
              for (const bc of bcands) { bpick -= bc.w; if (bpick <= 0) { bchosen = bc; break; } }
              const bdir = bchosen.dir; const bdirIdx = bchosen.idx;
              // compute short jump f=2
              const bmidLQ = bCurQ + bdir[0] * 1;
              const bmidLR = bCurR + bdir[1] * 1;
              const btgtLQ = bCurQ + bdir[0] * 2;
              const btgtLR = bCurR + bdir[1] * 2;
              const bmidGlobal = localToGlobal(bmidLQ, bmidLR);
              const btgtGlobal = localToGlobal(btgtLQ, btgtLR);
              const bmidKey = `${bmidGlobal[0]},${bmidGlobal[1]}`;
              const btgtKey = `${btgtGlobal[0]},${btgtGlobal[1]}`;
              if (!axialToIndex.has(bmidKey) || !axialToIndex.has(btgtKey)) break;
              const [bmidRi, bmidCi] = axialToIndex.get(bmidKey);
              const [btRi, btCi] = axialToIndex.get(btgtKey);
              if (tempBoard[bmidRi][bmidCi] !== 0) break;
              if (tempBoard[btRi][btCi] !== 0) break;
              // place branch mid
              tempBoard[bmidRi][bmidCi] = 1;
              const [bRowNo, bPosNo] = indexToLogical(bmidRi, bmidCi);
              pathMid.push([bRowNo, bPosNo, pickColor()]);
              // advance branch cur
              bCurQ = btgtLQ; bCurR = btgtLR;
            }
          }

          // attempt to explicitly create a junction (decision point) at the source of this move
          // only if we still need decision points and separation constraint satisfied
          const sourceStep = step; // source corresponds to this step's source before move
          if (decisionPointsCreated < minDecisionPoints && (sourceStep - lastDecisionStep) >= decisionSeparation) {
            // attempt to find extra alternatives (besides chosenIdx) from the same source
            const needed = Math.max(0, minAlternatives - 1); // minus backbone direction
            if (needed > 0) {
              let found = 0;
              // shuffle candidate indices to avoid bias
              const candIdxs = [0,1,2,3,4,5].filter(i => i !== dirIdx);
              shuffle(candIdxs);
              for (const ci of candIdxs) {
                if (found >= needed) break;
                const cd = localDirs[ci];
                // test small jump f=2 for alternative from the actual source
                const fAlt = 2;
                const aMidLQ = sourceLQ + cd[0] * 1;
                const aMidLR = sourceLR + cd[1] * 1;
                const aTgtLQ = sourceLQ + cd[0] * fAlt;
                const aTgtLR = sourceLR + cd[1] * fAlt;
                const aMidGlobal = localToGlobal(aMidLQ, aMidLR);
                const aTgtGlobal = localToGlobal(aTgtLQ, aTgtLR);
                const aMidKey = `${aMidGlobal[0]},${aMidGlobal[1]}`;
                const aTgtKey = `${aTgtGlobal[0]},${aTgtGlobal[1]}`;
                if (!axialToIndex.has(aMidKey) || !axialToIndex.has(aTgtKey)) continue;
                const [amRi, amCi] = axialToIndex.get(aMidKey);
                const [atRi, atCi] = axialToIndex.get(aTgtKey);
                if (tempBoard[amRi][amCi] !== 0) continue; // mid must be empty to place obstacle
                if (tempBoard[atRi][atCi] !== 0) continue; // landing must be empty
                // place alternative mid obstacle
                tempBoard[amRi][amCi] = 1;
                const [rowNoA, posNoA] = indexToLogical(amRi, amCi);
                pathMid.push([rowNoA, posNoA, pickColor()]);
                found++;
              }
              if (found >= needed) {
                decisionPointsCreated++;
                lastDecisionStep = sourceStep;
                alternativesPerDecision.push(1 + found);
              }
            }
          }

          // if target maps to victory band (global r <= 3) then check success
          const tgtGlobalIdx = axialToIndex.get(tgtKey);
          if (tgtGlobalIdx && tgtGlobalIdx[0] <= 3) {
            // compute dir changes
            const dirChanges = dirsTaken.length > 0 ? dirsTaken.reduce((acc, _, i, arr) => { if (i === 0) return 0; return acc + (arr[i] !== arr[i-1] ? 1 : 0); }, 0) : 0;
            if (dirChanges >= minDirChanges) {
              success = true;
              break;
            }
          }
        }

        if (success && pathMid.length) {
          const avgAlternatives = alternativesPerDecision.length ? (alternativesPerDecision.reduce((s,v)=>s+v,0)/alternativesPerDecision.length) : 0;
          return { obstacles: pathMid, metrics: { decisionPointsCreated, avgAlternatives } };
        }
      }
      return null;
    };

    // Try backbone strategy first
    const backboneRes = buildBackbone();
    if (backboneRes && backboneRes.obstacles && backboneRes.obstacles.length) {
      postMessage({ type: 'result', obstacles: backboneRes.obstacles, attempts: 0, requestId, metrics: backboneRes.metrics });
      return;
    }

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
