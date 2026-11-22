/** 通过现有广告记录验证器，把 CSV 转换结果覆盖到同 BV 的对应分 P。 */
const { existsSync, readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { join, resolve } = require('node:path');
const { gunzipSync } = require('node:zlib');
const { isDeepStrictEqual } = require('node:util');

async function main() {
  const [mode, archivePath, dbArg = '/var/lib/videoadguard-cache/cache.lmdb', installArg = '/opt/videoadguard-cache'] = process.argv.slice(2);
  if (!['--preview', '--apply', '--verify'].includes(mode) || !archivePath) {
    throw new Error('用法：node import-sponsor-lmdb.cjs --preview|--apply|--verify data.json.gz [数据库目录] [后端目录]');
  }
  const dbPath = resolve(dbArg);
  if (!existsSync(join(dbPath, 'data.mdb'))) throw new Error(`目标 LMDB 不存在：${dbPath}`);
  const requireFromServer = createRequire(join(resolve(installArg), 'dist', 'index.js'));
  const { DATA_VERSION, validateSaveBody } = requireFromServer('./validate.js');
  const { open } = requireFromServer('lmdb');
  const { summary, videos } = JSON.parse(gunzipSync(readFileSync(archivePath)).toString('utf8'));
  if (videos.length !== summary.videos || !videos.length) throw new Error('导入文件的视频数量不正确');
  const db = open({ path: dbPath, noSubdir: false, encoding: 'string', readOnly: mode !== '--apply' });

  const stats = { videos: 0, parts: 0, ranges: 0, newVideos: 0, newParts: 0, replacedParts: 0, identicalParts: 0 };
  function visit() {
    let lastBvid = '';
    for (const [bvid, parts] of videos) {
      if (!Array.isArray(parts) || !parts.length || bvid <= lastBvid) {
        throw new Error(`BV 号重复或记录格式有误：${bvid}`);
      }
      lastBvid = bvid;
      const previous = db.get(bvid);
      const value = previous === undefined ? {} : JSON.parse(previous);
      if (previous === undefined) stats.newVideos++;
      const updates = {};
      let lastCid = '';
      for (const [cid, detectedAt, adTimeRanges] of parts) {
        if (typeof cid !== 'string' || !/^[1-9][0-9]{0,19}$/.test(cid) || cid <= lastCid) {
          throw new Error(`分 P 编号无效或重复：${bvid}/${cid}`);
        }
        lastCid = cid;
        const validated = validateSaveBody({
          bvid, exist: true, goodName: [], adTimeRanges, detectedAt,
          isDetectionConfident: true, accuracy: 'accurate', source: 'user',
        });
        if (!validated || !adTimeRanges.length || !Number.isInteger(detectedAt)) {
          throw new Error(`广告记录无法通过现有验证：${bvid}/${cid}`);
        }
        const record = { ...validated, version: DATA_VERSION };
        const old = value.parts?.[cid];
        if (isDeepStrictEqual(old, record)) stats.identicalParts++;
        else if (mode === '--verify') throw new Error(`线上数据与导入内容不一致：${bvid}/${cid}`);
        else if (old === undefined) stats.newParts++;
        else stats.replacedParts++;
        updates[cid] = record;
        stats.parts++;
        stats.ranges += adTimeRanges.length;
      }
      if (mode === '--apply') db.putSync(bvid, JSON.stringify({ ...value, parts: { ...value.parts, ...updates } }));
      stats.videos++;
    }
    for (const field of ['videos', 'parts', 'ranges']) {
      if (stats[field] !== summary[field]) throw new Error(`统计不符：${field}`);
    }
  }

  try {
    // 整次导入在一个 LMDB 事务内。任一记录不通过验证时回滚本次写入。
    if (mode === '--apply') db.transactionSync(visit);
    else visit();
    console.log(JSON.stringify({ mode, ...stats }));
  } finally {
    await db.close();
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
