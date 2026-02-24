// generatorWorker.js
// Web Worker: 接收生成请求并返回障碍物列表

let cancelled = false;

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

    // 提取难度等级 (1-4)，默认为 2 (中等)
    const difficultyLevel = (typeof options.difficulty === 'number') ? options.difficulty : 2;

    // 根据难度等级预设量化参数
    let maxObstacles, probBranch2, probBranch3, probDeadEnd, weightHorizontal, weightMerge, allowLongJumps, maxFactor;

    switch (difficultyLevel) {
      case 1: // 简单 (Easy) - 稀疏，单线为主，无长跳
        maxObstacles = 12;
        probBranch2 = 0.1;
        probBranch3 = 0.0;
        probDeadEnd = 0.05;
        weightHorizontal = 10;
        weightMerge = 0;
        allowLongJumps = false;
        maxFactor = 2;
        break;
      case 2: // 中等 (Normal) - 适度分支，少量横向，允许短距离长跳
        maxObstacles = 20;
        probBranch2 = 0.25;
        probBranch3 = 0.05;
        probDeadEnd = 0.1;
        weightHorizontal = 20;
        weightMerge = 5;
        allowLongJumps = true;
        maxFactor = 4;
        break;
      case 3: // 困难 (Hard) - 密集，多分支，频繁横向，允许中距离长跳
        maxObstacles = 30;
        probBranch2 = 0.35;
        probBranch3 = 0.15;
        probDeadEnd = 0.15;
        weightHorizontal = 35;
        weightMerge = 15;
        allowLongJumps = true;
        maxFactor = 6;
        break;
      case 4: // 极难 (Expert) - 极度拥挤，迷宫网络，大量死胡同和长跳
        maxObstacles = 45;
        probBranch2 = 0.45;
        probBranch3 = 0.25;
        probDeadEnd = 0.25;
        weightHorizontal = 50;
        weightMerge = 25;
        allowLongJumps = true;
        maxFactor = 8;
        break;
      default:
        maxObstacles = 20;
        probBranch2 = 0.25;
        probBranch3 = 0.05;
        probDeadEnd = 0.1;
        weightHorizontal = 20;
        weightMerge = 5;
        allowLongJumps = true;
        maxFactor = 4;
    }

    const maxAttempts = options.maxAttempts || 800;
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

    const indexToLogical = (rIdx, cIdx) => {
      return [rIdx + 1, (cIdx - Math.floor((BOARD_COLS - rowsLayout[rIdx]) / 2)) + 1];
    };

    const buildNetwork = () => {
      const obstacles = [];
      const queue = [];
      const visitedTargets = new Set();
      const obstacleSet = new Set();
      const pathCells = new Set();
      
      const startKey = `${startAxial[0]},${startAxial[1]}`;
      queue.push({ q: startAxial[0], r: startAxial[1], depth: 0 });
      visitedTargets.add(startKey);
      pathCells.add(startKey);
      
      let victoryReached = 0;
      let nodesProcessed = 0;
      const MAX_NODES = 300;
      
      while (queue.length > 0 && nodesProcessed < MAX_NODES && !cancelled) {
        // Pop from front (BFS) to ensure wide spread
        const curr = queue.shift();
        nodesProcessed++;
        
        if (curr.r <= 3) {
          victoryReached++;
          // Don't expand too much from victory area to avoid cluttering the top
          if (victoryReached > 8 || Math.random() < 0.7) continue;
        }
        
        const validJumps = [];
        
        for (const dir of AXIAL_DIRS) {
          for (const f of [2, 4, 6, 8]) {
            if (!allowLongJumps && f > 2) continue;
            if (f > maxFactor) continue;
            
            const midQ = curr.q + dir[0] * (f/2);
            const midR = curr.r + dir[1] * (f/2);
            const tgtQ = curr.q + dir[0] * f;
            const tgtR = curr.r + dir[1] * f;
            
            const midKey = `${midQ},${midR}`;
            const tgtKey = `${tgtQ},${tgtR}`;
            
            if (!axialToIndex.has(midKey) || !axialToIndex.has(tgtKey)) continue;
            if (obstacleSet.has(midKey) || pathCells.has(midKey) || midKey === startKey) continue;
            if (obstacleSet.has(tgtKey)) continue;
            
            let pathClear = true;
            for (let i = 1; i < f; i++) {
              if (i === f/2) continue;
              const pQ = curr.q + dir[0] * i;
              const pR = curr.r + dir[1] * i;
              const pKey = `${pQ},${pR}`;
              if (!axialToIndex.has(pKey) || obstacleSet.has(pKey)) {
                pathClear = false;
                break;
              }
            }
            if (!pathClear) continue;
            
            let score = 10;
            if (dir[1] === 0) score += weightHorizontal; // Strong horizontal preference
            if (dir[1] < 0) score += 15;   // Upward preference
            if (dir[1] > 0) score -= 10;   // Downward penalty
            
            if (visitedTargets.has(tgtKey)) {
              score += weightMerge; // Encourage merging paths
            }
            
            // Add some randomness
            score += Math.random() * 10;
            
            if (score > 0) {
              validJumps.push({ midQ, midR, tgtQ, tgtR, midKey, tgtKey, score, f });
            }
          }
        }
        
        validJumps.sort((a, b) => b.score - a.score);
        
        // Determine how many branches to create from this node
        let numPicks = 1;
        const rand = Math.random();
        
        // Dynamic branching probability based on current obstacle count
        let currentProbBranch2 = probBranch2;
        let currentProbBranch3 = probBranch3;
        let currentProbDeadEnd = probDeadEnd;
        
        if (obstacles.length > maxObstacles * 0.6) {
            currentProbBranch2 *= 0.5;
            currentProbBranch3 = 0.0;
        }
        if (obstacles.length > maxObstacles) {
            numPicks = 1; // strictly 1
            if (rand < currentProbDeadEnd * 2) numPicks = 0; // more dead ends
        } else {
            if (rand < currentProbDeadEnd) numPicks = 0;
            else if (rand < currentProbDeadEnd + currentProbBranch2) numPicks = 2;
            else if (rand < currentProbDeadEnd + currentProbBranch2 + currentProbBranch3) numPicks = 3;
        }
        
        // Force at least 1 pick if we are at the start or haven't branched much
        if (curr.depth === 0) numPicks = Math.max(2, numPicks);
        
        // If we are over maxObstacles, force numPicks to 0 to stop growing
        if (obstacles.length >= maxObstacles) {
            numPicks = 0;
        }

        numPicks = Math.min(numPicks, validJumps.length);
        
        let branchesCreated = 0;
        for (let i = 0; i < validJumps.length && branchesCreated < numPicks; i++) {
          const jump = validJumps[i];
          
          // Double check if midKey became an obstacle in this loop
          if (obstacleSet.has(jump.midKey)) continue;
          
          obstacleSet.add(jump.midKey);
          const [midRowIdx, midColIdx] = axialToIndex.get(jump.midKey);
          const [logicalRow, logicalPos] = indexToLogical(midRowIdx, midColIdx);
          obstacles.push([logicalRow, logicalPos, pickColor()]);
          
          if (!visitedTargets.has(jump.tgtKey)) {
            visitedTargets.add(jump.tgtKey);
            queue.push({ q: jump.tgtQ, r: jump.tgtR, depth: curr.depth + 1 });
            pathCells.add(jump.tgtKey);
          }
          branchesCreated++;
        }
      }
      
      if (victoryReached > 0) {
        return obstacles;
      }
      return null;
    };

    let attempts = 0;
    let finalObstacles = null;
    
    while (attempts < maxAttempts && !cancelled) {
      attempts++;
      if (attempts % 25 === 0) {
        const percent = Math.floor((attempts / maxAttempts) * 100);
        postMessage({ type: 'progress', percent, requestId });
      }
      
      const res = buildNetwork();
      if (res && res.length > 0) {
        finalObstacles = res;
        break;
      }
    }

    if (cancelled) {
      postMessage({ type: 'error', message: 'cancelled', requestId });
    } else {
      postMessage({ type: 'result', obstacles: finalObstacles || [], attempts, requestId });
    }
  }
};
