// 更新 Gist 上的 zones.json
// 更新时间戳，确保 APK 拉取最新数据时带有最新时间标记
const https = require('https');
const http = require('http');
const fs = require('fs');

const GIST_TOKEN = process.env.GIST_TOKEN;
const GIST_ID = process.env.GIST_ID || 'ae100eae98e9ab0b6b8494b14e0059af';
const GIST_OWNER = '3324572';

function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'drone-query-updater', ...options.headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetch(res.headers.location, options));
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject);
  });
}

async function getCurrentZones() {
  const url = `https://gist.githubusercontent.com/${GIST_OWNER}/${GIST_ID}/raw/zones.json`;
  try {
    const r = await fetch(url);
    return JSON.parse(r.data);
  } catch {
    return { zones: [], version: '1.0', updatedAt: new Date().toISOString() };
  }
}

async function updateGist(content) {
  const body = JSON.stringify({
    description: 'drone-query-zones',
    files: { 'zones.json': { content: JSON.stringify(content, null, 2) } },
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: `/gists/${GIST_ID}`,
      method: 'PATCH',
      headers: {
        'Authorization': `token ${GIST_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'drone-query-updater',
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, data: d }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  console.log('Starting zones update...');
  if (!GIST_TOKEN) {
    console.error('GIST_TOKEN not set');
    process.exit(1);
  }
  const current = await getCurrentZones();
  console.log('Current zones count:', current.zones?.length || 0);
  current.updatedAt = new Date().toISOString();
  current.lastUpdateSource = 'github-actions-daily';
  current.dataSource = 'based on public notices, not UOM real-time data';
  const r = await updateGist(current);
  if (r.status === 200) {
    console.log('Gist updated successfully');
  } else {
    console.error('Update failed:', r.status, r.data);
    process.exit(1);
  }
  fs.writeFileSync('zones.json', JSON.stringify(current, null, 2));
  console.log('Done');
})();
