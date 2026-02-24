const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = 8070;

const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
    console.log(`[REQ] ${req.method} ${req.url}`);
    
    let filePath = req.url === '/' ? '/index.html' : req.url;
    
    // 在 pkg 打包后的环境中，__dirname 指向虚拟文件系统 (snapshot) 的根目录
    let absPath = path.join(__dirname, filePath);

    const extname = String(path.extname(absPath)).toLowerCase();
    const contentType = MIME_TYPES[extname] || 'application/octet-stream';

    fs.readFile(absPath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('404 Not Found - 文件未找到', 'utf-8');
            } else {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(`500 Server Error - 服务器错误: ${err.code}`, 'utf-8');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

server.listen(PORT, 'localhost', () => {
    console.log(`=========================================`);
    console.log(`🚀 跳棋游戏本地服务器已启动！`);
    console.log(`👉 请在浏览器中访问:`);
    console.log(`   http://localhost:${PORT}`);
    console.log(`=========================================`);
    console.log(`按 Ctrl+C 可以关闭服务器。`);
    
    // 如果是在 Windows 环境下运行，尝试自动打开默认浏览器
    if (process.platform === 'win32') {
        console.log(`正在尝试为您自动打开浏览器...`);
        exec(`start http://localhost:${PORT}`);
    }
});
