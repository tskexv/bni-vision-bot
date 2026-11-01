// บอทกรอกฟอร์ม Retention Tracking เดิมของ BNI แทน Mentor Co (อ่านคิวจาก Supabase)
// MODE: submit = ส่งจริง | dryrun = กรอกทุกช่องแต่ไม่กดส่ง | sync = ดึงช่วงสัปดาห์จากฟอร์มเดิมมาอัปเดตในระบบ | ping = แค่ปลุกฐานข้อมูล
import { createClient } from '@supabase/supabase-js';
import { mkdirSync, appendFileSync } from 'node:fs';

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const MODE = (process.env.MODE || 'submit').trim();
const ROLE = 'Mentor Coordinator';
if (!URL_ || !KEY) { console.error('ต้องตั้ง SUPABASE_URL และ SUPABASE_SERVICE_KEY ใน GitHub Secrets'); process.exit(1); }
const db = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
mkdirSync('shots', { recursive: true });

const FIELD_NAMES = {
  '#role': 'แบบฟอร์มสำหรับใคร', '#chapterName': 'Chapter Name', '#memberName_m': 'Member Name',
  '#mentorCoName': 'Mentor Co Name', '#personalMentorName': 'Personal Mentor Name', '#week_m': 'สัปดาห์',
};

async function settings() {
  const { data, error } = await db.from('settings').select('key, value').in('key', ['retention_form_url', 'retention_chapter']);
  if (error) throw new Error('อ่านค่าตั้งระบบไม่ได้: ' + error.message);
  const s = Object.fromEntries(data.map(r => [r.key, r.value]));
  if (!s.retention_form_url) throw new Error('ยังไม่ได้ตั้งลิงก์ฟอร์มเดิม (แอดมิน › ตั้งค่า)');
  return { formUrl: s.retention_form_url, chapter: s.retention_chapter || 'BNI Vision' };
}
const log = (kind, message) => db.from('bot_log').insert({ kind, message }).then(() => {}, () => {});

/** เปิดฟอร์มเดิมแล้วหา iframe ที่มีตัวฟอร์มอยู่ (Apps Script ซ้อน iframe) */
async function openForm(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      try {
        if (await f.$('#role')) {
          await f.waitForFunction(() => { const r = document.querySelector('#role'); return r && !r.disabled && r.options.length > 1; }, null, { timeout: 45000 });
          return f;
        }
      } catch { /* frame ยังโหลดไม่เสร็จ */ }
    }
    await page.waitForTimeout(500);
  }
  throw new Error('เปิดฟอร์ม Retention Tracking ไม่ขึ้นภายใน 60 วินาที');
}
async function pick(frame, sel, label) {
  const value = await frame.$eval(sel, (el, label) => {
    const n = s => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const o = [...el.options].find(o => o.value !== '' && (n(o.textContent) === n(label) || n(o.value) === n(label)));
    return o ? o.value : null;
  }, label);
  if (value == null) throw new Error(`ไม่พบ "${label}" ในช่อง ${FIELD_NAMES[sel] || sel} ของฟอร์มเดิม (ชื่อต้องตรงกับ BNI Connect)`);
  await frame.selectOption(sel, value);
}
const optionLabels = (frame, sel) => frame.$eval(sel, el => [...el.options].filter(o => o.value !== '').map(o => o.textContent.replace(/\s+/g, ' ').trim()));
async function waitMembers(frame) {
  await frame.waitForFunction(() => { const m = document.querySelector('#memberName_m'); return m && !m.disabled && m.options.length > 1; }, null, { timeout: 45000 })
    .catch(async () => { const t = await frame.$eval('#questionsArea', el => el.textContent.trim()).catch(() => ''); throw new Error('โหลดรายชื่อสมาชิกจากฟอร์มเดิมไม่สำเร็จ ' + t); });
}
async function chooseWeek(frame, week) {
  await frame.$eval('#questionsArea', el => el.insertAdjacentHTML('beforeend', '<i id="vm-marker" hidden></i>'));
  await pick(frame, '#week_m', week);
  await frame.waitForFunction(() => { const a = document.querySelector('#questionsArea'); return a && !document.getElementById('vm-marker') && !/กำลัง/.test(a.textContent); }, null, { timeout: 45000 })
    .catch(() => { throw new Error(`โหลดคำถามของ "${week}" ไม่ขึ้น`); });
}
async function setupForm(page, formUrl, chapter) {
  const frame = await openForm(page, formUrl);
  await pick(frame, '#role', ROLE);
  await frame.waitForFunction(() => !document.querySelector('#chapterName').disabled, null, { timeout: 15000 });
  await pick(frame, '#chapterName', chapter);
  await waitMembers(frame);
  return frame;
}

