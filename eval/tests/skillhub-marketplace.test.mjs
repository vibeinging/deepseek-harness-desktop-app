import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import JSZip from '../../server/node_modules/jszip/lib/index.js';
import {
  inspectSkillHubArchive,
  installSkillHubArchive,
  listSkillHubMarket,
  normalizeSkillHubDetail,
  normalizeSkillHubSearch,
  verifySkillHubSignature,
} from '../../server/src/app/plugins/skillhub.js';

async function createSkillArchive(name = 'market-test-skill') {
  const zip = new JSZip();
  zip.file('SKILL.md', [
    '---',
    `name: ${name}`,
    'description: 用于验证技能广场安装流程',
    '---',
    '',
    '# 工作方式',
    '先检查输入，再给出结果。',
    '',
  ].join('\n'));
  zip.file('references/guide.md', '# 参考说明\n');
  zip.file('_meta.json', '{"source":"test"}\n');
  return zip.generateAsync({ type: 'nodebuffer' });
}

function signedPayload(inspection, { slug = 'market-test-skill', version = '1.2.3' } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const payload = JSON.stringify({
    content_hash: inspection.content_hash,
    file_count: inspection.file_count,
    skill_slug: slug,
    skill_version: version,
    v: 1,
  });
  const signature = sign(null, Buffer.from(payload), privateKey).toString('base64');
  const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  return {
    signature: {
      signed: true,
      payload,
      signature,
      key_id: 'test-key',
      content_hash: inspection.content_hash,
      signed_at: 1_725_000_000_000,
    },
    keys: {
      keys: [{ key_id: 'test-key', algorithm: 'Ed25519', public_key_raw_b64: rawPublicKey }],
    },
  };
}

test('SkillHub search response is reduced to the fields used by Plugin Center', () => {
  const result = normalizeSkillHubSearch({
    code: 0,
    data: {
      total: 1,
      skills: [{
        slug: 'data-quality',
        name: '数据质量检查',
        description_zh: '检查结构化数据质量',
        version: '1.0.0',
        downloads: 42,
        publisher: { name: '测试组织', verified: true },
        labels: { requires_api_key: 'false' },
        subCategories: [{ name: '数据分析' }],
      }],
    },
  }, { page: 1, pageSize: 30 });

  assert.equal(result.total, 1);
  assert.equal(result.items[0].slug, 'data-quality');
  assert.equal(result.items[0].description, '检查结构化数据质量');
  assert.equal(result.items[0].publisher_verified, true);
  assert.equal(result.items[0].requires_api_key, false);
  assert.deepEqual(result.items[0].categories, ['数据分析']);
});

test('SkillHub market route forwards search to the domestic source', async () => {
  let requestedUrl = '';
  const response = await listSkillHubMarket({}, {
    query: { keyword: '数据分析', page: '2', page_size: '30' },
  }, {
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ code: 0, data: { total: 0, skills: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.match(requestedUrl, /^https:\/\/api\.skillhub\.cn\/api\/skills\?/);
  assert.match(requestedUrl, /page=2/);
  assert.match(requestedUrl, /pageSize=30/);
  assert.match(requestedUrl, /keyword=%E6%95%B0%E6%8D%AE%E5%88%86%E6%9E%90/);
  assert.equal(response.data.source.name, '腾讯 SkillHub');
});

test('SkillHub detail exposes version and security scan status', () => {
  const result = normalizeSkillHubDetail({
    latestVersion: { version: '1.0.2' },
    owner: { displayName: '测试发布者' },
    securityReports: {
      keen: { status: 'benign', statusText: '安全，无风险' },
      sanbu: { status: 'benign', statusText: '安全，无风险' },
    },
    skill: {
      slug: 'data-quality',
      displayName: '数据质量检查',
      summary_zh: '检查结构化数据质量',
      stats: { downloads: 42, versions: 2 },
      subCategories: [{ name: '数据分析' }],
      labels: { requires_api_key: 'false' },
    },
  });

  assert.equal(result.version, '1.0.2');
  assert.equal(result.owner, '测试发布者');
  assert.equal(result.security.status, 'passed');
  assert.equal(result.security.reports.length, 2);
});

test('SkillHub archive signature is verified before installation', async () => {
  const inspection = await inspectSkillHubArchive(await createSkillArchive());
  const signed = signedPayload(inspection);
  const verified = verifySkillHubSignature({
    ...signed,
    inspection,
    slug: 'market-test-skill',
    version: '1.2.3',
  });

  assert.equal(verified.key_id, 'test-key');
  assert.equal(verified.content_hash, inspection.content_hash);

  const invalid = { ...signed.signature, signature: Buffer.alloc(64).toString('base64') };
  assert.throws(
    () => verifySkillHubSignature({
      signature: invalid,
      keys: signed.keys,
      inspection,
      slug: 'market-test-skill',
      version: '1.2.3',
    }),
    /数字签名校验失败/,
  );
});

test('SkillHub archive rejects directory traversal paths', async () => {
  const zip = new JSZip();
  zip.file('SKILL.md', '---\nname: safe-skill\ndescription: test\n---\n');
  zip.file('../escape.txt', 'unsafe');
  const archive = await zip.generateAsync({ type: 'nodebuffer' });

  await assert.rejects(() => inspectSkillHubArchive(archive), /不安全的文件路径|目录越界/);
});

test('SkillHub archive installs into the supplied dsh-work skills root with provenance', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skillhub-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const inspection = await inspectSkillHubArchive(await createSkillArchive());
  const signed = signedPayload(inspection);
  const verified = verifySkillHubSignature({
    ...signed,
    inspection,
    slug: 'market-test-skill',
    version: '1.2.3',
  });

  const installed = await installSkillHubArchive({
    inspection,
    detail: {
      slug: 'market-test-skill',
      version: '1.2.3',
      detail_url: 'https://skillhub.cloud.tencent.com/skills/market-test-skill',
      owner: '测试组织',
      security: { status: 'passed', reports: [] },
    },
    signature: verified,
    skillsRoot: root,
  });

  assert.equal(installed.name, 'market-test-skill');
  assert.equal(existsSync(join(root, 'market-test-skill', 'SKILL.md')), true);
  const provenance = JSON.parse(await readFile(join(root, 'market-test-skill', '.dsh-market.json'), 'utf8'));
  assert.equal(provenance.source, 'tencent-skillhub');
  assert.equal(provenance.slug, 'market-test-skill');
  assert.equal(provenance.signature.content_hash, inspection.content_hash);
});
