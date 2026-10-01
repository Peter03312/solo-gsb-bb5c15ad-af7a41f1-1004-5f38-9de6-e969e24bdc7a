'use strict';
/**
 * 舞台监督提示单系统 —— HTTP 服务入口
 * 零外部依赖：node:http 提供 API 与静态页面，node:sqlite 存储。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const api = require('./src/api');
const { DB_PATH } = require('./src/db');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new api.HttpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new api.HttpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      // 前端路由回退到 index.html
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); return res.end('Not Found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readBody(req);
      const { status, data } = await api.handle(req, res, url, body);
      return sendJson(res, status, data);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: '方法不允许' });
    }
    serveStatic(req, res, url.pathname);
  } catch (err) {
    if (err instanceof api.HttpError) {
      return sendJson(res, err.status, { error: err.message, ...err.extra });
    }
    console.error('[server] 未处理异常:', err);
    sendJson(res, 500, { error: '服务器内部错误' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[server] 舞台监督提示单系统已启动: http://localhost:${PORT}`);
  console.log(`[server] 数据库文件: ${DB_PATH}`);
});
