// 本地预览：按 Netlify 的方式服务 public/ 并把 /api/* 交给同一个函数处理。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { handler } from './netlify/functions/api.mjs';

const root = new URL('./public/', import.meta.url);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json' };
const port = Number(process.env.PORT || 18880);

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const out = await handler({ path: url.pathname, queryStringParameters: Object.fromEntries(url.searchParams) });
    res.writeHead(out.statusCode, out.headers).end(out.body);
    return;
  }
  const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  try {
    const body = await readFile(new URL(name, root));
    res.writeHead(200, { 'Content-Type': types[extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log('preview http://127.0.0.1:' + port));