async function fillOne(page, cfg, item, dryRun) {
  const frame = await setupForm(page, cfg.formUrl, cfg.chapter);
  await pick(frame, '#memberName_m', item.member_name);
  await pick(frame, '#mentorCoName', item.mentor_co);
  await pick(frame, '#personalMentorName', item.personal_mentor);
  await chooseWeek(frame, item.week);
  const info = await frame.evaluate(() => {
    const a = document.querySelector('#questionsArea');
    const b = document.querySelector('#submitBtn');
    return {
      yesno: new Set([...a.querySelectorAll('input[type=radio]')].map(r => r.name)).size,
      dates: a.querySelectorAll('input[type=date]').length,
      texts: a.querySelectorAll('input[type=text], textarea').length,
      area: a.textContent.replace(/\s+/g, ' ').trim().slice(0, 200),
      submitVisible: !!b && b.style.display !== 'none' && !b.disabled,
    };
  });
  if (!info.submitVisible) throw new Error('ฟอร์มเดิมไม่แสดงปุ่มส่ง: ' + info.area);
  if (info.texts > 0) throw new Error(`ช่วง "${item.week}" มีช่องข้อความที่บอทไม่รู้คำตอบ ต้องกรอกเองในฟอร์มเดิม`);
  if (info.dates > 0 && !item.start_date) throw new Error(`ช่วง "${item.week}" ต้องใส่วันที่เริ่มระบบพี่เลี้ยง ให้แอดมินเติมในรายชื่อสมาชิกใหม่`);
  await frame.$$eval('#questionsArea input[type=radio][value="Yes"]', els => els.forEach(e => { if (!e.checked) e.click(); }));
  for (const d of await frame.$$('#questionsArea input[type=date]')) await d.fill(item.start_date);
  const checked = await frame.$$eval('#questionsArea input[type=radio][value="Yes"]:checked', els => els.length);
  if (checked !== info.yesno) throw new Error(`ติ๊ก Yes ได้ ${checked} จาก ${info.yesno} ข้อ`);
  if (dryRun) return `ทดสอบผ่าน: กรอกครบ ${info.yesno} ข้อ${info.dates ? ' + วันที่' : ''} (ไม่ได้กดส่ง)`;

  const dialog = page.waitForEvent('dialog', { timeout: 90000 });
  await frame.click('#submitBtn');
  let msg;
  try { const d = await dialog; msg = d.message(); await d.accept().catch(() => {}); }
  catch { throw Object.assign(new Error('กดส่งแล้วฟอร์มเดิมไม่ตอบกลับ ไม่ทราบว่าบันทึกหรือยัง ตรวจในรายงานเดิมก่อนกดส่งใหม่'), { unknown: true }); }
  if (/ไม่สำเร็จ|กรุณา|ต้องตอบ|error/i.test(msg)) throw new Error('ฟอร์มเดิมแจ้ง: ' + msg);
  return msg || 'บันทึกสำเร็จ';
}

async function runQueue(browser, dryRun) {
  const cfg = await settings();
  let items;
  if (dryRun) {
    ({ data: items } = await db.from('mentor_queue').select('*').eq('status', 'pending').order('created_at'));
  } else {
    // จองรายการ (กันบอท 2 ตัวส่งซ้ำ)
    const { data, error } = await db.from('mentor_queue').update({ status: 'sending', message: null }).eq('status', 'pending').select('*');
    if (error) throw error; items = (data || []).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  items = items || [];
  console.log(`${dryRun ? 'ทดสอบ' : 'ส่ง'} ${items.length} รายการ`);
  let ok = 0, fail = 0;
  const { chromium } = await import('playwright');
  browser = browser || await chromium.launch();
  for (const item of items) {
    const page = await browser.newPage();
    page.on('dialog', d => { d.accept().catch(() => {}); });   // ปิดป๊อปอัปอื่น ๆ ที่ไม่คาดคิด
    try {
      const msg = await fillOne(page, cfg, item, dryRun);
      if (dryRun) await db.from('mentor_queue').update({ message: msg }).eq('id', item.id);
      else await db.from('mentor_queue').update({ status: 'sent', message: msg, sent_at: new Date().toISOString() }).eq('id', item.id);
      ok++; console.log('✓', item.member_name, item.week, msg);
    } catch (e) {
      fail++; console.log('✗', item.member_name, item.week, e.message);
      await page.screenshot({ path: `shots/${item.id}.png`, fullPage: true }).catch(() => {});
      if (dryRun) await db.from('mentor_queue').update({ message: 'ทดสอบไม่ผ่าน: ' + e.message }).eq('id', item.id);
      else await db.from('mentor_queue').update({ status: e.unknown ? 'sending' : 'failed', message: e.message }).eq('id', item.id);
    } finally { await page.close(); }
  }
  await browser.close();
  return `${dryRun ? 'ทดสอบ' : 'ส่ง'} ${items.length} รายการ · สำเร็จ ${ok} · ไม่สำเร็จ ${fail}`;
}

async function runSync() {
  const cfg = await settings();
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const frame = await setupForm(page, cfg.formUrl, cfg.chapter);
  const members = await optionLabels(frame, '#memberName_m');
  const weeks = await optionLabels(frame, '#week_m');
  await browser.close();
  if (weeks.length) await db.from('settings').upsert({ key: 'retention_weeks', value: weeks, updated_at: new Date().toISOString() });
  // เทียบชื่อในระบบกับชื่อในฟอร์มเดิม
  const { data: ours } = await db.from('members').select('full_name').eq('active', true);
  const norm = s => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
  const theirs = new Set(members.map(norm));
  const missing = (ours || []).map(m => m.full_name).filter(n => !theirs.has(norm(n)));
  return `อัปเดตช่วงสัปดาห์ ${weeks.length} ช่วง · ฟอร์มเดิมมี ${members.length} รายชื่อ` + (missing.length ? ` · ชื่อในระบบที่ไม่พบในฟอร์มเดิม: ${missing.join(', ')}` : '');
}

let summary = '';
try {
  if (MODE === 'ping') {
    const { count, error } = await db.from('mentor_queue').select('id', { count: 'exact', head: true }).eq('status', 'pending');
    if (error) throw error;
    console.log('ฐานข้อมูลตื่นอยู่ · คิวรอส่ง', count);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `pending=${count || 0}\n`);
  } else if (MODE === 'sync') summary = await runSync();
  else summary = await runQueue(null, MODE === 'dryrun');
  if (summary) { console.log(summary); await log(MODE, summary); }
} catch (e) {
  console.error(e);
  await log(MODE, 'ผิดพลาด: ' + (e.message || e));
  process.exitCode = 1;
}
